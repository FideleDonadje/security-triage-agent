# Security Triage Agent — Project Context

## What this is
An AI-powered AWS security operations platform. Analysts chat with it to investigate
Security Hub findings, remediate resources, and generate compliance documentation.
It enriches findings with GuardDuty, Config, and CloudTrail context, queues
remediation tasks for human approval, and executes safe actions autonomously.

Two capabilities:
- **Triage Agent** — chat-based investigation and remediation (MVP)
- **ATO Assist** — NIST 800-53 Rev 5 compliance report generation (in progress)

Full design specs in `docs/`:
- `docs/triage-agent-design.md`
- `docs/ato-assist-design.md`

---

## Triage Agent — MVP Scope

- Single user (one analyst)
- Chat UI — ask the agent to investigate findings
- Task queue panel — agent surfaces intended actions with rationale
- Approve / Reject tasks in the UI
- Two autonomous actions only: enable S3 access logging, tag_resource (apply required tags)
- Real Security Hub findings (no mock data in prod)
- GuardDuty + CloudTrail enrichment on demand
- Agent greets analyst on chat open, then investigates on demand

### Out of scope for MVP
- Email notifications and reply-based approval
- Multi-user and role-based approval
- Auto-approval / timeout approval
- Scheduled or proactive monitoring
- EBS / RDS encryption (requires disruptive snapshot flow)
- Any Tier 2 or Tier 3 destructive actions

---

## ATO Assist — Scope

- Pulls NIST 800-53 Rev 5 findings from Security Hub
- Uses Bedrock to generate control implementation statements, risk assessments, POA&M entries
- Async job pattern: POST /ato/generate → jobId → poll GET /ato/status/{jobId}
- Results stored as JSON in S3, job lifecycle tracked in DynamoDB (AtoJobsTable)
- New route /ato in existing React frontend
- Reuses existing API Gateway and Cognito authorizer

---

## Stack

### Frontend
- React + Vite
- Panels: Task Queue (left) + Chat (right) + ATO (/ato route)
- Cognito JS SDK for auth
- Hosted on S3 + CloudFront
- All config injected at build time from SSM via deploy-frontend.sh

### Backend
- Node.js Lambda (Express-style) — thin API layer only, no agent logic
- Validates Cognito JWT on every request
- Chat uses async pattern: POST /chat → 202 + request_id → GET /chat/result/:id (polls until done)
- Lambda invokes itself asynchronously to work around API Gateway's 29s timeout
- Handles task queue CRUD against DynamoDB (approve, reject, dismiss via DELETE)
- Task write actions are separate from Execution Lambda trigger (stream-based)

### Agent
- AWS Bedrock AgentCore — owns the agent loop, memory, tool execution
- Claude Sonnet on Bedrock (cross-region inference profile)
- Read-only AWS access (Security Hub, GuardDuty, Config, CloudTrail, IAM, Cost Explorer, Access Analyzer)
- Write access to DynamoDB only (queue_task and cancel_task tools)
- NEVER executes AWS actions directly

### Execution Lambda
- Separate function, separate IAM role
- Only triggered by DynamoDB stream on status: PENDING → APPROVED
- Only two actions: enable_s3_logging, tag_resource
- Tags every resource it touches: security-agent-action: true + timestamp

### ATO Trigger Lambda
- Handles POST /ato/generate and GET /ato/status/{jobId}
- Creates job record in AtoJobsTable (DynamoDB), returns jobId immediately
- Generates presigned S3 URL when job is COMPLETED
- Marks jobs stuck in IN_PROGRESS beyond timeout as FAILED

### ATO Worker Lambda
- Triggered by DynamoDB Streams INSERT on AtoJobsTable
- Calls SecurityHub GetFindings (NIST 800-53 Rev 5 standard)
- Calls Bedrock InvokeModel to generate narratives per control family
- Writes structured JSON report to S3 (AtoReportsBucket)
- Updates job status to COMPLETED or FAILED

### Data
- DynamoDB `security-triage-tasks` — triage task queue
- DynamoDB `security-triage-ato-jobs` — ATO job lifecycle
- S3 `security-triage-access-logs-{account}-{region}` — S3 access logs from remediation
- S3 `security-triage-ato-reports-{account}-{region}` — ATO JSON reports (90-day lifecycle)

### Infrastructure
- AWS CDK (TypeScript)
- WAF — OWASP rules + rate limiting on API Gateway
- CloudWatch — 90-day log retention, agent audit trail
- Bedrock model access via IAM only (bedrock:InvokeModel) — no API key needed
- All deploy-time outputs written to SSM Parameter Store — no cdk-outputs.json parsing in CI

---

## Architecture rules — never violate these

1. The agent IAM role has ZERO write permissions to AWS services
2. Only the Execution Lambda writes to AWS resources (S3, resource tags)
3. The agent's only write actions are queue_task (PutItem) and cancel_task (UpdateItem PENDING→CANCELLED) → DynamoDB only
4. Every autonomous action must leave a tag on the resource
5. Execution Lambda is only triggered by an APPROVED task in DynamoDB
6. No AWS credentials ever reach the browser
7. All browser → AWS traffic goes through API Lambda
8. Cognito JWT must be validated before any DynamoDB or Bedrock call
9. ATO Worker Lambda writes to S3 only — never directly to any resource under investigation

---

## Task queue model

Tasks flow through these states only:
```
PENDING → APPROVED → EXECUTED
PENDING → REJECTED  → DISMISSED  (analyst clears from UI)
PENDING → CANCELLED              (agent retracts via cancel_task)
           FAILED   → DISMISSED  (analyst clears from UI)
```

### Task record shape (DynamoDB — security-triage-tasks)
```json
{
  "task_id": "uuid",
  "status": "PENDING | APPROVED | REJECTED | EXECUTED | FAILED | CANCELLED | DISMISSED",
  "finding_id": "SH-2024-001",
  "resource_id": "arn:aws:s3:::bucket-name",
  "action": "enable_s3_logging | tag_resource",
  "action_params": "{\"Environment\":\"prod\",\"Owner\":\"team-security\",\"Project\":\"payments\"}",
  "rationale": "why the agent wants to do this",
  "risk_tier": 1,
  "created_at": "ISO8601",
  "approved_at": "ISO8601 or null",
  "approved_by": "email or null",
  "executed_at": "ISO8601 or null",
  "result": "success message or error"
}
```

### ATO job record shape (DynamoDB — security-triage-ato-jobs)
```json
{
  "jobId": "job_abc123",
  "username": "analyst@example.com",
  "status": "PENDING | IN_PROGRESS | COMPLETED | FAILED",
  "startTime": "ISO8601",
  "endTime": "ISO8601 or null",
  "ttl": 1744200000,
  "error": null,
  "resultS3Key": "ato-reports/analyst@example.com/job_abc123.json"
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
get_iam_analysis        → IAM GetAccountSummary + GetCredentialReport + ListUsers
get_access_analyzer     → AccessAnalyzer ListAnalyzers + ListFindings
get_cost_analysis       → CostExplorer GetCostAndUsage + GetAnomalies
queue_task              → DynamoDB PutItem (queue a remediation task)
cancel_task             → DynamoDB UpdateItem PENDING→CANCELLED (retract a queued task)
get_task_queue          → DynamoDB Query (read pending/recent tasks)
```

Required tag keys are stored in SSM at `/security-triage/required-tag-keys` as a JSON array.
Default: `["Environment","Owner","Project"]`. Edit the parameter to change the policy without redeploying.

---

## SSM Parameters

All outputs written by CDK at deploy time. No manual env vars or cdk-outputs.json needed.

```
/security-triage/cloudfront-url
/security-triage/cloudfront-distribution-id
/security-triage/frontend-bucket-name
/security-triage/user-pool-id
/security-triage/user-pool-client-id
/security-triage/api-url
/security-triage/cognito-domain
/security-triage/agent-id
/security-triage/agent-alias-id
/security-triage/required-tag-keys
```

---

## Project structure (target)

```
/
├── CLAUDE.md
├── docs/
│   ├── triage-agent-design.md     ← full triage agent design spec
│   └── ato-assist-design.md       ← full ATO assist design spec
├── cdk/
│   ├── bin/app.ts
│   ├── lib/
│   │   ├── security-triage-stack.ts   ← Cognito, DynamoDB, API Lambda, Execution Lambda, API GW, WAF
│   │   ├── agent-stack.ts             ← Bedrock Agent, Agent Tools Lambda
│   │   └── frontend-stack.ts          ← S3 + CloudFront
│   └── package.json
├── lambda/
│   ├── api/                    ← Node.js API layer (triage chat + task queue)
│   │   ├── index.ts
│   │   ├── auth.ts
│   │   ├── chat.ts
│   │   └── tasks.ts
│   ├── execution/              ← Execution Lambda (enable_s3_logging, tag_resource)
│   │   ├── index.ts
│   │   ├── enable-logging.ts
│   │   └── apply-tags.ts
│   ├── agent-tools/            ← Bedrock action group (all agent tools)
│   │   └── index.ts
│   ├── agent-prepare/          ← Custom Resource Lambda (PrepareAgent on deploy)
│   │   └── index.ts
│   ├── ato-trigger/            ← ATO API handler (create job, poll status)
│   │   └── index.ts
│   └── ato-worker/             ← ATO background processor (SecurityHub → Bedrock → S3)
│       └── index.ts
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Chat.tsx
│   │   │   ├── TaskQueue.tsx
│   │   │   └── AtoAssist.tsx
│   │   └── lib/
│   │       ├── auth.ts
│   │       └── api.ts
│   └── package.json
├── deploy.sh                   ← full deploy: CDK (two-pass) + frontend
├── deploy-frontend.sh          ← frontend-only redeploy (reads config from SSM)
└── .claude/
    ├── settings.json
    ├── commands/
    └── hooks/
```

---

## Commands to know

```bash
# Full deploy (infra + frontend)
./deploy.sh [--profile myprofile] [--region us-east-1] [--env prod]

# Frontend-only redeploy (no CDK)
./deploy-frontend.sh [--profile myprofile]

# CDK (manual)
cd cdk && npm run build && cdk diff
cd cdk && cdk deploy --all

# Lambda builds
cd lambda/api && npm run build
cd lambda/execution && npm run build
cd lambda/agent-tools && npm run build
cd lambda/ato-trigger && npm run build
cd lambda/ato-worker && npm run build

# Frontend (local dev)
cd frontend && npm run dev
cd frontend && npm run build
```

---

## What good looks like

### Triage Agent — six scenarios must all work end to end

1. Analyst opens chat → agent greets and lists capabilities → analyst asks about findings → agent returns plain-English summary
2. Agent queues enable_s3_logging task → analyst approves → S3 logging enabled → task shows EXECUTED
3. Agent queues tag_resource task → analyst approves → tags applied → task shows EXECUTED
4. Analyst asks "what have you queued?" → agent returns clear summary of pending tasks with rationale
5. Agent cancels a PENDING task it queued in error → task moves to CANCELLED
6. Analyst dismisses a FAILED or REJECTED task → row disappears from activity list

### ATO Assist — three scenarios must all work end to end

1. Analyst clicks Generate → job created → polling starts → report appears with summary card + control family accordions + POA&M tables
2. Worker failure (e.g. Bedrock error) → job moves to FAILED → analyst sees error state in UI
3. Analyst generates a second report → previous job history visible, new report replaces display
