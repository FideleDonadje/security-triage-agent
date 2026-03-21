# lambda/

Three Lambda functions, each with its own IAM role, dependencies, and build step.

| Folder | Function name | Trigger | Purpose |
|---|---|---|---|
| `api/` | `security-triage-api` | API Gateway | Validates Cognito JWT, proxies chat to Bedrock, handles task queue CRUD |
| `agent-tools/` | `security-triage-agent-tools` | Bedrock Agent (action group) | Executes all agent tools — reads Security Hub, GuardDuty, CloudTrail, Config, IAM, Cost Explorer, Access Analyzer |
| `execution/` | `security-triage-execution` | DynamoDB stream (`status = APPROVED`) | Executes approved remediations — S3 logging and resource tagging only |
| `agent-prepare/` | `security-triage-agent-prepare` | CDK custom resource (on deploy) | Calls Bedrock `PrepareAgent` after each CDK deploy so the agent reflects the latest action group schema |

## Build

Each Lambda is built independently:

```bash
cd lambda/api          && npm run build
cd lambda/agent-tools  && npm run build
cd lambda/execution    && npm run build
cd lambda/agent-prepare && npm run build
```

`deploy.sh` runs all four builds automatically.

## Architecture rules

- `api/` — may call DynamoDB and Bedrock AgentCore. Never calls AWS service APIs directly.
- `agent-tools/` — read-only on all AWS services. May call DynamoDB PutItem (queue_task) and UpdateItem (cancel_task) only.
- `execution/` — only two allowed actions: `enable_s3_logging`, `tag_resource`. Triggered exclusively by DynamoDB stream, never invoked directly.
