# Security Triage Agent — Design Specification

## Feature Overview
An AI-powered security operations assistant for AWS environments. A single analyst
chats with the agent to investigate Security Hub findings. The agent enriches findings
with GuardDuty, Config, and CloudTrail context, surfaces remediation tasks for human
approval, and executes safe actions autonomously after the analyst approves them.

## MVP Scope
- Single analyst user
- Chat UI — ask the agent to investigate findings in plain English
- Task queue panel — agent surfaces intended actions with rationale before acting
- Approve / Reject tasks in the UI
- Two autonomous actions only: enable_s3_logging, tag_resource
- Real Security Hub findings (no mock data in prod)
- GuardDuty + CloudTrail enrichment on demand
- Agent greets analyst on chat open, then investigates on demand

## Out of Scope for MVP
- Email notifications and reply-based approval
- Multi-user and role-based approval
- Auto-approval / timeout approval
- Scheduled or proactive monitoring
- EBS / RDS encryption (requires disruptive snapshot flow)
- Any Tier 2 or Tier 3 destructive actions

---

## Architecture

### Request Flow
```
Browser → CloudFront → API Gateway → API Lambda → Bedrock Agent
                                         ↓                ↓
                                      DynamoDB        Agent Tools Lambda
                                      (task queue)    (SecurityHub, GuardDuty,
                                                       Config, CloudTrail, DynamoDB)

DynamoDB Stream (status=APPROVED) → Execution Lambda → AWS Resources
```

### Async Chat Pattern
API Gateway has a 29-second timeout. Bedrock multi-tool calls can take longer.
- `POST /chat` → API Lambda validates JWT, invokes itself asynchronously, returns `202 + request_id`
- `GET /chat/result/{request_id}` → client polls until result is ready (stored in DynamoDB with 2-hour TTL)

---

## Stack

### Frontend
- React + Vite, hosted on S3 + CloudFront (OAC, HTTPS-only, TLS 1.2+)
- Two panels: Task Queue (left) + Chat (right)
- Cognito JS SDK for auth (SRP flow, TOTP MFA, code grant)
- All config injected at build time from SSM via deploy-frontend.sh (no .env.local needed in CI)

### API Lambda (security-triage-api)
- Node.js 22, ARM64
- Validates Cognito JWT on every request before touching DynamoDB or Bedrock
- Handles: POST /chat, GET /chat/result/{id}, GET /tasks, POST /tasks,
  POST /tasks/{id}/approve, POST /tasks/{id}/reject, DELETE /tasks/{id}
- Write access to DynamoDB only — zero write access to AWS services

### Bedrock Agent (security-triage-agent)
- Claude Sonnet 4.5 via US cross-region inference profile
- Owns the agent loop, tool execution, and session memory (30-minute idle TTL)
- System prompt defines role, available tools, rules, and communication style
- NEVER executes AWS actions directly — only writes to DynamoDB via queue_task

### Agent Tools Lambda (security-triage-agent-tools)
- Executes all agent tools as a Bedrock action group
- Read-only AWS access: SecurityHub, GuardDuty, Config, CloudTrail, ResourceGroupsTaggingAPI,
  IAM, Cost Explorer, Access Analyzer
- Write access: DynamoDB PutItem (queue_task) + UpdateItem (cancel_task) only
- Explicit DENY on DynamoDB DeleteItem

### Execution Lambda (security-triage-execution)
- Separate function, separate IAM role
- ONLY triggered by DynamoDB stream filter: status = APPROVED
- ONLY two actions: enable_s3_logging, tag_resource
- Tags every resource it touches: security-agent-action=true + timestamp
- Explicit DENY on destructive S3 actions (DeleteBucket, DeleteObject, PutBucketPolicy, PutBucketAcl)

### Data
- DynamoDB `security-triage-tasks` — task queue (PAY_PER_REQUEST, Streams enabled)
- GSI `status-index` (PK=status, SK=created_at) — for listing tasks by state
- DynamoDB stores async chat results with 2-hour TTL
- S3 `security-triage-access-logs-{account}-{region}` — receives logs from enable_s3_logging action

---

## Agent Tools

| Tool | AWS APIs | Write? |
|------|----------|--------|
| get_findings | SecurityHub GetFindings | No |
| get_threat_context | GuardDuty ListFindings, GetFindings | No |
| get_config_status | Config DescribeComplianceByResource | No |
| get_trail_events | CloudTrail LookupEvents | No |
| get_tag_compliance | ResourceGroupsTaggingAPI GetResources | No |
| get_enabled_standards | SecurityHub GetEnabledStandards, DescribeStandards | No |
| get_compliance_report | SecurityHub DescribeStandardsControls, GetFindings | No |
| get_iam_analysis | IAM GetAccountSummary, GetCredentialReport, ListUsers | No |
| get_access_analyzer | AccessAnalyzer ListAnalyzers, ListFindings | No |
| get_cost_analysis | CostExplorer GetCostAndUsage, GetAnomalies | No |
| queue_task | DynamoDB PutItem | **Yes** |
| cancel_task | DynamoDB UpdateItem (PENDING→CANCELLED only) | **Yes** |
| get_task_queue | DynamoDB Query | No |

Required tag keys are stored in SSM at `/security-triage/required-tag-keys` as a JSON array.
Default: `["Environment","Owner","Project"]`. Edit without redeploying.

---

## Task Queue

### State Machine
```
PENDING → APPROVED → EXECUTED
PENDING → REJECTED → DISMISSED   (analyst clears from UI)
PENDING → CANCELLED              (agent retracts via cancel_task)
          FAILED   → DISMISSED   (analyst clears from UI)
```

### Task Record Shape (DynamoDB)
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

### Action Tiers
- **Tier 1 (MVP)** — agent queues, analyst approves in UI, Execution Lambda acts
  - enable_s3_logging
  - tag_resource
- **Tier 2 (post-MVP)** — senior analyst approval required (not built)
- **Tier 3 (post-MVP)** — out-of-band approval required (not built)

---

## IAM Summary

| Role | Key Permissions |
|------|----------------|
| security-triage-api-lambda | DynamoDB CRUD, bedrock:InvokeAgent, lambda:InvokeFunction (self), ssm:GetParameter |
| security-triage-agent-tools-lambda | SecurityHub/GuardDuty/Config/CloudTrail read, DynamoDB PutItem+UpdateItem+Query, DENY DeleteItem |
| security-triage-execution-lambda | DynamoDB stream+UpdateItem, S3 logging+tagging, DENY destructive S3 |
| security-triage-agentcore | bedrock:InvokeModel, CloudWatch logs (agent audit group only) |

---

## Architecture Rules — Never Violate
1. The agent IAM role has ZERO write permissions to AWS services
2. Only the Execution Lambda writes to AWS resources
3. The agent's only write actions are queue_task (PutItem) and cancel_task (UpdateItem) → DynamoDB only
4. Every autonomous action must leave a tag on the resource
5. Execution Lambda is only triggered by an APPROVED task in DynamoDB
6. No AWS credentials ever reach the browser
7. All browser → AWS traffic goes through API Lambda
8. Cognito JWT must be validated before any DynamoDB or Bedrock call

---

## Infrastructure

### CDK Stacks
| Stack | Contents |
|-------|----------|
| SecurityTriageFrontendStack | S3 bucket, CloudFront distribution |
| SecurityTriageStack | Cognito, DynamoDB, API Lambda, Execution Lambda, API Gateway, WAF, S3 access logs bucket |
| SecurityTriageAgentStack | Bedrock Agent, Agent Tools Lambda, Agent Prepare Lambda, IAM roles |

### WAF (REGIONAL, on API Gateway)
- AWSManagedRulesCommonRuleSet (OWASP)
- AWSManagedRulesKnownBadInputsRuleSet (Log4Shell, SSRF)
- Rate limit: 500 requests / 5 minutes / IP

### SSM Parameters (written by CDK, read by deploy scripts and Lambdas)
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

## MVP Acceptance Criteria

All six scenarios must work end to end:

1. Analyst opens chat → agent greets and lists capabilities → analyst asks about findings → agent returns plain-English summary
2. Agent queues enable_s3_logging task → analyst approves → S3 logging enabled → task shows EXECUTED
3. Agent queues tag_resource task → analyst approves → tags applied → task shows EXECUTED
4. Analyst asks "what have you queued?" → agent returns clear summary of pending tasks with rationale
5. Agent cancels a PENDING task it queued in error → task moves to CANCELLED
6. Analyst dismisses a FAILED or REJECTED task → row disappears from activity list
