#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SecurityTriageStack } from '../lib/security-triage-stack';
import { AgentStack } from '../lib/agent-stack';
import { FrontendStack } from '../lib/frontend-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// 1. Frontend first — we need the CloudFront URL to wire into Cognito + CORS
const frontendStack = new FrontendStack(app, 'SecurityTriageFrontendStack', {
  env,
  description: 'Security Triage Agent — React frontend on S3 + CloudFront',
});

const frontendUrl = `https://${frontendStack.distribution.distributionDomainName}`;

// 2. Core stack — receives the CloudFront URL for Cognito callback URLs + CORS
// Override Cognito prefix at deploy time: cdk deploy -c cognitoDomainPrefix=my-prefix
const mainStack = new SecurityTriageStack(app, 'SecurityTriageStack', {
  env,
  description: 'Security Triage Agent — core resources (Cognito, DynamoDB, Lambdas, API GW, WAF)',
  frontendUrl,
  cognitoDomainPrefix: app.node.tryGetContext('cognitoDomainPrefix') as string | undefined,
});
mainStack.addDependency(frontendStack);

// 3. Agent — Bedrock Agent writes its IDs to SSM; API Lambda reads them at cold start
const agentStack = new AgentStack(app, 'SecurityTriageAgentStack', {
  env,
  description: 'Security Triage Agent — Bedrock Agent, action group Lambda, IAM',
  taskTableArn: mainStack.taskTable.tableArn,
  taskTableName: mainStack.taskTable.tableName,
  statusIndexName: 'status-index',
});
agentStack.addDependency(mainStack);

// ── Cost allocation + tracking tags on every resource ─────────────────────────
cdk.Tags.of(app).add('project',     'security-triage-agent');
cdk.Tags.of(app).add('environment', process.env.DEPLOY_ENV ?? 'dev');
cdk.Tags.of(app).add('owner',       process.env.OWNER_EMAIL ?? 'unknown');
cdk.Tags.of(app).add('managed-by',  'cdk');

app.synth();
