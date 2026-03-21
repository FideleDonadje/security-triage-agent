# lambda/execution/

Execution Lambda — the only function that writes to AWS resources.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Handler — parses DynamoDB stream events, validates task, routes to the correct action |
| `enable-logging.ts` | Enables S3 server access logging on a bucket, directing logs to the centralized logging bucket |
| `apply-tags.ts` | Applies required tags to any resource ARN via ResourceGroupsTaggingAPI |

## Allowed actions

Only two actions are permitted. Any other `action` value is rejected:

| Action | What it does | IAM required |
|---|---|---|
| `enable_s3_logging` | `s3:PutBucketLogging` on the target bucket | `s3:PutBucketLogging`, `s3:GetBucketLogging` |
| `tag_resource` | `tag:TagResources` on any resource ARN | `tag:TagResources` + service-specific tagging permissions |

## Trigger

Triggered exclusively by a DynamoDB stream event where `status` changes to `APPROVED`. Cannot be invoked directly — the stream filter enforces this.

## Audit trail

Every action adds two tags to the resource it touches:
- `security-agent-action: enable_s3_logging` or `tag_resource`
- `security-agent-executed-at: <ISO8601 timestamp>`

## Task state transitions

On success: `APPROVED → EXECUTED`
On failure: `APPROVED → FAILED` (error message written to the `result` field)
