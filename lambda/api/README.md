# lambda/api/

Node.js 22 Lambda — the only entry point between the browser and AWS.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Handler entry point — routes API Gateway events, adds CORS headers, handles async worker invocations |
| `auth.ts` | Cognito JWT validation — verifies token signature against the User Pool JWKS endpoint |
| `chat.ts` | Chat endpoints — `POST /chat` returns 202 + request_id, async worker calls Bedrock AgentCore, `GET /chat/result/:id` polls DynamoDB for the result |
| `tasks.ts` | Task queue CRUD — approve, reject, dismiss tasks; reads tasks by status |

## Async chat pattern

API Gateway has a 29-second hard timeout. Bedrock agent calls can take 1–3 minutes. The chat flow works around this:

1. `POST /chat` — stores a `CHAT_PENDING` record in DynamoDB, invokes itself asynchronously (`InvocationType: Event`), returns `202 { request_id }` immediately
2. Worker invocation — calls Bedrock AgentCore, writes result back to DynamoDB
3. `GET /chat/result/:request_id` — frontend polls until status is `CHAT_DONE` or `CHAT_FAILED`

## Environment variables

| Variable | Source |
|---|---|
| `TABLE_NAME` | CDK — DynamoDB table name |
| `STATUS_INDEX_NAME` | CDK — GSI name for status queries |
| `AGENT_ID` | SSM at cold start — Bedrock Agent ID |
| `AGENT_ALIAS_ID` | SSM at cold start — Bedrock Agent alias ID |
| `ALLOWED_ORIGIN` | CDK — CloudFront URL for CORS |
| `REGION` | CDK — deployment region |
