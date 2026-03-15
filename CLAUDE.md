# Security Triage Agent — Project Context

## What this is
An AI-powered AWS security operations agent. Analysts chat with it to investigate
Security Hub findings. It enriches findings with GuardDuty, Config, and CloudTrail
context, queues remediation tasks, and executes safe actions after human approval.

## MVP Scope — build only this
- Single user (one analyst)
- Chat UI — ask the agent to investigate findings
- Task queue panel — agent surfaces intended actions with rationale
- Approve / Reject tasks in the UI
- Two autonomous actions only: enable S3 access logging, tag_resource (apply required tags)
- Real Security Hub findings (no mock data in prod)
- GuardDuty + CloudTrail enrichment on demand
- Agent checks Security Hub when chat opens, or when analyst asks

## Out of scope for MVP
- Email notifications and reply-based approval
- Multi-user and role-based approval
- Auto-approval / timeout approval
- Scheduled or proactive monitoring
- EBS / RDS encryption (requires disruptive snapshot flow)
- Any Tier 2 or Tier 3 destructive actions

---

## Stack

### Frontend
- React + Vite
- Two panels: Task Queue (left) + Chat (right)
- Cognito JS SDK for auth
- Hosted on S3 + CloudFront

### Backend
- Node.js Lambda (Express-style) — thin API layer only, no agent logic
- Validates Cognito JWT on every request
- Chat uses async pattern: POST /chat → 202 + request_id → GET /chat/result/:id (polls until done). Lambda invokes itself asynchronously to work around API Gateway's 29 s timeout.
- Handles task queue CRUD against DynamoDB (approve, reject, dismiss via DELETE)
- Task write actions are separate from Execution Lambda trigger (stream-based)

### Agent
- AWS Bedrock AgentCore — owns the agent loop, memory, tool execution
- Claude Sonnet on Bedrock
- Read-only AWS access (Security Hub, GuardDuty, Config, CloudTrail)
- Write access to DynamoDB only (queue_task tool)
- NEVER executes AWS actions directly

### Execution Lambda
- Separate function, separate IAM role
- Only triggered by DynamoDB approval event (status: PENDING → APPROVED)
- Only two actions: enable_s3_logging, tag_resource
- Tags every resource it touches: security-agent-action: true + timestamp

### Data
- DynamoDB — task queue (single table)
- AgentCore memory — environment facts + session context

### Infrastructure
- AWS CDK (TypeScript)
- Secrets Manager — Anthropic/Bedrock API key
- WAF — OWASP rules + rate limiting on API Gateway
- CloudWatch — 90-day log retention, agent audit trail
- In the CDK stack — no Secrets Manager secret needed. Bedrock model access is via IAM only. Agent uses bedrock:InvokeModel permission, not an API key.

---

## Architecture rules — never violate these

1. The agent IAM role has ZERO write permissions to AWS services
2. Only the Execution Lambda writes to AWS resources
3. The agent's only write actions are queue_task (PutItem) and cancel_task (UpdateItem PENDING→CANCELLED) → DynamoDB only
4. Every autonomous action must leave a tag on the resource
5. Execution Lambda is only triggered by an APPROVED task in DynamoDB
6. No AWS credentials ever reach the browser
7. All browser → AWS traffic goes through Node Lambda
8. Cognito JWT must be validated before any DynamoDB or AgentCore call

---

## Task queue model

Tasks flow through these states only:
PENDING → APPROVED → EXECUTED
PENDING → REJECTED  → DISMISSED  (analyst clears from UI)
PENDING → CANCELLED             (agent retracts via cancel_task)
           FAILED   → DISMISSED  (analyst clears from UI)

### Task record shape (DynamoDB)
```json
{
  "task_id": "uuid",
  "status": "PENDING | APPROVED | REJECTED | EXECUTED | FAILED | CANCELLED | DISMISSED",
  "finding_id": "SH-2024-001",
  "resource_id": "arn:aws:s3:::bucket-name",
  "action": "enable_s3_logging | tag_resource",
  "action_params": "{\"Environment\":\"prod\",\"Owner\":\"team-security\",\"Project\":\"payments\"} (JSON string, required for tag_resource, omitted otherwise)",
  "rationale": "why the agent wants to do this",
  "risk_tier": 1,
  "created_at": "ISO8601",
  "approved_at": "ISO8601 or null",
  "approved_by": "email or null",
  "executed_at": "ISO8601 or null",
  "result": "success message or error"
}
```

---

## Action tiers (MVP has Tier 1 only)

- **Tier 1** — agent queues, analyst approves in UI, Execution Lambda acts
  - enable S3 access logging
  - tag_resource — apply required tags (Environment, Owner, Project) to any resource ARN
- **Tier 2** — post-MVP, requires senior analyst approval (not built yet)
- **Tier 3** — post-MVP, out-of-band approval required (not built yet)

---

## AgentCore tools (read-only except queue_task and cancel_task)

```
get_findings            → Security Hub GetFindings
get_threat_context      → GuardDuty ListFindings + GetFindings
get_config_status       → Config DescribeComplianceByResource
get_trail_events        → CloudTrail LookupEvents
get_tag_compliance      → ResourceGroupsTaggingAPI GetResources (find resources missing required tags)
get_enabled_standards   → Security Hub GetEnabledStandards + DescribeStandards
get_compliance_report   → Security Hub DescribeStandardsControls + GetFindings (compliance posture by standard)
queue_task              → DynamoDB PutItem (queue a remediation task)
cancel_task             → DynamoDB UpdateItem PENDING→CANCELLED (retract a queued task)
get_task_queue          → DynamoDB Query (read pending/recent tasks)
```

Required tag keys are stored in SSM at `/security-triage/required-tag-keys` as a JSON array.
Default: `["Environment","Owner","Project"]`. Edit the parameter to change the policy without redeploying.

---

## Project structure (target)

```
/
├── CLAUDE.md
├── cdk/                        ← CDK infrastructure
│   ├── bin/app.ts
│   ├── lib/
│   │   ├── security-triage-stack.ts
│   │   ├── agent-stack.ts
│   │   └── frontend-stack.ts
│   └── package.json
├── lambda/
│   ├── api/                    ← Node.js API layer
│   │   ├── index.ts
│   │   ├── auth.ts
│   │   ├── chat.ts
│   │   └── tasks.ts
│   └── execution/              ← Execution Lambda (remediation actions)
│       ├── index.ts
│       ├── enable-logging.ts
│       └── apply-tags.ts
├── frontend/                   ← React + Vite
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Chat.tsx
│   │   │   └── TaskQueue.tsx
│   │   └── lib/
│   │       ├── auth.ts
│   │       └── api.ts
│   └── package.json
└── .claude/
    ├── settings.json
    └── skills/
        ├── aws-security/
        ├── stack-patterns/
        └── task-queue/
```

---

## Environment variables (set before building)

```
CDK_DEFAULT_ACCOUNT     AWS account ID
CDK_DEFAULT_REGION      Target region (default: us-east-1)
ANTHROPIC_SECRET_ARN    Secrets Manager ARN for Bedrock key
USER_POOL_ID            Cognito User Pool ID (post-deploy)
USER_POOL_CLIENT_ID     Cognito App Client ID (post-deploy)
```

---

## Commands to know

```bash
# CDK
cd cdk && npm run build && cdk diff
cd cdk && cdk deploy

# Lambda (API)
cd lambda/api && npm run build

# Lambda (Execution)
cd lambda/execution && npm run build

# Frontend
cd frontend && npm run dev
cd frontend && npm run build
```

---

## What good looks like for MVP

Three scenarios must work end to end:

1. Analyst opens chat → agent pulls Security Hub findings → returns plain-English
   summary of most critical finding
2. Agent queues a task → analyst clicks Approve → S3 change is made → AWS console
   confirms the change → task shows EXECUTED in queue
3. Analyst asks "what have you queued?" → agent returns clear summary of pending
   tasks with rationale

If these three work, MVP is done.


