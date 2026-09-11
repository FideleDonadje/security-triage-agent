/**
 * agent-stack.ts — Strands agent on AgentCore Runtime + the agent-tools Lambda
 *
 * Deploys the AI agent that analysts chat with. Since 2026-09 this is a Strands
 * Agents SDK (TypeScript) app running on Amazon Bedrock AgentCore Runtime — it
 * replaced the classic Bedrock Agent (CfnAgent + action groups), which entered
 * maintenance mode on 2026-07-30. See docs/agent-migration-plan.md.
 *
 * Responsibilities:
 *   - Builds the Strands agent container (agent/) and runs it on AgentCore
 *     Runtime. The agent's system prompt and 13 tool definitions live in the
 *     container (agent/src/), not here.
 *   - Deploys the agent-tools Lambda (security-triage-agent-tools) that executes
 *     every tool: get_findings, get_threat_context, get_config_status,
 *     get_trail_events, get_tag_compliance, get_enabled_standards,
 *     get_compliance_report, get_iam_analysis, get_access_analyzer,
 *     get_cost_analysis, queue_task, cancel_task, get_task_queue.
 *   - Wires IAM: the Runtime execution role can InvokeModel + pull its image +
 *     invoke the agent-tools Lambda, nothing else. The agent-tools Lambda keeps
 *     its own restricted role (read-only AWS + DynamoDB PutItem/UpdateItem).
 *   - Writes the Runtime ARN to SSM so the API Lambda can reach it without a
 *     hard cross-stack CloudFormation dependency.
 *
 * ARCHITECTURE RULE: neither the Runtime execution role nor the agent-tools
 * Lambda has any write access to AWS services. Their only writes are DynamoDB
 * PutItem (queue_task) and UpdateItem (cancel_task). All real remediation
 * happens in the Execution Lambda (security-triage-stack.ts).
 *
 * SSM outputs (read by API Lambda at cold start):
 *   /security-triage/agent-runtime-arn  — AgentCore Runtime ARN
 *   /security-triage/required-tag-keys  — JSON array, editable without redeployment
 */

import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { STANDARD_BUNDLING, createLogGroup } from './lambda-defaults';

// Well-known SSM parameter names
export const SSM_AGENT_RUNTIME_ARN  = '/security-triage/agent-runtime-arn';
// Required tag keys — configurable post-deploy without redeployment
export const SSM_REQUIRED_TAG_KEYS  = '/security-triage/required-tag-keys';

// Claude Sonnet 4.5 via US cross-region inference profile.
const MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const AGENT_TOOLS_FUNCTION_NAME = 'security-triage-agent-tools';

export interface AgentStackProps extends cdk.StackProps {
  /** ARN of the DynamoDB task table from SecurityTriageStack */
  taskTableArn: string;
  /** Name of the DynamoDB task table */
  taskTableName: string;
  /** Name of the status GSI */
  statusIndexName: string;
}

/**
 * AgentStack — Strands agent on AgentCore Runtime + the agent-tools Lambda.
 *
 * ARCHITECTURE RULE: The agent identity has ZERO write permissions to AWS
 * services. Its only writes are DynamoDB PutItem / UpdateItem via agent-tools.
 */
export class AgentStack extends cdk.Stack {
  public readonly runtimeArn: string;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    // ── Log groups — 90-day retention ────────────────────────────────────────
    const runtimeLogGroup = createLogGroup(this, 'AgentRuntimeLogs', '/security-triage/agent-runtime');
    const agentToolsLogGroup = createLogGroup(
      this, 'AgentToolsLogs', '/aws/lambda/security-triage-agent-tools',
    );

    // ── Action Group Lambda IAM Role ───────────────────────────────────────
    // Assumed by the Lambda that executes the agent tools. Read-only AWS +
    // DynamoDB write for queue_task / cancel_task. Unchanged by the migration.
    const agentToolsLambdaRole = new iam.Role(this, 'AgentToolsLambdaRole', {
      roleName: 'security-triage-agent-tools-lambda',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description:
        'Agent tools Lambda - read-only AWS services + DynamoDB PutItem for queue_task',
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

    // Cost Explorer: read-only (get_cost_analysis tool)
    // Cost Explorer is a global service — IAM resource must be '*'
    agentToolsLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CostExplorerReadOnly',
        effect: iam.Effect.ALLOW,
        actions: [
          'ce:GetCostAndUsage',
          'ce:GetAnomalies',
          'ce:GetAnomalyMonitors',
          'ce:GetDimensionValues',
          'ce:GetTags',
        ],
        resources: ['*'],
      }),
    );

    // IAM: read-only (get_iam_analysis tool)
    agentToolsLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'IamReadOnly',
        effect: iam.Effect.ALLOW,
        actions: [
          'iam:GetAccountSummary',
          'iam:GenerateCredentialReport',
          'iam:GetCredentialReport',
          'iam:ListUsers',
          'iam:ListAttachedUserPolicies',
        ],
        resources: ['*'],
      }),
    );

    // Access Analyzer: read-only (get_access_analyzer tool)
    agentToolsLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AccessAnalyzerReadOnly',
        effect: iam.Effect.ALLOW,
        actions: [
          'access-analyzer:ListAnalyzers',
          'access-analyzer:ListFindings',
        ],
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

    // ── Agent Tools Lambda ─────────────────────────────────────────────────
    // Invoked by the Strands agent (running on AgentCore Runtime) with a
    // { tool, input } payload; also still accepts the classic Bedrock
    // action-group event shape (kept until the classic agent is fully gone).
    const agentToolsLambda = new lambdaNode.NodejsFunction(this, 'AgentToolsLambda', {
      functionName: AGENT_TOOLS_FUNCTION_NAME,
      description:
        'Agent tools executor: runs all 13 triage tools (get_findings, get_threat_context, ' +
        'queue_task, cancel_task, ...). Read-only except DynamoDB PutItem/UpdateItem.',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '../../lambda/agent-tools/index.ts'),
      handler: 'handler',
      role: agentToolsLambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      logGroup: agentToolsLogGroup,
      bundling: STANDARD_BUNDLING,
      environment: {
        TABLE_NAME: props.taskTableName,
        STATUS_INDEX_NAME: props.statusIndexName,
        REGION: this.region,
        REQUIRED_TAG_KEYS_PARAM: SSM_REQUIRED_TAG_KEYS,
      },
    });

    (agentToolsLambda.node.defaultChild as lambda.CfnFunction).addMetadata('checkov', {
      skip: [
        { id: 'CKV_AWS_117', comment: 'Lambda VPC placement not required for dev tier' },
        { id: 'CKV_AWS_116', comment: 'DLQ not required for dev tier' },
        { id: 'CKV_AWS_115', comment: 'Reserved concurrency not required for dev tier' },
        { id: 'CKV_AWS_173', comment: 'Secrets in Secrets Manager not env vars' },
      ],
    });

    // ── Strands agent container image (built for linux/arm64) ────────────────
    const agentImage = new ecrAssets.DockerImageAsset(this, 'AgentImage', {
      directory: path.join(__dirname, '../../agent'),
      platform: ecrAssets.Platform.LINUX_ARM64, // AgentCore Runtime requirement
    });

    // ── AgentCore Runtime execution role ────────────────────────────────────
    const runtimeRole = new iam.Role(this, 'AgentRuntimeRole', {
      roleName: 'security-triage-agent-runtime',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: {
            'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*`,
          },
        },
      }),
      description:
        'AgentCore Runtime execution role - InvokeModel + pull image + invoke agent-tools Lambda only',
    });

    // All permissions in ONE explicit policy so the Runtime can depend on it.
    // AgentCore validates the execution role can pull the ECR image at Runtime
    // create time — if the role's inline policy is still attaching in parallel,
    // creation fails with "Access denied while validating ECR URI".
    const runtimePolicy = new iam.Policy(this, 'AgentRuntimePolicy', {
      roles: [runtimeRole],
      statements: [
        // Bedrock: invoke the foundation model (inference profile + FM ARNs)
        new iam.PolicyStatement({
          sid: 'BedrockInvokeModel',
          effect: iam.Effect.ALLOW,
          actions: [
            'bedrock:InvokeModel',
            'bedrock:InvokeModelWithResponseStream',
            'bedrock:GetInferenceProfile',
          ],
          resources: [
            `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${MODEL_ID}`,
            'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
            'arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
            'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
          ],
        }),
        // Lambda: invoke the agent-tools Lambda (which holds its own restricted role)
        new iam.PolicyStatement({
          sid: 'InvokeAgentToolsLambda',
          effect: iam.Effect.ALLOW,
          actions: ['lambda:InvokeFunction'],
          resources: [agentToolsLambda.functionArn],
        }),
        // ECR: pull the agent's own container image
        new iam.PolicyStatement({
          sid: 'EcrAuth',
          effect: iam.Effect.ALLOW,
          actions: ['ecr:GetAuthorizationToken'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'EcrPullImage',
          effect: iam.Effect.ALLOW,
          actions: [
            'ecr:BatchGetImage',
            'ecr:GetDownloadUrlForLayer',
            'ecr:BatchCheckLayerAvailability',
          ],
          resources: [agentImage.repository.repositoryArn],
        }),
        // CloudWatch: write to the runtime audit log group only
        new iam.PolicyStatement({
          sid: 'CloudWatchLogs',
          effect: iam.Effect.ALLOW,
          actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
          resources: [runtimeLogGroup.logGroupArn, `${runtimeLogGroup.logGroupArn}:*`],
        }),
      ],
    });

    // ── AgentCore Runtime (L1 — aws-cdk-lib 2.248 ships L1 only) ─────────────
    const runtime = new agentcore.CfnRuntime(this, 'TriageAgentRuntime', {
      agentRuntimeName: 'security_triage_agent',
      roleArn: runtimeRole.roleArn,
      description: 'Strands Triage Agent on AgentCore Runtime',
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: agentImage.imageUri },
      },
      environmentVariables: {
        BEDROCK_MODEL_ID: MODEL_ID,
        BEDROCK_REGION: this.region,
        AGENT_TOOLS_FUNCTION_NAME,
      },
    });
    runtime.node.addDependency(runtimePolicy);

    const runtimeEndpoint = new agentcore.CfnRuntimeEndpoint(this, 'TriageAgentRuntimeEndpoint', {
      agentRuntimeId: runtime.attrAgentRuntimeId,
      name: 'prod',
    });
    runtimeEndpoint.addDependency(runtime);

    this.runtimeArn = runtime.attrAgentRuntimeArn;

    // ── SSM: required tag keys — configurable without redeployment ──────────
    new ssm.StringParameter(this, 'RequiredTagKeysParam', {
      parameterName: SSM_REQUIRED_TAG_KEYS,
      stringValue: JSON.stringify(['Environment', 'Owner', 'Project']),
      description:
        'JSON array of tag keys required on all resources. Edit this parameter to change your ' +
        'tagging policy without redeploying.',
    });

    // ── SSM: Runtime ARN — API Lambda reads this at cold start ──────────────
    // Avoids a circular stack dependency: SecurityTriageStack deploys first,
    // then AgentStack writes the ARN here, and the Lambda picks it up at runtime.
    new ssm.StringParameter(this, 'AgentRuntimeArnParam', {
      parameterName: SSM_AGENT_RUNTIME_ARN,
      stringValue: runtime.attrAgentRuntimeArn,
      description: 'AgentCore Runtime ARN for the security-triage Strands agent',
    });

    // ── CDK Outputs ────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AgentRuntimeArn', {
      value: runtime.attrAgentRuntimeArn,
      description: 'AgentCore Runtime ARN - written to SSM for the API Lambda',
      exportName: 'SecurityTriageAgentRuntimeArn',
    });

    new cdk.CfnOutput(this, 'AgentRuntimeEndpointArn', {
      value: runtimeEndpoint.attrAgentRuntimeEndpointArn,
      description: 'AgentCore Runtime prod endpoint ARN',
      exportName: 'SecurityTriageAgentRuntimeEndpointArn',
    });

    new cdk.CfnOutput(this, 'AgentRuntimeRoleArn', {
      value: runtimeRole.roleArn,
      description: 'IAM role ARN for the AgentCore Runtime',
      exportName: 'SecurityTriageAgentRuntimeRoleArn',
    });

    new cdk.CfnOutput(this, 'AgentLogGroupName', {
      value: runtimeLogGroup.logGroupName,
      description: 'CloudWatch log group for the AgentCore Runtime audit trail',
      exportName: 'SecurityTriageAgentLogGroupName',
    });
  }
}
