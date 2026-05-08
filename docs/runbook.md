# Security Triage Agent — Operational Runbook

This runbook covers day-to-day operations, extension patterns, and troubleshooting for the AWS deployment of the Security Triage Agent.

---

## Table of Contents

1. [Deployed Resources](#1-deployed-resources)
2. [Configuration Reference](#2-configuration-reference)
3. [How to Deploy](#3-how-to-deploy)
4. [How Each Flow Works in AWS](#4-how-each-flow-works-in-aws)
5. [How to Add a New Agent Tool](#5-how-to-add-a-new-agent-tool)
6. [How to Add a New Compliance Document Type](#6-how-to-add-a-new-compliance-document-type)
7. [How to Add a New Execution Action](#7-how-to-add-a-new-execution-action)
8. [Where to Find Things](#8-where-to-find-things)
9. [Monitoring](#9-monitoring)
10. [Troubleshooting](#10-troubleshooting)
11. [AWS Quotas & Limits](#11-aws-quotas--limits)

---

## 1. Deployed Resources

### Lambda Functions

| Function name | Role | Timeout | Memory |
| --- | --- | --- | --- |
| `security-triage-api` | API layer — all browser requests | 29s | 512 MB |
| `security-triage-execution` | Executes approved remediation tasks | 5 min | 256 MB |
| `security-triage-compliance-worker` | Generates compliance documents via Bedrock | 15 min | 1024 MB |
| `security-triage-compliance-repair` | Marks stuck jobs FAILED; redrives DLQ | 60s | 256 MB |
| `security-triage-ato-trigger` | Handles ATO job creation and status polling | 29s | 256 MB |
| `security-triage-ato-worker` | Generates ATO report via Bedrock | 15 min | 512 MB |

### DynamoDB Tables

| Table | Purpose | Key schema |
| --- | --- | --- |
| `security-triage-tasks` | Triage task queue | PK: `task_id` |
| `security-triage-ato-jobs` | ATO job lifecycle | PK: `jobId` |
| `security-triage-systems` | Compliance workspace — systems, FIPS 199, documents | PK: `pk` (e.g. `SYSTEM#default`), SK: `sk` (e.g. `METADATA`, `DOC#NIST#SSP`) |

**GSIs:**

| Table | Index name | Keys | Projection |
| --- | --- | --- | --- |
| `security-triage-tasks` | `status-index` | PK: `status`, SK: `created_at` | ALL |
| `security-triage-systems` | `status-all-index` | PK: `status`, SK: `sk` | ALL |

### S3 Buckets

| Bucket pattern | Purpose | Retention |
| --- | --- | --- |
| `security-triage-compliance-{account}-{region}` | Compliance documents (SSP, SAR, etc.) | Versioned; Glacier after 1 year; hard delete after 7 years |
| `security-triage-ato-reports-{account}-{region}` | ATO JSON reports | 90-day lifecycle |
| `security-triage-access-logs-{account}-{region}` | S3 access logs from remediation actions | Standard |
| `security-triage-frontend-{account}-{region}` | SPA static assets | No expiry |

### SQS Queues

| Queue name | Purpose |
| --- | --- |
| `security-triage-compliance-worker-dlq` | Dead-letter queue for compliance worker failures |

### CloudWatch Log Groups

| Log group | Lambda |
| --- | --- |
| `/aws/lambda/security-triage-api` | API Lambda |
| `/aws/lambda/security-triage-execution` | Execution Lambda |
| `/aws/lambda/security-triage-compliance-worker` | Compliance Worker |
| `/aws/lambda/security-triage-compliance-repair` | Compliance Repair |
| `/aws/lambda/security-triage-ato-trigger` | ATO Trigger |
| `/aws/lambda/security-triage-ato-worker` | ATO Worker |

All log groups retain logs for 90 days.

### IAM Roles

| Role name | Used by | Key permissions |
| --- | --- | --- |
| `security-triage-api-lambda` | API Lambda | DynamoDB CRUD, S3 GetObject (compliance bucket), Bedrock InvokeAgent |
| `security-triage-execution-lambda` | Execution Lambda | DynamoDB stream + UpdateItem, S3 PutBucketLogging, ResourceTagging |
| `security-triage-compliance-worker-lambda` | Compliance Worker | DynamoDB UpdateItem + GetItem, S3 PutObject, Bedrock InvokeModel, SecurityHub/Config/GuardDuty read |
| `security-triage-compliance-repair-lambda` | Repair Lambda | DynamoDB Query + UpdateItem + GetItem |
| `security-triage-agentcore` | Bedrock Agent | SecurityHub/GuardDuty/Config/CloudTrail/IAM read, DynamoDB PutItem + Query. **DENY UpdateItem + DeleteItem.** |

### Other Resources

| Resource | Name |
| --- | --- |
| Cognito User Pool | `security-triage-analysts` |
| CloudFront Distribution | See SSM `/security-triage/cloudfront-distribution-id` |
| EventBridge Rule | `security-triage-stuck-job-detector` (every 5 min → repair Lambda) |
| WAF Web ACL | Attached to API Gateway — OWASP rules + rate limit 500 req/5 min |

---

## 2. Configuration Reference

### SSM Parameters (written by CDK at deploy time)

| Parameter | Value |
| --- | --- |
| `/security-triage/api-url` | API Gateway invoke URL |
| `/security-triage/cloudfront-url` | CloudFront distribution URL |
| `/security-triage/cloudfront-distribution-id` | CloudFront distribution ID (for cache invalidation) |
| `/security-triage/frontend-bucket-name` | S3 bucket for SPA assets |
| `/security-triage/user-pool-id` | Cognito User Pool ID |
| `/security-triage/user-pool-client-id` | Cognito App Client ID |
| `/security-triage/cognito-domain` | Cognito hosted UI domain |
| `/security-triage/agent-id` | Bedrock Agent ID |
| `/security-triage/agent-alias-id` | Bedrock Agent Alias ID |
| `/security-triage/required-tag-keys` | JSON array of required tag keys (default: `["Environment","Owner","Project"]`) |
| `/security-triage/systems-table-name` | DynamoDB systems table name |
| `/security-triage/compliance-bucket-name` | Compliance S3 bucket name |

To change required tag keys without redeploying:
```bash
aws ssm put-parameter \
  --name /security-triage/required-tag-keys \
  --value '["Environment","Owner","Project","CostCenter"]' \
  --overwrite \
  --profile YOUR_PROFILE
```

### Lambda Environment Variables

**API Lambda (`security-triage-api`)**

| Variable | Source |
| --- | --- |
| `TASKS_TABLE_NAME` | `security-triage-tasks` |
| `SYSTEMS_TABLE_NAME` | `security-triage-systems` |
| `COMPLIANCE_BUCKET` | `security-triage-compliance-{account}-{region}` |
| `AGENT_ID` | From SSM at deploy time |
| `AGENT_ALIAS_ID` | From SSM at deploy time |
| `USER_POOL_ID` | From SSM at deploy time |
| `REGION` | AWS region |

**Compliance Worker**

| Variable | Value |
| --- | --- |
| `SYSTEMS_TABLE_NAME` | `security-triage-systems` |
| `COMPLIANCE_BUCKET` | Compliance S3 bucket name |
| `BEDROCK_MODEL_ID` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| `REGION` | AWS region |

**Compliance Repair**

| Variable | Value |
| --- | --- |
| `SYSTEMS_TABLE_NAME` | `security-triage-systems` |
| `STATUS_INDEX_NAME` | `status-all-index` |
| `STUCK_THRESHOLD_MIN` | `16` |

---

## 3. How to Deploy

### Full Deploy (infra + frontend)

```bash
./deploy.sh --profile YOUR_PROFILE --region us-east-1 --env prod
```

This runs CDK in two passes (SecurityTriageStack + ComplianceStack before AgentStack, then FrontendStack), then builds and uploads the frontend.

### Frontend-Only Redeploy

Use this when only React code changed — no CDK needed:

```bash
./deploy-frontend.sh --profile YOUR_PROFILE
```

This reads all config from SSM, builds Vite, uploads to S3, and invalidates CloudFront.

### CDK Only (manual)

```bash
cd cdk
npm run build
cdk diff --profile YOUR_PROFILE
cdk deploy --all --profile YOUR_PROFILE
```

### Stack Deploy Order

CDK deploys these stacks in dependency order:

1. `SecurityTriageStack` — Cognito, DynamoDB tasks table, API Lambda, Execution Lambda, API Gateway, WAF
2. `ComplianceStack` — DynamoDB systems table, compliance S3 bucket, compliance worker + repair Lambdas, EventBridge rule
3. `AgentStack` — Bedrock Agent IAM role, audit log group
4. `FrontendStack` — S3 frontend bucket, CloudFront distribution

### CloudFront Cache Invalidation

After a frontend deploy, if the CDN serves stale assets:

```bash
aws cloudfront create-invalidation \
  --distribution-id $(aws cloudfront list-distributions \
    --query "DistributionList.Items[?contains(Origins.Items[0].DomainName, 'security-triage')].Id" \
    --output text --profile YOUR_PROFILE) \
  --paths "/*" \
  --profile YOUR_PROFILE
```

### Rollback

CDK does not auto-rollback on Lambda code errors. To roll back:

1. Revert the code change in git
2. Redeploy (`./deploy.sh` or `./deploy-frontend.sh`)
3. Invalidate CloudFront if frontend changed

---

## 4. How Each Flow Works in AWS

### Triage Investigation

```
Browser
  └─▶ CloudFront → API Gateway → security-triage-api (Lambda)
          │  validates Cognito JWT
          │  POST /chat → writes request to DynamoDB (tasks table, status=WAITING)
          │  invokes itself asynchronously (to bypass 29s API GW timeout)
          │
          └─▶ security-triage-api (async invocation)
                  │  invokes Bedrock Agent (InvokeAgent API)
                  │  Agent loop calls tools via action group Lambda
                  │  Tool results read from SecurityHub / GuardDuty / Config / CloudTrail
                  │  Agent calls queue_task → PutItem to security-triage-tasks (DynamoDB)
                  │  Agent response written back to DynamoDB
                  │
Browser polls GET /chat/result/:id → API Lambda reads from DynamoDB → returns response
```

### Remediation Execution

```
Browser PATCH /tasks/{id}/approve
  └─▶ API Lambda → UpdateItem on security-triage-tasks (PENDING → APPROVED)
          │
          └─▶ DynamoDB Stream event (filter: status=APPROVED)
                  │
                  └─▶ security-triage-execution (Lambda)
                          │  reads task: action + params + resource_id
                          │  executes action (S3 PutBucketLogging or ResourceTagging API)
                          │  tags resource: security-agent-action=true
                          └─▶ UpdateItem → status=EXECUTED (or FAILED)
```

### Compliance Document Generation

```
Browser POST /systems/{id}/documents/{type}/generate
  └─▶ API Lambda → PutItem to security-triage-systems (status=PENDING, generationId=uuid)
          │
          └─▶ DynamoDB Stream event (filter: status=PENDING, sk begins with DOC#NIST#)
                  │
                  └─▶ security-triage-compliance-worker (Lambda, 15 min timeout)
                          │  UpdateItem: PENDING → IN_PROGRESS (conditional — prevents double-run)
                          │  GetItem: reads FIPS 199 impact level
                          │  GetItem: reads system metadata
                          │  Calls SecurityHub GetFindings
                          │  For each of 20 NIST families (parallel):
                          │    Stage A: pre-fill inherited PE/MA controls (no Bedrock)
                          │    Stage B: InvokeModel (Bedrock) per 8-control chunk
                          │  PutObject → security-triage-compliance-{account}-{region}/compliance/{systemId}/NIST/{type}/current.json
                          └─▶ UpdateItem: IN_PROGRESS → COMPLETED (writes updatedAt, s3Key)

Browser polls GET /systems/{id}/documents/{type}
  └─▶ API Lambda reads DynamoDB → on COMPLETED: generates S3 presigned URL (60s TTL)
  └─▶ Browser fetches document directly from S3 via presigned URL
```

### Stuck Job Detection

```
EventBridge rule → every 5 minutes
  └─▶ security-triage-compliance-repair (Lambda)
          │  Query status-all-index GSI for status=IN_PROGRESS
          │  For each result: check generationStartedAt
          │  If stuck > 16 minutes:
          │    UpdateItem: IN_PROGRESS → FAILED (conditional — skips if already COMPLETED)
          │
          └─▶ Also triggered by SQS DLQ (compliance worker failures after retries)
                  Reads DLQ message → extracts pk/sk → marks FAILED
```

---

## 5. How to Add a New Agent Tool

Tools are functions the Bedrock Agent can call during the triage loop.

**Step 1 — Implement the tool function**

Add it to `lambda/agent-tools/index.ts`:

```typescript
async function get_my_new_tool(params: { resource_id: string }): Promise<object> {
  // call AWS APIs (read-only)
  return { result: '...' };
}
```

**Step 2 — Register it in the action group handler**

In the same file, add a case to the dispatch switch:

```typescript
case 'get_my_new_tool':
  result = await get_my_new_tool(params as { resource_id: string });
  break;
```

**Step 3 — Add IAM permissions**

In `cdk/lib/agent-stack.ts`, add the required read-only AWS actions to the agent tools Lambda role. The agent IAM role must never get write permissions to AWS resources.

**Step 4 — Register in Bedrock Agent**

In the Bedrock console (or via CDK if you've automated agent schema updates):

- Open the agent → Action Groups → your action group
- Add the new function with its input/output schema
- Re-prepare the agent (triggers the `agent-prepare` custom resource Lambda)

**Step 5 — Update CLAUDE.md**

Add the new tool to the AgentCore tools table in `CLAUDE.md`.

**Constraints:**

- Read-only AWS access only — the agent IAM role has an explicit DENY on all write actions except DynamoDB PutItem (queue_task) and a constrained UpdateItem (cancel_task)
- Tool functions must return structured JSON, not plain strings
- Keep tool scope narrow — one tool per AWS service or logical concept

---

## 6. How to Add a New Compliance Document Type

**Step 1 — Add the generator in the compliance worker**

In `lambda/compliance-worker/index.ts`, add a new generator function:

```typescript
async function generateMyDoc(
  systemId: string,
  metadata: SystemMetadata,
  fips199: Fips199Record,
): Promise<object> {
  // call Bedrock InvokeModel, return structured JSON
}
```

Add a case to the document type dispatcher (the `switch` on `docType`).

**Step 2 — Add the document definition in the frontend**

In `frontend/src/components/RmfView.tsx`, add an artifact entry to the relevant RMF step in `RMF_STEPS`:

```typescript
{ type: 'MYDOC', label: 'My Document', desc: 'What it covers', kind: 'async' }
```

**Step 3 — Add a renderer in DocumentViewer**

In `frontend/src/components/DocumentViewer.tsx`:

- Add a `MyDocRenderer` component
- Add a case in `renderContent()`: `if (docType === 'MYDOC') return <MyDocRenderer data={data} />;`
- Add a case in `exportToExcel()` for Excel export

**Step 4 — Update CLAUDE.md**

Add the new document type to the document types table.

---

## 7. How to Add a New Execution Action

Execution actions are the only operations that write to AWS resources. All new actions must be Tier 1 (low-risk, reversible) to be automated.

**Step 1 — Implement the action**

Add a new file in `lambda/execution/`:

```typescript
// lambda/execution/my-action.ts
export async function myAction(params: MyActionParams): Promise<string> {
  // write to AWS resource
  // tag every resource touched: { 'security-agent-action': 'true' }
  return 'success message';
}
```

**Step 2 — Register in the execution handler**

In `lambda/execution/index.ts`, add a case to the action dispatcher.

**Step 3 — Add IAM permissions**

In `cdk/lib/security-triage-stack.ts`, add the required write permissions to the `security-triage-execution-lambda` role. Keep scope as narrow as possible — specific resource ARNs, not wildcards.

**Step 4 — Add the action to the agent's queue_task tool**

In `lambda/agent-tools/index.ts`, update the `queue_task` tool's allowed action types so the agent can queue the new action.

**Step 5 — Update CLAUDE.md**

Add the action to the Action Tiers table.

---

## 8. Where to Find Things

### Logs

| What you're looking for | Where |
| --- | --- |
| API errors (auth failures, 500s) | CloudWatch: `/aws/lambda/security-triage-api` |
| Agent tool call trace | CloudWatch: Bedrock Agent invocation logs (enable in Bedrock console) |
| Compliance worker Bedrock calls | CloudWatch: `/aws/lambda/security-triage-compliance-worker` |
| Stuck job detection runs | CloudWatch: `/aws/lambda/security-triage-compliance-repair` |
| Remediation execution results | CloudWatch: `/aws/lambda/security-triage-execution` |
| ATO generation errors | CloudWatch: `/aws/lambda/security-triage-ato-worker` |

### Data

| What you're looking for | Where | Key pattern |
| --- | --- | --- |
| A specific triage task | DynamoDB `security-triage-tasks` | PK: `task_id` (UUID) |
| All pending tasks | DynamoDB `security-triage-tasks` GSI `status-index` | PK: `PENDING` |
| System metadata | DynamoDB `security-triage-systems` | PK: `SYSTEM#default`, SK: `METADATA` |
| FIPS 199 rating | DynamoDB `security-triage-systems` | PK: `SYSTEM#default`, SK: `DOC#NIST#FIPS199` |
| Document record (e.g. SSP) | DynamoDB `security-triage-systems` | PK: `SYSTEM#default`, SK: `DOC#NIST#SSP` |
| All in-progress documents | DynamoDB `security-triage-systems` GSI `status-all-index` | PK: `IN_PROGRESS` |
| ATO job | DynamoDB `security-triage-ato-jobs` | PK: `jobId` |
| Generated SSP JSON | S3 `security-triage-compliance-{account}-{region}` | `compliance/default/NIST/SSP/current.json` |
| ATO report JSON | S3 `security-triage-ato-reports-{account}-{region}` | `ato-reports/{username}/{jobId}.json` |

### Config

| What you're looking for | Where |
| --- | --- |
| API URL | SSM `/security-triage/api-url` |
| Bedrock Agent ID | SSM `/security-triage/agent-id` |
| Required tag keys | SSM `/security-triage/required-tag-keys` |
| All SSM parameters | `aws ssm get-parameters-by-path --path /security-triage/ --profile YOUR_PROFILE` |

### DLQ

```bash
# Check DLQ depth
aws sqs get-queue-attributes \
  --queue-url https://sqs.REGION.amazonaws.com/ACCOUNT/security-triage-compliance-worker-dlq \
  --attribute-names ApproximateNumberOfMessages \
  --profile YOUR_PROFILE
```

---

## 9. Monitoring

### Key Metrics to Watch

| Metric | Namespace | Alarm threshold |
| --- | --- | --- |
| `Errors` on compliance worker | `AWS/Lambda` | > 5 in 10 min |
| `Duration` on compliance worker | `AWS/Lambda` | > 800,000 ms (near 15 min limit) |
| `ApproximateNumberOfMessagesVisible` on DLQ | `AWS/SQS` | > 0 |
| `InvokedModelCount` on Bedrock | `AWS/Bedrock` | Set a budget alert — cost protection |
| `5XXError` on API Gateway | `AWS/ApiGateway` | > 10 in 5 min |

### Detecting Runaway Bedrock Costs

Compliance worker calls Bedrock in parallel across 20 families × multiple chunks per family. A misconfigured chunk size or infinite retry loop can generate unexpected Bedrock spend.

Monitor via:
- AWS Budgets alert on Bedrock service spend
- CloudWatch metric `InvokedModelCount` in `AWS/Bedrock` namespace
- Check compliance worker logs for repeated `callBedrock` calls on the same `generationId`

To stop runaway generation immediately:
```bash
# Throttle the compliance worker to 0 concurrent executions
aws lambda put-function-concurrency \
  --function-name security-triage-compliance-worker \
  --reserved-concurrent-executions 0 \
  --profile YOUR_PROFILE
```

Restore after investigation:
```bash
aws lambda delete-function-concurrency \
  --function-name security-triage-compliance-worker \
  --profile YOUR_PROFILE
```

> **Note:** `reservedConcurrentExecutions` should be re-added to the CDK code once the Lambda concurrent execution quota increase is approved (see Section 11). Target: API Lambda = 20, compliance worker = 5.

---

## 10. Troubleshooting

### Document stuck IN_PROGRESS, never times out

**Symptom:** A compliance document shows "Generating…" in the UI for more than 15 minutes and never transitions to FAILED.

**Diagnosis:**
1. Check the repair Lambda logs: `/aws/lambda/security-triage-compliance-repair`
2. Query the GSI directly:
```bash
aws dynamodb query \
  --table-name security-triage-systems \
  --index-name status-all-index \
  --key-condition-expression "#s = :inprogress" \
  --expression-attribute-names '{"#s": "status"}' \
  --expression-attribute-values '{":inprogress": {"S": "IN_PROGRESS"}}' \
  --profile YOUR_PROFILE
```
3. Check if `generationStartedAt` is set on the record. If missing, the repair Lambda cannot calculate elapsed time and will skip it.

**Fix:**
- Manually mark it FAILED:
```bash
aws dynamodb update-item \
  --table-name security-triage-systems \
  --key '{"pk": {"S": "SYSTEM#default"}, "sk": {"S": "DOC#NIST#SSP"}}' \
  --update-expression "SET #s = :failed, #err = :reason" \
  --expression-attribute-names '{"#s": "status", "#err": "error"}' \
  --expression-attribute-values '{":failed": {"S": "FAILED"}, ":reason": {"S": "Manually reset"}}' \
  --profile YOUR_PROFILE
```

---

### SSP generates with wrong control count

**Symptom:** SSP shows more controls than the NIST baseline for the impact level (e.g. 411 instead of 345 for Moderate).

**Cause:** SecurityHub reports findings against High-only controls on Moderate systems. The worker's `getBaselineControls()` call should constrain the list, but if it falls back to SecurityHub-detected IDs it will over-include.

**Check:** In compliance worker logs, look for the log line showing `controlIds.length` per family. If any family shows more controls than expected (e.g. SC > 40 for Moderate), the baseline lookup may be returning the wrong impact level.

**Fix:** Verify the DynamoDB `DOC#NIST#FIPS199` record has `overallImpact` set correctly, then regenerate.

---

### Agent returns no response / browser shows 504

**Symptom:** Chat message sent, browser gets a 504 or spins indefinitely.

**Diagnosis:**
1. API Gateway has a hard 29s timeout — the async self-invocation pattern handles this, but if the async Lambda fails to start the response will be missing.
2. Check `/aws/lambda/security-triage-api` logs for the request.
3. Check if Bedrock Agent is in a PREPARED state: `aws bedrock-agent get-agent --agent-id AGENT_ID --profile YOUR_PROFILE`

**Common causes:**
- Bedrock Agent not prepared after a CDK deploy (the `agent-prepare` custom resource Lambda should handle this automatically)
- Lambda concurrency exhausted (see Section 11)
- VPC misconfiguration if Lambda is inside a VPC

---

### Auth failures (401 in API logs)

**Symptom:** Every request returns 401, or users can't log in.

**Diagnosis:**
1. Check `/aws/lambda/security-triage-api` logs for `JWT validation failed` messages.
2. Confirm the `USER_POOL_ID` environment variable on the API Lambda matches the deployed Cognito pool:
```bash
aws lambda get-function-configuration \
  --function-name security-triage-api \
  --query Environment.Variables.USER_POOL_ID \
  --profile YOUR_PROFILE
```
3. Check Cognito User Pool exists and the App Client is configured with the correct callback URL.

---

### DLQ has messages

**Symptom:** `ApproximateNumberOfMessagesVisible` > 0 on the compliance worker DLQ.

**Diagnosis:**
1. Read the DLQ message to get the `pk`/`sk` of the failed record.
2. Check compliance worker logs around the `generationStartedAt` timestamp on that record.
3. Common causes: Bedrock `ThrottlingException`, malformed JSON from Bedrock response (chunk size too large for a control family), Lambda timeout.

**Fix:**
- If transient (throttling): the repair Lambda will redrive the DLQ automatically on its next 5-minute run.
- If structural (JSON parse failure): reduce `MAX_CONTROLS_PER_CALL` in `lambda/compliance-worker/index.ts` and redeploy.
- To manually purge stale DLQ messages after fixing:
```bash
aws sqs purge-queue \
  --queue-url https://sqs.REGION.amazonaws.com/ACCOUNT/security-triage-compliance-worker-dlq \
  --profile YOUR_PROFILE
```

---

### CloudFront serving stale frontend

**Symptom:** New code deployed but browser still shows old UI.

**Fix:** Invalidate the CloudFront cache:
```bash
DIST_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?contains(Origins.Items[0].DomainName,'security-triage')].Id" \
  --output text --profile YOUR_PROFILE)

aws cloudfront create-invalidation \
  --distribution-id $DIST_ID \
  --paths "/*" \
  --profile YOUR_PROFILE
```

Also ask users to hard-refresh: `Ctrl+Shift+R` (Windows/Linux) or `Cmd+Shift+R` (Mac).

---

## 11. AWS Quotas & Limits

### Quotas to Check Before Deploying to a New Account

| Quota | Default | Required | Service | How to request |
| --- | --- | --- | --- | --- |
| Lambda concurrent executions | 1,000 (default) — **but can be as low as 10 on new accounts** | At least 50 for production | Lambda | AWS Support case → Service Quota increase |
| Bedrock model access | Off by default | Must be enabled per model per region | Bedrock | Bedrock console → Model Access → Enable |
| API Gateway timeout | 29s (hard limit, cannot be raised) | N/A — architecture works around this | API Gateway | Not raiseable — use async pattern |
| Lambda max timeout | 15 minutes (hard limit) | N/A — compliance worker is tuned to this | Lambda | Not raiseable |

### Lambda Concurrent Executions — Critical

This is the quota that blocked production deployment on this account.

**What happened:** The account had a concurrent execution limit of 10. Setting `reservedConcurrentExecutions: 20` on the API Lambda caused CloudFormation to fail because it would have left fewer than 10 unreserved executions (the AWS minimum).

**Current state:** `reservedConcurrentExecutions` has been removed from both Lambdas as a workaround. A support case has been opened to increase the quota.

**When the quota increase is approved**, re-add the following to `cdk/lib/security-triage-stack.ts` and `cdk/lib/compliance-stack.ts`:

```typescript
// In security-triage-stack.ts — API Lambda
reservedConcurrentExecutions: 20,

// In compliance-stack.ts — Compliance Worker Lambda
reservedConcurrentExecutions: 5,
```

Without reserved concurrency, a spike in compliance document generation could starve the API Lambda of concurrency, causing 429 errors for analysts using the triage chat.

**To check current quota:**
```bash
aws service-quotas get-service-quota \
  --service-code lambda \
  --quota-code L-B99A9384 \
  --profile YOUR_PROFILE
```

### Bedrock Model Access

Bedrock model access must be enabled manually in the AWS console **before the first deploy**. It is not automatic and CDK cannot enable it.

1. Go to AWS Console → Bedrock → Model Access (in the left nav)
2. Click **Manage model access**
3. Enable: **Claude Sonnet** (the specific model ID in `COMPLIANCE_MODEL_ID` in `compliance-stack.ts`)
4. Approval is usually instant for Anthropic models but can take a few minutes

If you deploy before enabling access, Bedrock calls will return `AccessDeniedException` in the Lambda logs. Enable access and retry — no redeploy needed.

### Bedrock Token Limits

The compliance worker calls Bedrock with `max_tokens: 8192` per chunk. This is tuned against the current chunk size of 8 controls per call.

If you increase `MAX_CONTROLS_PER_CALL` beyond 8, families with many controls (e.g. SC at Moderate has 39 controls across 5 chunks) can produce responses that approach the token limit, causing JSON truncation and parse failures.

If you see `Bedrock JSON parse failed` in compliance worker logs, reduce `MAX_CONTROLS_PER_CALL` in `lambda/compliance-worker/index.ts` and redeploy the worker.

### API Gateway 29s Timeout

API Gateway enforces a hard 29-second timeout on all integrations. This cannot be raised. The async chat pattern (POST returns 202 + request ID, client polls GET) exists specifically because Bedrock Agent invocations take longer than 29 seconds.

Do not try to make the chat synchronous — it will always timeout for non-trivial agent loops.
