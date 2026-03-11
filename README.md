# Security Triage Agent

An AI-powered AWS security operations agent. Analysts chat with it to investigate Security Hub findings. The agent enriches findings with GuardDuty, Config, and CloudTrail context, surfaces proposed remediation tasks, and executes safe actions after human approval.

---

## How it works

```
Analyst (browser)
    │
    │  HTTPS + Cognito JWT
    ▼
API Gateway  ──WAF──►  Node.js Lambda  ──►  Bedrock AgentCore (Claude Sonnet)
                              │                        │
                              │                        │  read-only
                              │                        ├──► Security Hub
                              │                        ├──► GuardDuty
                              │                        ├──► Config
                              │                        └──► CloudTrail
                              │
                              │  DynamoDB stream (status = APPROVED)
                              ▼
                       Execution Lambda
                              │
                              ├──► S3 PutBucketLogging
                              └──► S3 PutEncryptionConfiguration
```

1. Analyst opens the chat UI — the agent automatically fetches the latest Security Hub findings.
2. The agent investigates, enriches with threat context, and proposes remediation tasks.
3. Proposed tasks appear in the Task Queue panel with a rationale.
4. Analyst approves or rejects each task.
5. Approved tasks trigger the Execution Lambda via DynamoDB streams — the only component that writes to AWS resources.

---

## MVP scope

**In scope**
- Single analyst workflow
- Chat UI + Task Queue panel
- Agent investigates Security Hub findings on demand
- GuardDuty and CloudTrail enrichment
- Two autonomous actions: enable S3 access logging, enable S3 default encryption

**Out of scope (post-MVP)**
- Multi-user / role-based approval
- Email / Slack notifications
- Auto-approval or scheduled monitoring
- EBS / RDS encryption (disruptive — requires snapshot flow)

---

## Project structure

```
.
├── cdk/                          # AWS CDK infrastructure (TypeScript)
│   ├── bin/app.ts                # CDK app entry point — instantiates all stacks
│   └── lib/
│       ├── security-triage-stack.ts  # Core: Cognito, DynamoDB, Lambdas, API GW, WAF
│       ├── agent-stack.ts            # Bedrock AgentCore IAM role + auto-prepare resource
│       └── frontend-stack.ts         # S3 + CloudFront for React SPA
├── lambda/
│   ├── api/                      # Node.js API layer
│   │   ├── index.ts              # Handler entry point + CORS
│   │   ├── auth.ts               # Cognito JWT validation
│   │   ├── chat.ts               # Bedrock AgentCore proxy
│   │   └── tasks.ts              # Task queue CRUD
│   ├── agent-tools/              # Bedrock action group handler
│   │   └── index.ts              # get_findings, get_threat_context, queue_task, etc.
│   ├── agent-prepare/            # CDK custom resource — prepares agent after deploy
│   │   └── index.ts
│   └── execution/                # Execution Lambda — S3 remediation only
│       ├── index.ts              # Handler + DynamoDB stream parser
│       ├── enable-logging.ts     # S3 PutBucketLogging
│       └── enable-encryption.ts  # S3 PutEncryptionConfiguration
├── frontend/                     # React + Vite SPA
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Chat.tsx          # Chat panel (right)
│   │   │   └── TaskQueue.tsx     # Task queue panel (left)
│   │   └── lib/
│   │       ├── auth.ts           # Cognito PKCE auth flow
│   │       └── api.ts            # API Gateway client
│   └── package.json
└── CLAUDE.md                     # AI agent instructions and architecture rules
```

---

## Stack

| Layer | Technology |
|---|---|
| Infrastructure | AWS CDK v2 (TypeScript) |
| Auth | Amazon Cognito — PKCE authorization code flow |
| API | API Gateway + Node.js 22 Lambda |
| Agent | AWS Bedrock AgentCore, Claude Sonnet 4.5 |
| Database | DynamoDB (single table, streams) |
| Storage | S3 + CloudFront |
| Security | WAF (OWASP rules + rate limiting) |
| Observability | CloudWatch (90-day log retention) |
| Frontend | React + Vite |

---

## Prerequisites

- AWS CLI v2 configured (`aws configure`) with admin permissions
- Node.js 22+
- AWS CDK CLI: `npm install -g aws-cdk`
- CDK bootstrapped in the target account/region:
  ```bash
  cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
  ```
- Bedrock model access enabled for **Claude Sonnet 4.5** (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`)
  in the target region. Enable it in the [Bedrock Model Access console](https://console.aws.amazon.com/bedrock/home#/modelaccess).
- AWS Security Hub enabled in the target region.

---

## First-time deployment

### 1. Set environment variables

```bash
export CDK_DEFAULT_ACCOUNT=123456789012   # your AWS account ID
export CDK_DEFAULT_REGION=us-east-1       # target region
export OWNER_EMAIL=you@example.com        # used for cost-allocation tags
```

### 2. Install dependencies and build CDK

```bash
cd cdk && npm install && npm run build
cd ..
```

### 3. Install and build Lambda packages

```bash
cd lambda/api      && npm install && npm run build && cd ../..
cd lambda/execution && npm install && npm run build && cd ../..
cd lambda/agent-tools && npm install && npm run build && cd ../..
cd lambda/agent-prepare && npm install && npm run build && cd ../..
```

### 4. Deploy infrastructure stacks

```bash
cd cdk

# Deploy core infrastructure (Cognito, DynamoDB, API GW, WAF, Lambdas)
cdk deploy SecurityTriageStack

# Deploy Bedrock AgentCore IAM role
cdk deploy AgentStack

# Deploy CloudFront + S3 frontend hosting
cdk deploy SecurityTriageFrontendStack
```

Note the CDK outputs — you will need them in the next steps.

### 5. Create the Bedrock Agent (one-time, in console)

CDK provisions the IAM role and tooling but the Bedrock Agent itself must be created
once in the console to obtain an Agent ID:

1. Open **Bedrock → Agents → Create Agent**
2. Name: `security-triage-agent`
3. IAM role: select `security-triage-agentcore` (created by AgentStack)
4. Model: `us.anthropic.claude-sonnet-4-5-20250929-v1:0`
5. Instructions: copy the agent instructions from `cdk/lib/agent-stack.ts` (`AGENT_INSTRUCTIONS` constant)
6. Add an **Action Group**:
   - Name: `SecurityTools`
   - Lambda: `security-triage-agent-tools`
   - Schema: select the OpenAPI schema from `cdk/lib/` or paste manually
7. Click **Save and prepare**
8. Create an alias named `prod` — note the **Agent ID** and **Alias ID**

### 6. Wire Agent ID back to the API Lambda

```bash
aws lambda update-function-configuration \
  --function-name security-triage-api \
  --environment "Variables={
    AGENT_ID=<your-agent-id>,
    AGENT_ALIAS_ID=<your-alias-id>,
    ALLOWED_ORIGIN=https://<your-cloudfront-domain>
  }"
```

Or set these in `cdk/lib/security-triage-stack.ts` and redeploy:

```typescript
environment: {
  AGENT_ID: 'XXXXXXXXXX',
  AGENT_ALIAS_ID: 'YYYYYYYYYY',
  ALLOWED_ORIGIN: 'https://dXXXXXX.cloudfront.net',
},
```

### 7. Create the first analyst account

```bash
# Replace values with your Cognito User Pool ID and desired email
aws cognito-idp admin-create-user \
  --user-pool-id us-east-1_XXXXXXXXX \
  --username analyst@example.com \
  --user-attributes Name=email,Value=analyst@example.com Name=email_verified,Value=true \
  --temporary-password "Temp1234!" \
  --message-action SUPPRESS
```

### 8. Publish Cognito Managed Login branding

The login page will show "unavailable" until branding is published:

```bash
aws cognito-idp create-managed-login-branding \
  --user-pool-id us-east-1_XXXXXXXXX \
  --client-id <your-app-client-id> \
  --use-cognito-provided-values
```

### 9. Configure the frontend

```bash
cp frontend/.env.example frontend/.env.local
```

Edit `frontend/.env.local`:

```
VITE_API_URL=https://<api-gateway-id>.execute-api.us-east-1.amazonaws.com/prod
VITE_USER_POOL_ID=us-east-1_XXXXXXXXX
VITE_USER_POOL_CLIENT_ID=<app-client-id>
VITE_COGNITO_DOMAIN=https://<cognito-domain>.auth.us-east-1.amazoncognito.com
VITE_REDIRECT_URI=https://<cloudfront-domain>/
```

### 10. Build and deploy the frontend

```bash
cd frontend && npm install && npm run build

aws s3 sync dist/ s3://security-triage-frontend-<account>-<region>/ --delete

# Invalidate CloudFront cache
aws cloudfront create-invalidation \
  --distribution-id <distribution-id> \
  --paths "/*"
```

---

## Redeployment (subsequent changes)

```bash
cd cdk && cdk deploy --all
```

For Lambda code changes only (faster than full CDK deploy):

```bash
cd lambda/api && npm run build
cd ../../cdk && cdk deploy SecurityTriageStack
```

For frontend changes only:

```bash
cd frontend && npm run build
aws s3 sync dist/ s3://security-triage-frontend-<account>-<region>/ --delete
aws cloudfront create-invalidation --distribution-id <id> --paths "/*"
```

---

## Resources with RETAIN policy

The following resources are **not deleted** when a stack is torn down — remove them
manually if needed:

| Resource | Name | Stack |
|---|---|---|
| DynamoDB table | `security-triage-tasks` | SecurityTriageStack |
| Cognito User Pool | `security-triage-analysts` | SecurityTriageStack |
| S3 frontend bucket | `security-triage-frontend-{account}-{region}` | SecurityTriageFrontendStack |

If a failed deploy rolls back and leaves these resources, re-adopt them with:

```bash
cdk import SecurityTriageStack
```

---

## Testing — three MVP scenarios

### Scenario 1 — Agent fetches findings on open

1. Open the CloudFront URL and log in.
2. Wait for the chat panel to load.
3. **Expected:** The agent sends an opening message summarising the most critical
   active Security Hub findings, in plain English, without you typing anything.

### Scenario 2 — Approve a task and verify execution

1. In the chat, type: *"Check if any S3 buckets are missing access logging and queue a fix."*
2. **Expected:** The agent queries Security Hub, identifies a non-compliant bucket,
   and queues a `enable_s3_logging` task visible in the Task Queue panel.
3. Click **Approve** on the task.
4. **Expected:** Task status changes to `APPROVED`, then shortly to `EXECUTED`.
5. Verify in the AWS console:
   - S3 bucket → Properties → Server access logging → Enabled
   - Bucket has tag `security-agent-action: true`

### Scenario 3 — Query the task queue

1. In the chat, type: *"What have you queued?"*
2. **Expected:** The agent returns a clear summary of pending and recent tasks,
   including the action, resource, and rationale for each.

If all three scenarios work, the MVP is complete.

---

## Troubleshooting

### "Login pages unavailable" on the Cognito hosted UI

Cognito Managed Login branding has not been published. Run:

```bash
aws cognito-idp create-managed-login-branding \
  --user-pool-id <USER_POOL_ID> \
  --client-id <APP_CLIENT_ID> \
  --use-cognito-provided-values
```

### "redirect_uri mismatch" after login

The callback URL registered in the Cognito app client does not exactly match
`VITE_REDIRECT_URI`. Common cause: trailing slash. Both must match exactly
(include the trailing slash: `https://dXXXX.cloudfront.net/`).

Check registered URLs:

```bash
aws cognito-idp describe-user-pool-client \
  --user-pool-id <USER_POOL_ID> \
  --client-id <APP_CLIENT_ID> \
  --query 'UserPoolClient.CallbackURLs'
```

### Agent returns "Agent not yet configured" (503)

`AGENT_ID` or `AGENT_ALIAS_ID` environment variables are not set on the API Lambda.
Set them via the console or CDK (see step 6 above).

### Agent returns stale responses (old model, old instructions)

The Bedrock Agent prod alias is pointing to an old version snapshot instead of
DRAFT. Fix:

1. Open **Bedrock → Agents → security-triage-agent → Aliases → prod**
2. Edit the alias — select "Create a new version and update alias" or switch to DRAFT
3. Save

Future deploys avoid this by keeping the alias pointed at DRAFT (configured in `agent-stack.ts`).

### "Access denied" calling Bedrock

The AgentCore IAM role is missing permissions for the cross-region inference profile.
Verify the role (`security-triage-agentcore`) has:

```json
{
  "Action": [
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithResponseStream",
    "bedrock:GetInferenceProfile"
  ],
  "Resource": [
    "arn:aws:bedrock:us-east-1:<account>:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0",
    "arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0",
    "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0"
  ]
}
```

### "Failed to fetch" on first request after a long idle

Lambda cold starts chaining across API Lambda → AgentCore → Agent Tools Lambda
can exceed the API Gateway 29-second timeout. This is expected behaviour on a
lightly-used deployment. The second request in the same session will succeed.
To mitigate, add an EventBridge rule that pings the API Lambda every 5 minutes.

### Task stays PENDING after approval

The Execution Lambda is triggered by the DynamoDB stream. Check:

1. Stream is enabled on the `security-triage-tasks` table (NEW_AND_OLD_IMAGES)
2. Execution Lambda has an event source mapping for the stream
3. CloudWatch Logs for `security-triage-execution` for errors

### CORS errors in the browser

`ALLOWED_ORIGIN` on the API Lambda does not match your CloudFront domain. Update it:

```bash
aws lambda update-function-configuration \
  --function-name security-triage-api \
  --environment "Variables={...,ALLOWED_ORIGIN=https://<your-cloudfront-domain>}"
```

---

## Security architecture

- **The agent has zero write access to AWS services.** Its only write action is `DynamoDB PutItem` to queue a task.
- **Only the Execution Lambda writes to AWS resources**, and only the two permitted S3 actions.
- **The Execution Lambda is triggered exclusively by a DynamoDB stream event** where `status = APPROVED`. It cannot be invoked directly.
- **Every S3 action tags the resource** with `security-agent-action: true` and an execution timestamp.
- **No AWS credentials reach the browser.** All traffic is proxied through the API Lambda.
- **Every API request requires a valid Cognito JWT**, validated by both API Gateway and the Lambda (defence in depth).
- **PKCE authorization code flow** — no tokens exposed in the browser URL hash.
- **WAF** enforces OWASP common rules, known bad input blocking, and a 500 req / 5 min rate limit per IP.

---

## Task queue

Tasks move through these states only:

```
PENDING → APPROVED → EXECUTED
PENDING → REJECTED
```

| Field | Description |
|---|---|
| `task_id` | UUID |
| `status` | PENDING \| APPROVED \| REJECTED \| EXECUTED \| FAILED |
| `finding_id` | Security Hub finding ID |
| `resource_id` | ARN of the affected resource |
| `action` | `enable_s3_logging` or `enable_s3_encryption` |
| `rationale` | Why the agent proposes this action |
| `risk_tier` | Always 1 for MVP |
| `approved_by` | Analyst email (set on approval) |

---

## Development

```bash
# CDK
cd cdk && npm run build    # compile TypeScript
cd cdk && npm run watch    # watch mode

# API Lambda
cd lambda/api && npm install && npm run build

# Execution Lambda
cd lambda/execution && npm install && npm run build

# Frontend (local dev — points at deployed API)
cd frontend && npm run dev
```
