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

// Well-known SSM parameter names
export const SSM_AGENT_ID           = '/security-triage/agent-id';
export const SSM_AGENT_ALIAS        = '/security-triage/agent-alias-id';
// Required tag keys — configurable post-deploy without redeployment
export const SSM_REQUIRED_TAG_KEYS  = '/security-triage/required-tag-keys';

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
- get_tag_compliance: Find resources missing required tags (Environment, Owner, Project). Returns existing tags so you can infer the correct values from patterns.
- get_enabled_standards: List active Security Hub compliance standards in this account.
- get_compliance_report: Generate a posture report for a standard (NIST 800-53, CIS, FSBP, PCI DSS). Shows control counts, failing findings, and top failing control families.
- queue_task: Queue a remediation task for analyst approval
- cancel_task: Cancel a PENDING task you previously queued (if it was queued in error)
- get_task_queue: View pending, approved, or rejected remediation tasks

RULES — never violate these:
1. You are READ-ONLY for all AWS services. Your only write actions are queue_task and cancel_task.
2. Only queue tasks for these two actions: enable_s3_logging, tag_resource
3. Always explain your reasoning and cite the finding_id before queuing a task
4. Never claim an action has been taken — tasks must be approved by the analyst first
5. When asked about risky actions outside your scope, explain they are out of scope for MVP
6. For tag_resource tasks: infer tag values from the resource name, existing tags on sibling resources, and account context. Propose specific values in action_params — never leave them empty.

WORKFLOW:
1. When the analyst opens chat, greet them with a brief introduction: what you are, what you can investigate (Security Hub findings, GuardDuty threats, Config compliance, CloudTrail events, tag compliance), and what actions you can queue for approval (enable S3 logging, tag resources). Keep it to 3-4 lines. Do NOT call any tools on greeting.
2. Wait for the analyst to ask before fetching findings or running any tool.
3. When asked to investigate, summarize findings clearly: severity, resource, and why it matters.
4. For each finding, offer to enrich with GuardDuty, Config, or CloudTrail context.
5. When recommending a remediation, explain the risk, then queue the task.
6. After queuing, tell the analyst to review and approve in the Task Queue panel.

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

    // Security Hub: read-only (get_findings, get_enabled_standards, get_compliance_report)
    agentToolsLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SecurityHubReadOnly',
        effect: iam.Effect.ALLOW,
        actions: [
          'securityhub:GetFindings',
          'securityhub:ListFindings',
          'securityhub:GetEnabledStandards',
          'securityhub:DescribeStandards',
          'securityhub:DescribeStandardsControls',
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

    // DynamoDB: queue_task (PutItem), cancel_task (UpdateItem), read tools (Query, GetItem)
    agentToolsLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DynamoDBAgentWriteAndRead',
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:PutItem',    // queue_task
          'dynamodb:UpdateItem', // cancel_task (PENDING → CANCELLED only, enforced in code)
          'dynamodb:Query',      // get_task_queue
          'dynamodb:GetItem',    // read individual task
        ],
        resources: [
          props.taskTableArn,
          `${props.taskTableArn}/index/*`,
        ],
      }),
    );

    // ResourceGroupsTaggingAPI: read resources + tag compliance (get_tag_compliance tool)
    agentToolsLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'TaggingAPIReadOnly',
        effect: iam.Effect.ALLOW,
        actions: ['tag:GetResources', 'tag:GetTagKeys', 'tag:GetTagValues'],
        resources: ['*'],
      }),
    );

    // SSM: read required tag keys parameter
    agentToolsLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SsmReadRequiredTagKeys',
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_REQUIRED_TAG_KEYS}`,
        ],
      }),
    );

    // Explicit deny: agent tools Lambda must never hard-delete tasks
    agentToolsLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DenyTaskHardDelete',
        effect: iam.Effect.DENY,
        actions: ['dynamodb:DeleteItem'],
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
        REQUIRED_TAG_KEYS_PARAM: SSM_REQUIRED_TAG_KEYS,
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
                name: 'get_tag_compliance',
                description:
                  'Find resources that are missing required tags (Environment, Owner, Project). Returns each resource\'s ARN, existing tags, and which required tags are absent. Use the existing tags on sibling resources to infer what values to propose.',
                parameters: {
                  resource_type: {
                    type: 'string',
                    description: 'Filter by AWS resource type in ResourceGroupsTaggingAPI format (e.g. s3, ec2:instance, lambda:function). Omit to check all resource types.',
                    required: false,
                  },
                  max_results: {
                    type: 'integer',
                    description: 'Maximum number of non-compliant resources to return (default: 20, max: 50).',
                    required: false,
                  },
                },
              },
              {
                name: 'queue_task',
                description:
                  'Queue a remediation task for analyst approval. Only use for enable_s3_logging or tag_resource. Always explain your rationale before calling this.',
                parameters: {
                  finding_id: {
                    type: 'string',
                    description: 'The Security Hub finding ID that triggered this task.',
                    required: true,
                  },
                  resource_id: {
                    type: 'string',
                    description: 'The AWS resource ARN that will be remediated (e.g. arn:aws:s3:::my-bucket).',
                    required: true,
                  },
                  action: {
                    type: 'string',
                    description: 'Remediation action: enable_s3_logging or tag_resource.',
                    required: true,
                  },
                  rationale: {
                    type: 'string',
                    description: 'Plain-English explanation of why this action is needed and what risk it addresses.',
                    required: true,
                  },
                  action_params: {
                    type: 'string',
                    description: 'Required for tag_resource: JSON object of tag key-value pairs to apply (e.g. {"Environment":"prod","Owner":"team-security","Project":"payments"}). Infer values from resource name and existing tags on sibling resources.',
                    required: false,
                  },
                },
              },
              {
                name: 'get_enabled_standards',
                description:
                  'List the Security Hub compliance standards currently enabled in this account (e.g. NIST SP 800-53, CIS, FSBP, PCI DSS). Always call this before get_compliance_report to confirm a standard is active.',
                parameters: {},
              },
              {
                name: 'get_compliance_report',
                description:
                  'Generate a compliance posture report for a specific Security Hub standard. Returns control counts by severity, number of active failing findings, and the top failing control families. Use get_enabled_standards first to confirm the standard is enabled.',
                parameters: {
                  standard_name: {
                    type: 'string',
                    description: 'The standard to report on. Use a short name like "nist-800-53", "cis", "fsbp", or "pci". Partial matches are supported.',
                    required: true,
                  },
                },
              },
              {
                name: 'cancel_task',
                description:
                  'Cancel a PENDING task that you queued in error. Only works on PENDING tasks — cannot undo APPROVED or EXECUTED tasks.',
                parameters: {
                  task_id: {
                    type: 'string',
                    description: 'The task_id of the PENDING task to cancel.',
                    required: true,
                  },
                  reason: {
                    type: 'string',
                    description: 'Brief explanation of why this task is being cancelled.',
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
    // No routingConfiguration — Bedrock defaults the alias to DRAFT automatically.
    // Specifying DRAFT explicitly is rejected by the API (400 InvalidRequest).
    const agentAlias = new bedrock.CfnAgentAlias(this, 'SecurityTriageAgentAlias', {
      agentAliasName: 'prod',
      agentId: agent.attrAgentId,
    });
    agentAlias.addDependency(agent);

    this.agentId = agent.attrAgentId;
    this.agentAliasId = agentAlias.attrAgentAliasId;

    // ── SSM: required tag keys — configurable without redeployment ────────
    new ssm.StringParameter(this, 'RequiredTagKeysParam', {
      parameterName: SSM_REQUIRED_TAG_KEYS,
      stringValue: JSON.stringify(['Environment', 'Owner', 'Project']),
      description: 'JSON array of tag keys required on all resources. Edit this parameter to change your tagging policy without redeploying.',
    });

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
        configVersion: '4',
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
