# lambda/

Eight Lambda functions, each with its own IAM role, dependencies, and build step.

| Folder | Function name | Trigger | Purpose |
| --- | --- | --- | --- |
| `api/` | `security-triage-api` | API Gateway | Validates Cognito JWT, proxies chat to Bedrock, handles task queue CRUD and compliance workspace routes |
| `agent-tools/` | `security-triage-agent-tools` | Bedrock Agent (action group) | Executes all agent tools — reads Security Hub, GuardDuty, CloudTrail, Config, IAM, Cost Explorer, Access Analyzer |
| `execution/` | `security-triage-execution` | DynamoDB stream (`status = APPROVED`) | Executes approved remediations — S3 logging and resource tagging only |
| `agent-prepare/` | `security-triage-agent-prepare` | CDK custom resource (on deploy) | Calls Bedrock `PrepareAgent` after each CDK deploy so the agent reflects the latest action group schema |
| `ato-trigger/` | `security-triage-ato-trigger` | API Gateway (`/ato/*` routes) | Creates ATO report jobs, polls job status, lists enabled standards, returns job history |
| `ato-worker/` | `security-triage-ato-worker` | DynamoDB stream (`AtoJobsTable` INSERT) | Fetches NIST 800-53 findings from Security Hub, calls Bedrock to generate narratives and POA&M entries, writes JSON report to S3 |
| `compliance-worker/` | `security-triage-compliance-worker` | DynamoDB stream (`security-triage-systems` INSERT/MODIFY where `status = PENDING`) | Generates compliance documents (SSP, POA&M, SAR, RA, ConMon, IRP) using NIST 800-53B baselines, AWS CRM inheritance, and Bedrock |
| `compliance-worker/` (repair) | `security-triage-compliance-repair` | EventBridge (every 5 min) + SQS DLQ | Marks stuck IN_PROGRESS jobs FAILED after 12 min; redrives DLQ messages for transient failures |

## Build

Each Lambda is built independently:

```bash
cd lambda/api               && npm run build
cd lambda/agent-tools       && npm run build
cd lambda/execution         && npm run build
cd lambda/agent-prepare     && npm run build
cd lambda/ato-trigger       && npm run build
cd lambda/ato-worker        && npm run build
cd lambda/compliance-worker && npm run build
```

`deploy.sh` runs all builds automatically.

## Architecture rules

- `api/` — may call DynamoDB and Bedrock AgentCore. Never calls AWS service APIs directly.
- `agent-tools/` — read-only on all AWS services. May call DynamoDB PutItem (`queue_task`) and UpdateItem (`cancel_task`) only.
- `execution/` — only two allowed actions: `enable_s3_logging`, `tag_resource`. Triggered exclusively by DynamoDB stream, never invoked directly.
- `ato-trigger/` — reads DynamoDB (AtoJobsTable) and generates S3 presigned URLs. Never invokes the worker directly — the worker is triggered by DynamoDB Streams.
- `ato-worker/` — reads Security Hub and calls Bedrock. Writes to S3 (report JSON) and DynamoDB (job status). Has no access to the task queue table or any resource under investigation.
- `compliance-worker/` — reads Security Hub, GuardDuty, Config, IAM, AccessAnalyzer. Calls Bedrock. Writes to S3 (document JSON) and DynamoDB (job status). Has no write access to any AWS resource under investigation. PE/MA inherited controls are pre-filled from `aws-crm.ts` without Bedrock calls.
- `compliance-worker/` (repair) — only writes DynamoDB status fields. No Bedrock, no S3, no Security Hub access.
