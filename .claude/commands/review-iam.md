# review-iam

Review all IAM policies in the CDK stacks for correctness, least-privilege, and adherence to the project's architecture rules. This is a read-only analysis — do not modify any files unless the user explicitly asks.

## Step 1 — Read the CDK stacks

Read these files in full:
- `cdk/lib/security-triage-stack.ts`
- `cdk/lib/agent-stack.ts`

## Step 2 — Check architecture rules

Verify each rule from CLAUDE.md is enforced in the IAM:

| Rule | What to check |
|---|---|
| #1 Agent role has ZERO write to AWS services | `agentToolsLambdaRole` has no `Put*`, `Create*`, `Update*`, `Delete*` on any AWS service except DynamoDB |
| #2 Only Execution Lambda writes to AWS resources | `executionLambdaRole` is the only role with `s3:PutBucketLogging`, `tag:TagResources`, etc. |
| #3 Agent's only writes are queue_task and cancel_task | `agentToolsLambdaRole` has `DynamoDB:PutItem` and `DynamoDB:UpdateItem` — and no other write actions |
| #4 DENY hard-delete | `agentToolsLambdaRole` has an explicit `DENY` on `dynamodb:DeleteItem` |
| #5 Execution Lambda only triggered by DynamoDB stream | Execution Lambda has `dynamodb:GetRecords`, `dynamodb:GetShardIterator`, `dynamodb:DescribeStream`, `dynamodb:ListStreams` — not invocable via API GW or direct invoke |
| #6 No AWS credentials in browser | API Lambda role has no credential-generating actions (`sts:AssumeRole`, `iam:CreateAccessKey`, etc.) |

## Step 3 — Check for overly broad permissions

For each role, flag:
- Any `*` wildcard on both action AND resource (e.g. `actions: ['*'], resources: ['*']`)
- Any write action on `resources: ['*']` where a tighter ARN is feasible
- Any `sts:AssumeRole` or `iam:*` permissions
- Managed policies beyond `AWSLambdaBasicExecutionRole` — explain why each is justified

## Step 4 — Check execution Lambda scope

The execution Lambda should only have permissions for the two Tier 1 actions:
- `s3:GetBucketLogging`, `s3:PutBucketLogging` (enable_s3_logging)
- `tag:TagResources` (tag_resource)
- `s3:PutBucketTagging`, `ec2:CreateTags`, `lambda:TagResource`, `rds:AddTagsToResource` (service-specific tagging)
- `dynamodb:UpdateItem` on the task table (mark EXECUTED/FAILED)

Flag anything outside this scope.

## Step 5 — Check CORS and API Gateway auth

In `security-triage-stack.ts`:
- Every API GW method should have `authorizer` set (Cognito authorizer) — flag any method with `authorizationType: NONE` that isn't an OPTIONS preflight
- CORS `allowOrigins` should not be `ALL_ORIGINS` in production — flag if it is and suggest tightening to the CloudFront URL

## Step 6 — Report

Print a structured report:

```
## IAM Review — security-triage-agent

### Architecture rules: PASS / FAIL per rule

### Overly broad permissions
(list any findings or "None found")

### Execution Lambda scope
(list any findings or "Scope looks correct")

### API Gateway auth
(list any findings or "All methods authenticated")

### Recommendations
(ordered by severity: HIGH / MEDIUM / LOW)
```

If everything looks correct, say so explicitly. Do not manufacture findings.
