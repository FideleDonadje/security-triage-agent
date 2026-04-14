#!/usr/bin/env node
/**
 * app.ts — CDK entry point: defines the three stacks and their deployment order
 *
 * Stack order and why it matters:
 *   1. FrontendStack  — deployed first so its CloudFront URL is available in SSM
 *   2. SecurityTriageStack — reads the CloudFront URL from CDK context (injected
 *      by deploy.sh after pass 1) to configure Cognito callback URLs and CORS.
 *      Using context rather than a cross-stack Fn::ImportValue keeps the stacks
 *      decoupled — FrontendStack can be updated independently.
 *   3. AgentStack — depends on SecurityTriageStack for the DynamoDB table ARN/name
 *
 * Deployment:
 *   Run ./deploy.sh for a full end-to-end deploy (infra + frontend).
 *   Run ./deploy-frontend.sh to redeploy only the React app (no CDK involved).
 *
 * Context values (passed via --context or cdk.json):
 *   frontendUrl       — CloudFront URL; injected by deploy.sh on pass 2
 *   cognitoDomainPrefix — Cognito hosted UI prefix (default: security-triage-ops)
 */
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

// 1. Frontend — standalone stack, no dependency on core resources.
//    Writes its outputs (CloudFront URL, bucket name, distribution ID) to SSM after deploy.
const frontendStack = new FrontendStack(app, 'SecurityTriageFrontendStack', {
  env,
  description: 'Security Triage Agent — React frontend on S3 + CloudFront',
});

// 2. Core stack — receives the CloudFront URL via CDK context, not a cross-stack reference.
//    Cross-stack Fn::ImportValue would couple the stacks: you couldn't update FrontendStack
//    without also touching SecurityTriageStack. Context keeps them independent.
//
//    First deploy (bootstrap): frontendUrl is undefined → Cognito gets localhost only.
//    Second deploy: pass --context frontendUrl=https://dXXXX.cloudfront.net → Cognito updated.
//    The bootstrap script (scripts/bootstrap.sh) handles both passes automatically.
const frontendUrl = app.node.tryGetContext('frontendUrl') as string | undefined;

const mainStack = new SecurityTriageStack(app, 'SecurityTriageStack', {
  env,
  description: 'Security Triage Agent — core resources (Cognito, DynamoDB, Lambdas, API GW, WAF)',
  frontendUrl,
  cognitoDomainPrefix: app.node.tryGetContext('cognitoDomainPrefix') as string | undefined,
});

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
