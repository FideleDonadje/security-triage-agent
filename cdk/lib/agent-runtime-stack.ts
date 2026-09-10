/**
 * agent-runtime-stack.ts — Strands agent on AgentCore Runtime (migration Phase 0/1)
 *
 * Replaces the Classic Bedrock Agent in agent-stack.ts. Full plan:
 * docs/agent-migration-plan.md.
 *
 * Phase 0 (this file): stand up the Runtime from a container asset, prove the
 *   path, deploy + invoke + destroy. Opt-in — instantiated only when
 *   `-c deployAgentRuntime=true`.
 *
 * NOTE ON CONSTRUCT LEVEL: this uses the L1 `CfnRuntime` because the locked
 *   aws-cdk-lib (2.248) ships only L1 for aws-bedrockagentcore. The L2 `Runtime`
 *   construct (with `AgentRuntimeArtifact.fromAsset`) needs aws-cdk-lib ~2.256+;
 *   bumping it is a tracked Phase 1 task — see the migration plan ("CDK bump
 *   blast radius"). L1 is functionally complete for the spike.
 *
 * ARCHITECTURE RULE (unchanged): the agent identity has ZERO write access to AWS
 * security services. This role can InvokeModel, pull its own image, and invoke
 * the agent-tools Lambda (which keeps its own restricted role) — nothing else.
 */
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export const SSM_AGENT_RUNTIME_ARN = '/security-triage/agent-runtime-arn';

const MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const AGENT_TOOLS_FUNCTION_NAME = 'security-triage-agent-tools';

export interface AgentRuntimeStackProps extends cdk.StackProps {
  /** ARN of the agent-tools Lambda (from AgentStack) that the runtime proxies to. */
  agentToolsFunctionArn: string;
}

export class AgentRuntimeStack extends cdk.Stack {
  public readonly runtimeArn: string;

  constructor(scope: Construct, id: string, props: AgentRuntimeStackProps) {
    super(scope, id, props);

    // ── Container image — built from lambda/agent (needs Docker at deploy) ────
    const image = new ecrAssets.DockerImageAsset(this, 'AgentImage', {
      directory: path.join(__dirname, '../../lambda/agent'),
      platform: ecrAssets.Platform.LINUX_ARM64, // AgentCore Runtime requirement
    });

    // ── Runtime audit log group ──────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'AgentRuntimeLogs', {
      logGroupName: '/security-triage/agent-runtime',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Runtime execution role ───────────────────────────────────────────────
    const executionRole = new iam.Role(this, 'AgentRuntimeRole', {
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
    const executionPolicy = new iam.Policy(this, 'AgentRuntimePolicy', {
      roles: [executionRole],
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
          resources: [props.agentToolsFunctionArn],
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
          actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'],
          resources: [image.repository.repositoryArn],
        }),
        // CloudWatch: write to the runtime audit log group only
        new iam.PolicyStatement({
          sid: 'CloudWatchLogs',
          effect: iam.Effect.ALLOW,
          actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
          resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`],
        }),
      ],
    });

    // ── AgentCore Runtime (L1) ───────────────────────────────────────────────
    const runtime = new agentcore.CfnRuntime(this, 'TriageAgentRuntime', {
      agentRuntimeName: 'security_triage_agent',
      roleArn: executionRole.roleArn,
      description: 'Strands Triage Agent (migration from Classic Bedrock Agents)',
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: image.imageUri },
      },
      environmentVariables: {
        BEDROCK_MODEL_ID: MODEL_ID,
        BEDROCK_REGION: this.region,
        AGENT_TOOLS_FUNCTION_NAME,
      },
    });

    // The Runtime must not be created until the execution role can actually pull
    // the image and call Bedrock — see the comment on executionPolicy above.
    runtime.node.addDependency(executionPolicy);

    const endpoint = new agentcore.CfnRuntimeEndpoint(this, 'TriageAgentRuntimeEndpoint', {
      agentRuntimeId: runtime.attrAgentRuntimeId,
      name: 'prod',
    });
    endpoint.addDependency(runtime);

    this.runtimeArn = runtime.attrAgentRuntimeArn;

    // ── SSM: API Lambda reads this at cold start (replaces agent-id/alias-id) ─
    new ssm.StringParameter(this, 'AgentRuntimeArnParam', {
      parameterName: SSM_AGENT_RUNTIME_ARN,
      stringValue: runtime.attrAgentRuntimeArn,
      description: 'AgentCore Runtime ARN for the security-triage Strands agent',
    });

    new cdk.CfnOutput(this, 'AgentRuntimeArn', {
      value: runtime.attrAgentRuntimeArn,
      description: 'AgentCore Runtime ARN',
    });
    new cdk.CfnOutput(this, 'AgentRuntimeEndpointArn', {
      value: endpoint.attrAgentRuntimeEndpointArn,
      description: 'AgentCore Runtime prod endpoint ARN',
    });
  }
}
