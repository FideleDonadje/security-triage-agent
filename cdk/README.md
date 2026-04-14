# cdk/

AWS CDK v2 infrastructure — deploys all three stacks.

## Stacks

| File | Stack | What it creates |
|---|---|---|
| `lib/security-triage-stack.ts` | `SecurityTriageStack` | Cognito, DynamoDB task table + ATO jobs table, API Lambda, Execution Lambda, ATO Trigger Lambda, ATO Worker Lambda, API Gateway, WAF, S3 buckets (access logs + ATO reports) |
| `lib/agent-stack.ts` | `SecurityTriageAgentStack` | Bedrock Agent, action group Lambda, IAM roles, SSM parameters, auto-prepare custom resource |
| `lib/frontend-stack.ts` | `SecurityTriageFrontendStack` | S3 bucket, CloudFront distribution |

## Deploy order

`SecurityTriageStack` must deploy before `SecurityTriageAgentStack` — the agent stack reads the DynamoDB table ARN from it.

```bash
# From repo root
bash ./deploy.sh --profile myprofile --region us-east-1 --owner you@example.com
```

## Key resources in SecurityTriageStack

| Resource | Name / ID | Notes |
|---|---|---|
| Cognito User Pool | `security-triage-analysts` | TOTP MFA, admin-provisioned accounts |
| DynamoDB — task queue | `security-triage-tasks` | GSI on `status` + `created_at` |
| DynamoDB — ATO jobs | `security-triage-ato-jobs` | GSI on `username` + `startTime`; 7-year TTL |
| API Lambda | `security-triage-api` | Handles chat, tasks, and `/ato/*` proxy |
| ATO Trigger Lambda | `security-triage-ato-trigger` | Creates jobs, polls status, lists standards and history |
| ATO Worker Lambda | `security-triage-ato-worker` | Security Hub → Bedrock → S3; triggered by DynamoDB stream |
| Execution Lambda | `security-triage-execution` | S3 logging + tag_resource; stream-triggered on APPROVED |
| S3 — access logs | `security-triage-access-logs-{account}-{region}` | Written by enable_s3_logging action |
| S3 — ATO reports | `security-triage-ato-reports-{account}-{region}` | JSON reports; Glacier after 1 year, deleted after 7 years |
| API Gateway | (REST API) | All routes require Cognito JWT |
| WAF | `security-triage-api-waf` | OWASP rules + 500 req/5 min rate limit |

## S3 lifecycle — ATO reports bucket

POA&M reports are compliance artifacts and must not be deleted after 90 days. The bucket lifecycle is:

- **Glacier transition** after 365 days (infrequent access once an audit cycle closes)
- **Hard expiration** after 7 years (2555 days) to match typical federal records retention

The DynamoDB ATO jobs table uses a matching 7-year TTL on each job record.

## Key exports

`deploy.sh` writes all stack outputs to `cdk-outputs.json` at repo root. The frontend `.env.local` is populated from those values.

All outputs are also written to SSM Parameter Store so `deploy-frontend.sh` can read config without parsing `cdk-outputs.json`.

## Changing the agent

After modifying `lib/agent-stack.ts` (system prompt, tools, IAM), bump `configVersion` in the `AgentPrepareResource` custom resource — this triggers a `PrepareAgent` call on the next deploy.
