import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

// Well-known SSM parameter names — read by the API Lambda at cold start
export const SSM_AGENT_ID    = '/security-triage/agent-id';
export const SSM_AGENT_ALIAS = '/security-triage/agent-alias-id';

export interface AgentStackProps extends cdk.StackProps {
  /** ARN of the DynamoDB task table from SecurityTriageStack */
  taskTableArn: string;
  /** Name of the DynamoDB task table */
  taskTableName: string;
  /** Name of the status GSI */
  statusIndexName: string;
}

// Claude Sonnet 4.5 via US cross-region inference profile.
const FOUNDATION_MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

const SYSTEM_PROMPT = `You are a security operations analyst assistant for an AWS environment.
Your role is to help analysts investigate and remediate Security Hub findings.

CAPABILITIES:
- get_findings: Retrieve active Security Hub findings, optionally filtered by severity
- get_threat_context: Look up GuardDuty threat findings for a specific resource
- get_config_status: Check AWS Config compliance status for a resource
- get_trail_events: Review recent CloudTrail API activity for a resource or event type
- queue_task: Queue a remediation task for analyst approval (your ONLY write action)
- get_task_queue: View pending, approved, or rejected remediation tasks

RULES — never violate these:
1. You are READ-ONLY for all AWS services. Your only write action is queue_task.
2. Only queue tasks for these two actions: enable_s3_logging, enable_s3_encryption
3. Always explain your reasoning and cite the finding_id before queuing a task
4. Never claim an action has been taken — tasks must be approved by the analyst first
5. When asked about risky actions outside your scope, explain they are out of scope for MVP

WORKFLOW:
1. When the analyst opens chat, proactively fetch Critical and High findings
2. Summarize the most critical finding first, with resource ARN and why it matters
3. For each finding, offer to enrich with GuardDuty, Config, or CloudTrail context
4. When recommending a remediation, explain the risk, then queue the task
5. After queuing, tell the analyst to review and approve in the Task Queue panel

COMMUNICATION STYLE:
- Be concise and action-oriented — this is a security operations context
- Lead with severity and impact, not process
- Use plain English, not raw JSON (summarize tool results)
- When unsure, prefer asking for clarification over guessing`;

/**
 * AgentStack — Bedrock Agent with 6 tools, action group Lambda, and IAM wiring.
 *
 * ARCHITECTURE RULE: The agent role has ZERO write permissions to AWS services.
 * Its only write action is DynamoDB PutItem (queue_task tool).
 */
export class AgentStack extends cdk.Stack {
  public readonly agentRole: iam.Role;
  public readonly agentId: string;
  public readonly agentAliasId: string;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    // ── Agent audit trail — 90-day retention ──────────────────────────────
    const agentLogGroup = new logs.LogGroup(this, 'AgentCoreLogs', {
      logGroupName: '/security-triage/agentcore',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Action group Lambda log group (pre-created for retention control)
    const agentToolsLogGroup = new logs.LogGroup(this, 'AgentToolsLogs', {
      logGroupName: '/aws/lambda/security-triage-agent-tools',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Bedrock Agent Service Role ─────────────────────────────────────────
    // Trusted by Bedrock to invoke the foundation model and invoke the action group Lambda.
    this.agentRole = new iam.Role(this, 'AgentCoreRole', {
      roleName: 'security-triage-agentcore',
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description:
        'Bedrock Agent service role - invokes foundation model and action group Lambda',
    });

    // Bedrock: invoke the foundation model
    this.agentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockInvokeModel',
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:GetInferenceProfile',
        ],
        resources: [
          // Cross-region inference profile (account-scoped)
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0`,
          // Foundation model in each US region (cross-region routing)
          `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
          `arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
          `arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
        ],
      }),
    );

    // CloudWatch: write to agent audit log group only
    this.agentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchAgentAuditLogs',
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: [
          agentLogGroup.logGroupArn,
          `${agentLogGroup.logGroupArn}:*`,
        ],
      }),
    );

    // ── Action Group Lambda IAM Role ───────────────────────────────────────
    // Separate from the Bedrock agent role: this role is assumed by the Lambda
    // that executes the agent tools. Read-only AWS + DynamoDB write for queue_task.
    const agentToolsLambdaRole = new iam.Role(this, 'AgentToolsLambdaRole', {
      roleName: 'security-triage-agent-tools-lambda',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description:
        'Action group Lambda - read-only AWS services + DynamoDB PutItem for queue_task',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Security Hub: read-only (get_findings)
    agentToolsLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SecurityHubReadOnly',
        effect: iam.Effect.ALLOW,
        actions: [
          'securityhub:GetFindings',
          'securityhub:ListFindings',
        ],
        resources: ['*'],
      }),
    );

    // GuardDuty: read-only (get_threat_context)
    agentToolsLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'GuardDutyReadOnly',
        effect: iam.Effect.ALLOW,
        actions: [
          'guardduty:ListDetectors',
          'guardduty:ListFindings',
          'guardduty:GetFindings',
        ],
        resources: ['*'],
      }),
    );

    // Config: read-only (get_config_status)
    agentToolsLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ConfigReadOnly',
        effect: iam.Effect.ALLOW,
        actions: [
          'config:DescribeComplianceByResource',
          'config:GetComplianceDetailsByResource',
        ],
        resources: ['*'],
      }),
    );

    // CloudTrail: read-only (get_trail_events)
    agentToolsLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudTrailReadOnly',
        effect: iam.Effect.ALLOW,
        actions: ['cloudtrail:LookupEvents'],
        resources: ['*'],
      }),
    );

    // DynamoDB: queue_task (PutItem) + get_task_queue (Query) — agent's ONLY write
    agentToolsLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DynamoDBQueueTaskOnly',
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:PutItem',   // queue_task
          'dynamodb:Query',     // get_task_queue
          'dynamodb:GetItem',   // read individual task
        ],
        resources: [
          props.taskTableArn,
          `${props.taskTableArn}/index/*`,
        ],
      }),
    );

    // Explicit deny: agent tools Lambda must never mutate task status
    agentToolsLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DenyTaskStatusMutation',
        effect: iam.Effect.DENY,
        actions: ['dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
        resources: [props.taskTableArn],
      }),
    );

    // ── Action Group Lambda ────────────────────────────────────────────────
    const agentToolsLambda = new lambdaNode.NodejsFunction(this, 'AgentToolsLambda', {
      functionName: 'security-triage-agent-tools',
      description: 'Bedrock Agent action group: executes the 6 agent tools (get_findings, get_threat_context, get_config_status, get_trail_events, queue_task, get_task_queue). Read-only except DynamoDB PutItem.',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../lambda/agent-tools/index.ts'),
      handler: 'handler',
      role: agentToolsLambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      logGroup: agentToolsLogGroup,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],
      },
      environment: {
        TABLE_NAME: props.taskTableName,
        STATUS_INDEX_NAME: props.statusIndexName,
        REGION: this.region,
      },
    });

    // Allow Bedrock to invoke the action group Lambda
    agentToolsLambda.addPermission('BedrockInvokePermission', {
      principal: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceAccount: this.account,
    });

    // ── Bedrock Agent ──────────────────────────────────────────────────────
    const agent = new bedrock.CfnAgent(this, 'SecurityTriageAgent', {
      agentName: 'security-triage-agent',
      agentResourceRoleArn: this.agentRole.roleArn,
      foundationModel: FOUNDATION_MODEL,
      instruction: SYSTEM_PROMPT,
      idleSessionTtlInSeconds: 1800, // 30 minutes
      actionGroups: [
        {
          actionGroupName: 'security-triage-tools',
          actionGroupExecutor: {
            lambda: agentToolsLambda.functionArn,
          },
          functionSchema: {
            functions: [
              {
                name: 'get_findings',
                description:
                  'Retrieve active Security Hub findings. Call this when the analyst asks about security findings, alerts, or vulnerabilities.',
                parameters: {
                  severity: {
                    type: 'string',
                    description: 'Filter by severity: CRITICAL, HIGH, MEDIUM, or LOW. Omit to return findings across all severities.',
                    required: false,
                  },
                  max_results: {
                    type: 'integer',
                    description: 'Maximum number of findings to return (default: 10, max: 50).',
                    required: false,
                  },
                },
              },
              {
                name: 'get_threat_context',
                description:
                  'Retrieve GuardDuty threat findings. Use to enrich a Security Hub finding with threat intelligence for a specific resource.',
                parameters: {
                  resource_id: {
                    type: 'string',
                    description: 'Resource ID or ARN to filter GuardDuty findings (e.g. EC2 instance ID, S3 bucket ARN). Omit to get all recent findings.',
                    required: false,
                  },
                },
              },
              {
                name: 'get_config_status',
                description:
                  'Check AWS Config compliance status for a resource. Use to verify whether a resource meets compliance rules.',
                parameters: {
                  resource_id: {
                    type: 'string',
                    description: 'The resource ID or ARN to check compliance for (e.g. S3 bucket name, security group ID).',
                    required: true,
                  },
                  resource_type: {
                    type: 'string',
                    description: 'AWS resource type in Config format (e.g. AWS::S3::Bucket, AWS::EC2::SecurityGroup). Optional - narrows results.',
                    required: false,
                  },
                },
              },
              {
                name: 'get_trail_events',
                description:
                  'Look up recent CloudTrail API events for a resource or event type. Use to investigate recent changes or suspicious activity.',
                parameters: {
                  resource_name: {
                    type: 'string',
                    description: 'Resource name or ARN to filter events (e.g. S3 bucket name, IAM role name).',
                    required: false,
                  },
                  event_name: {
                    type: 'string',
                    description: 'API event name to filter on (e.g. PutBucketLogging, DeleteBucket, AssumeRole).',
                    required: false,
                  },
                  start_time: {
                    type: 'string',
                    description: 'ISO 8601 start time for the event search (e.g. 2024-01-15T00:00:00Z). Defaults to 24 hours ago.',
                    required: false,
                  },
                },
              },
              {
                name: 'queue_task',
                description:
                  'Queue a remediation task for analyst approval. Only use for enable_s3_logging or enable_s3_encryption. Always explain your rationale before calling this.',
                parameters: {
                  finding_id: {
                    type: 'string',
                    description: 'The Security Hub finding ID that triggered this task.',
                    required: true,
                  },
                  resource_id: {
                    type: 'string',
                    description: 'The AWS resource ARN or ID that will be remediated (e.g. arn:aws:s3:::my-bucket).',
                    required: true,
                  },
                  action: {
                    type: 'string',
                    description: 'Remediation action: enable_s3_logging or enable_s3_encryption.',
                    required: true,
                  },
                  rationale: {
                    type: 'string',
                    description: 'Plain-English explanation of why this action is needed and what risk it addresses.',
                    required: true,
                  },
                },
              },
              {
                name: 'get_task_queue',
                description:
                  'View remediation tasks in the queue. Use when the analyst asks what tasks are pending, approved, or completed.',
                parameters: {
                  status: {
                    type: 'string',
                    description: 'Filter by task status: PENDING, APPROVED, REJECTED, EXECUTED, or FAILED. Defaults to PENDING.',
                    required: false,
                  },
                },
              },
            ],
          },
        },
      ],
    });

    // ── Bedrock Agent Alias (prod) → DRAFT ────────────────────────────────
    // Pointing to DRAFT means the alias always reflects the latest PrepareAgent
    // result — no manual version creation or alias updates needed on redeploy.
    const agentAlias = new bedrock.CfnAgentAlias(this, 'SecurityTriageAgentAlias', {
      agentAliasName: 'prod',
      agentId: agent.attrAgentId,
      routingConfiguration: [{ agentVersion: 'DRAFT' }],
    });
    agentAlias.addDependency(agent);

    this.agentId = agent.attrAgentId;
    this.agentAliasId = agentAlias.attrAgentAliasId;

    // ── SSM Parameters — API Lambda reads these at cold start ──────────────
    // Avoids circular stack dependency: SecurityTriageStack deploys first,
    // then AgentStack writes the IDs here, and the Lambda picks them up at runtime.
    new ssm.StringParameter(this, 'AgentIdParam', {
      parameterName: SSM_AGENT_ID,
      stringValue: agent.attrAgentId,
      description: 'Bedrock Agent ID for the security-triage-agent',
    });

    new ssm.StringParameter(this, 'AgentAliasIdParam', {
      parameterName: SSM_AGENT_ALIAS,
      stringValue: agentAlias.attrAgentAliasId,
      description: 'Bedrock Agent prod alias ID for the security-triage-agent',
    });

    // ── Auto-prepare: prepare agent + create version + update alias on deploy ──
    const agentPrepareRole = new iam.Role(this, 'AgentPrepareRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    agentPrepareRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:PrepareAgent', 'bedrock:GetAgent'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:agent/${agent.attrAgentId}`,
      ],
    }));

    const agentPrepareLambda = new lambdaNode.NodejsFunction(this, 'AgentPrepareLambda', {
      functionName: 'security-triage-agent-prepare',
      entry: path.join(__dirname, '../../lambda/agent-prepare/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: agentPrepareRole,
      timeout: cdk.Duration.minutes(10),
      bundling: { minify: true, sourceMap: false, externalModules: [] },
    });

    const agentPrepareProvider = new cr.Provider(this, 'AgentPrepareProvider', {
      onEventHandler: agentPrepareLambda,
    });

    // Changing foundationModel or configVersion triggers a re-run on deploy.
    // Bump configVersion manually when you change the instruction or action groups.
    new cdk.CustomResource(this, 'AgentPrepareResource', {
      serviceToken: agentPrepareProvider.serviceToken,
      properties: {
        agentId: agent.attrAgentId,
        foundationModel: FOUNDATION_MODEL,
        configVersion: '1',
      },
    });

    // ── CDK Outputs ────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AgentId', {
      value: agent.attrAgentId,
      description: 'Bedrock Agent ID - set as AGENT_ID env var on API Lambda',
      exportName: 'SecurityTriageAgentId',
    });

    new cdk.CfnOutput(this, 'AgentAliasId', {
      value: agentAlias.attrAgentAliasId,
      description: 'Bedrock Agent Alias ID (prod) - set as AGENT_ALIAS_ID env var on API Lambda',
      exportName: 'SecurityTriageAgentAliasId',
    });

    new cdk.CfnOutput(this, 'AgentRoleArn', {
      value: this.agentRole.roleArn,
      description: 'IAM role ARN for the Bedrock Agent',
      exportName: 'SecurityTriageAgentRoleArn',
    });

    new cdk.CfnOutput(this, 'AgentLogGroupName', {
      value: agentLogGroup.logGroupName,
      description: 'CloudWatch log group for AgentCore audit trail',
      exportName: 'SecurityTriageAgentLogGroupName',
    });
  }
}
