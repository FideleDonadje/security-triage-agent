# debug-task

Diagnose a failed or stuck task in the security-triage-agent task queue.

The user will provide a task_id, a resource ARN, or just say "the last failed task". If they haven't provided enough to identify a task, ask for the task_id or resource ARN.

## Step 1 — Find the task record

If a task_id was provided, run:
```bash
aws dynamodb get-item \
  --table-name security-triage-tasks \
  --key '{"task_id":{"S":"<task_id>"}}' \
  --region us-east-1
```

If only a resource ARN or description was provided, scan for recent FAILED tasks:
```bash
aws dynamodb query \
  --table-name security-triage-tasks \
  --index-name status-index \
  --key-condition-expression "#s = :s" \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":s":{"S":"FAILED"}}' \
  --scan-index-forward false \
  --limit 10 \
  --region us-east-1
```

Print the task record in a readable format: task_id, status, action, resource_id, result (the error message), created_at, approved_at.

## Step 2 — Identify the failure category

Classify the `result` field into one of these categories:

| Category | Pattern in result | Next step |
|---|---|---|
| **IAM permission denied** | "not authorized to perform" | Step 3 |
| **Invalid ARN** | "not a valid AWS ARN", "Rejected: resource" | Step 4 |
| **Resource not found** | "NoSuchBucket", "ResourceNotFoundException" | Step 5 |
| **Unsupported resource type** | "not supported", "InvalidParameterException" | Step 6 |
| **Missing action_params** | "action_params is required" | Step 7 |
| **Unknown / other** | anything else | Step 8 |

## Step 3 — IAM permission denied

Read `cdk/lib/security-triage-stack.ts` and find the execution Lambda role (`executionLambdaRole`).
Identify which permission is missing based on the error (e.g. `cognito-idp:TagResource`).
Tell the user exactly which IAM statement needs to be added and in which file.

## Step 4 — Invalid ARN

The execution Lambda validates ARN format. Show the user the ARN that was rejected and explain why it's invalid (missing account ID, wrong service prefix, truncated, etc.).
Check `lambda/execution/index.ts` for the validation logic to confirm.

## Step 5 — Resource not found

The resource may have been deleted between when the task was queued and when it was approved.
Suggest: reject the task in the UI and ask the agent to re-investigate.

## Step 6 — Unsupported resource type

The `tag_resource` action uses `ResourceGroupsTaggingAPI.TagResources`, which doesn't support all resource types (e.g. CloudFormation stacks, API Gateway, IAM).
Read `lambda/agent-tools/index.ts` and find `TAGGABLE_RESOURCE_TYPES`.
Suggest adding the resource type to that array (if it's actually supported by the Tagging API) or excluding it from `get_tag_compliance` results.

## Step 7 — Missing action_params

The `tag_resource` action requires a JSON object of tag key-value pairs in `action_params`.
This means the agent queued the task without inferring tag values. Suggest asking the agent to re-queue with explicit tag values.

## Step 8 — CloudWatch log investigation

If the error is unclear, fetch the most recent execution Lambda log events:
```bash
aws logs tail /aws/lambda/security-triage-execution \
  --since 1h \
  --region us-east-1
```

Look for the log line containing the task_id or resource_id and print the relevant error.

## Step 9 — Summary and fix

Print a clear diagnosis:
- **What happened:** one sentence
- **Root cause:** specific error + file/line reference if applicable
- **Fix:** exact steps to resolve (IAM change, config change, re-queue, etc.)
