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

// Core stack: Cognito, DynamoDB, API GW, Lambdas, WAF
const mainStack = new SecurityTriageStack(app, 'SecurityTriageStack', {
  env,
  description: 'Security Triage Agent — core resources (Cognito, DynamoDB, Lambdas, API GW, WAF)',
});

// Agent: Bedrock Agent with 6 tools + action group Lambda
const agentStack = new AgentStack(app, 'SecurityTriageAgentStack', {
  env,
  description: 'Security Triage Agent — Bedrock Agent, action group Lambda, IAM',
  taskTableArn: mainStack.taskTable.tableArn,
  taskTableName: mainStack.taskTable.tableName,
  statusIndexName: 'status-index',
});
agentStack.addDependency(mainStack);

// Frontend: S3 + CloudFront
new FrontendStack(app, 'SecurityTriageFrontendStack', {
  env,
  description: 'Security Triage Agent — React frontend on S3 + CloudFront',
});

// ── Cost allocation + tracking tags on every resource ─────────────────────────
cdk.Tags.of(app).add('project',     'security-triage-agent');
cdk.Tags.of(app).add('environment', process.env.DEPLOY_ENV ?? 'dev');
cdk.Tags.of(app).add('owner',       process.env.OWNER_EMAIL ?? 'unknown');
cdk.Tags.of(app).add('managed-by',  'cdk');

app.synth();
