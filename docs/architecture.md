# Security Triage Agent — Architecture

A provider-neutral description of how the system is structured. No vendor names appear in the main sections — only in the [Implementation Reference](#implementation-reference) at the bottom.

---

## Capabilities

The platform delivers three capabilities over a shared auth and API layer:

| Capability | Purpose |
|---|---|
| **Triage Agent** | Chat-based security investigation. An AI agent reads security findings and surfaces recommended remediation actions. A human analyst approves or rejects each action before anything executes. |
| **ATO Assist** | One-shot compliance report generation. Pulls security findings, generates NIST 800-53 control narratives via an LLM, and returns a structured report. |
| **Compliance Workspace** | Full NIST RMF 7-step workflow. Generates and tracks SSP, SAR, RA, POA&M, ConMon, and IRP documents per system. |

---

## System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  Web Client  (Single-Page Application)                           │
│  Served from CDN — no server-side rendering                      │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           │  HTTPS  +  Bearer Token (JWT)
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  API Layer                                                       │
│                                                                  │
│  • Validates every request against the Identity Provider         │
│  • Single entry point for all browser traffic                    │
│  • No cloud credentials ever reach the browser                   │
│  • Returns job IDs for long-running operations (see async        │
│    pattern below) — never blocks waiting for AI responses        │
└──────┬───────────────────┬──────────────────────────────────────┘
       │                   │
       ▼                   ▼
┌─────────────┐   ┌────────────────────────────────────────────────┐
│  Identity   │   │  State Store  (Database)                       │
│  Provider   │   │                                                │
│             │   │  Three logical tables:                         │
│  Issues and │   │  • Task Queue  — remediation tasks +           │
│  validates  │   │    approval workflow state                     │
│  JWT tokens │   │  • Job Registry — async job lifecycle          │
│             │   │  • Document Registry — compliance docs +       │
│             │   │    system metadata + FIPS 199 ratings          │
└─────────────┘   └──────────────────┬─────────────────────────────┘
                                     │
                                     │  Event Stream
                                     │  (record written → event fires)
                                     ▼
                  ┌────────────────────────────────────────────────┐
                  │  Worker Tier  (Background Processors)          │
                  │                                                │
                  │  ┌───────────────────────────────────────┐    │
                  │  │  Remediation Executor                 │    │
                  │  │  Triggered when a task is APPROVED    │    │
                  │  │  Only actor with write access to      │    │
                  │  │  cloud resources                      │    │
                  │  └───────────────────────────────────────┘    │
                  │                                                │
                  │  ┌───────────────────────────────────────┐    │
                  │  │  Report Worker  (ATO Assist)          │    │
                  │  │  Triggered on new job record          │    │
                  │  │  Reads findings → calls LLM →         │    │
                  │  │  writes report to Object Store        │    │
                  │  └───────────────────────────────────────┘    │
                  │                                                │
                  │  ┌───────────────────────────────────────┐    │
                  │  │  Document Worker  (Compliance)        │    │
                  │  │  Triggered on PENDING document record │    │
                  │  │  Calls LLM per control family →       │    │
                  │  │  writes document to Object Store      │    │
                  │  └───────────────────────────────────────┘    │
                  │                                                │
                  │  ┌───────────────────────────────────────┐    │
                  │  │  Repair Worker                        │    │
                  │  │  Runs on a schedule (every 5 min)     │    │
                  │  │  Marks stuck IN_PROGRESS jobs FAILED  │    │
                  │  └───────────────────────────────────────┘    │
                  └──────────────────┬─────────────────────────────┘
                                     │
                         ┌───────────┴──────────┐
                         ▼                      ▼
             ┌──────────────────┐   ┌────────────────────┐
             │  LLM / AI Engine │   │  Object Store      │
             │                  │   │  (File Storage)    │
             │  • Agent loop    │   │                    │
             │    (Triage)      │   │  • ATO reports     │
             │  • Narrative     │   │  • Compliance docs │
             │    generation    │   │  • Access logs     │
             │    (ATO +        │   │                    │
             │    Compliance)   │   │  Versioned.        │
             └──────────────────┘   │  Not public.       │
                                    │  Accessed via      │
                                    │  short-lived       │
                                    │  signed URLs.      │
                                    └────────────────────┘
```

---

## Core Patterns

### 1. Authentication Flow

Every request from the browser carries a JWT issued by the Identity Provider. The API Layer validates the token on every call — no request reaches the database or storage without a valid token.

```
Browser ──login──▶ Identity Provider ──JWT──▶ Browser
Browser ──request + JWT──▶ API Layer ──validate──▶ Identity Provider
                                  │
                              (if valid)
                                  │
                                  ▼
                            process request
```

The web client itself is a static bundle (HTML + JS + CSS) served from a CDN with no secrets baked in. All configuration (API URL, auth client ID) is injected at build time from environment variables. No credentials ever reach the browser.

---

### 2. Human-in-the-Loop Approval

The AI agent **cannot write to any cloud resource directly**. It can only append task records to the state store. A human analyst reviews each task in the UI and explicitly approves or rejects it. Only after approval does the Remediation Executor act.

```
AI Agent ──append──▶ Task (PENDING)
                          │
                    Analyst reviews
                          │
              ┌───────────┴────────────┐
           Approve                  Reject
              │                        │
              ▼                        ▼
        Task (APPROVED)          Task (REJECTED)
              │
        Event fires
              │
              ▼
     Remediation Executor
     (separate process, separate identity, minimal write scope)
              │
              ▼
        Task (EXECUTED)
```

This pattern separates *intent* (the AI deciding what should happen) from *execution* (a constrained process with a narrow permission boundary). Replacing the AI model or the API layer does not change the executor's permissions.

---

### 3. Async Job Pattern

Operations that take more than a few seconds (LLM calls, document generation) use a request/poll pattern. The API Layer returns a job ID immediately; the client polls until the job reaches a terminal state.

```
Client                 API Layer              Worker
  │                        │                     │
  ├──POST /generate────────▶│                     │
  │                        ├──write job: PENDING──▶
  │◀──202 { jobId }────────┤                     │
  │                        │      event fires    │
  │                        │                     ├──call LLM
  ├──GET /status/{jobId}───▶│                     │
  │◀──{ status: IN_PROGRESS}┤                     │
  │                        │                     ├──write: COMPLETED
  ├──GET /status/{jobId}───▶│                     │
  │◀──{ status: COMPLETED }─┤                     │
  │◀──signed URL to result──┤                     │
```

The state store record is the source of truth. The API Layer never caches job state.

---

### 4. Event-Driven Worker Dispatch

Workers are not called directly by the API Layer. The API Layer writes a record with a trigger status; workers subscribe to the resulting event stream. This decouples the API from the worker implementation — workers can be replaced, scaled, or added without changing the API layer.

```
API Layer ──write PENDING──▶ State Store ──event──▶ Worker
```

**Fault tolerance:** A dead-letter queue catches worker failures after retries. The Repair Worker scans on a schedule for records stuck in IN_PROGRESS beyond a timeout and marks them FAILED, keeping the UI consistent with reality.

---

### 5. Document Access Pattern

Compliance documents are stored in the Object Store, not in the database. The database holds only metadata (status, timestamps, storage key). Documents are never served directly — the API Layer generates a short-lived signed URL after validating the JWT, and the browser fetches from that URL directly.

```
Browser ──GET /documents/{type}──▶ API Layer
                                       │ validate JWT
                                       │ read metadata from State Store
                                       │ generate signed URL (60s TTL)
                                       ▼
                                  return { signedUrl }
                                       │
Browser ──GET signedUrl──────────────▶ Object Store
                                       │
                                  return document bytes
```

---

## Data Model (Logical)

### Task Queue

Tracks remediation actions from creation through execution.

```
task_id        unique identifier
status         PENDING | APPROVED | REJECTED | EXECUTED | FAILED | CANCELLED | DISMISSED
action         the operation to perform (e.g. enable_logging, tag_resource)
action_params  parameters for the action (JSON)
resource_id    the target resource
rationale      why the agent recommended this action
risk_tier      1 = low risk, 2 = medium, 3 = high (only tier 1 is automated)
created_at     ISO 8601
approved_by    identity of approving analyst (or null)
executed_at    ISO 8601 (or null)
result         outcome message (or null)
```

State transitions:

```
PENDING ──approve──▶ APPROVED ──execute──▶ EXECUTED
PENDING ──reject───▶ REJECTED ──dismiss──▶ DISMISSED
PENDING ──cancel───▶ CANCELLED
         FAILED   ──dismiss──▶ DISMISSED
```

### Job Registry

Tracks async LLM jobs (ATO Assist).

```
job_id       unique identifier
status       PENDING | IN_PROGRESS | COMPLETED | FAILED
started_at   ISO 8601
ended_at     ISO 8601 (or null)
storage_key  path to result in Object Store (set on COMPLETED)
error        failure message (or null)
```

### Document Registry

Tracks compliance documents and system metadata (Compliance Workspace).

```
system_id           unique identifier for the system under assessment
document_type       SSP | SAR | RA | POAM | CONMON | IRP | FIPS199
status              PENDING | IN_PROGRESS | COMPLETED | FAILED
generation_id       ties a poll request to a specific generation run
generation_started  ISO 8601 (set when worker picks up the job)
updated_at          ISO 8601 (set on COMPLETED or FAILED)
storage_key         path to document in Object Store (set on COMPLETED)
error               failure message (or null)
```

---

## Security Boundaries

```
PUBLIC ZONE
  Browser ◀──▶ CDN  ◀──▶  API Layer
                                │
                                │ (JWT validated — all traffic below is internal)
                                │
PRIVATE ZONE (no direct inbound from internet)
                                │
              ┌─────────────────┼────────────────────┐
              │                 │                    │
        State Store         LLM Engine          Object Store
              │
        Event Stream
              │
           Workers
```

- The AI engine is accessed using the platform's native identity mechanism (IAM roles, managed identities, service accounts) — **no API keys in environment variables or source code**
- The Object Store blocks all public access; every document download goes through the API Layer
- Workers are not reachable over HTTP — they are triggered only by events from the state store stream

---

## Implementation Reference

The table below maps each logical component to the reference implementation (AWS) and common alternatives on other platforms.

| Component | Role | AWS (reference) | Azure | GCP | Self-hosted |
| --- | --- | --- | --- | --- | --- |
| CDN + Static Host | Serve the SPA | S3 + CloudFront | Static Web Apps | Firebase Hosting | Nginx |
| Identity Provider | Issue + validate JWTs | Cognito | Entra ID / B2C | Identity Platform | Keycloak, Auth0 |
| API Layer | Backend entry point, JWT validation | Lambda + API Gateway | App Service / Functions | Cloud Run | Express, FastAPI |
| State Store | Database for tasks, jobs, docs | DynamoDB | Cosmos DB | Firestore | PostgreSQL, MongoDB |
| Event Stream | Trigger workers on state change | DynamoDB Streams | Cosmos DB Change Feed | Firestore Triggers | Debezium + Kafka |
| Dead-letter Queue | Catch worker failures | SQS DLQ | Service Bus | Pub/Sub | RabbitMQ |
| Scheduler | Run repair worker on a cron | EventBridge Scheduler | Logic Apps | Cloud Scheduler | Cron, Temporal |
| LLM / AI Engine | Generate narratives + run agent loop | Bedrock (Claude) | Azure OpenAI | Vertex AI | Ollama, vLLM |
| Object Store | Store reports and documents | S3 | Blob Storage | GCS | MinIO |
| Infrastructure as Code | Provision and deploy everything | CDK (TypeScript) | Bicep | Deployment Manager | Terraform, Pulumi |

---

## Agent Tier — Implementation

Only the **Triage Agent** capability runs an agent loop (assemble prompt → call model → run tool
→ repeat). ATO Assist and the Compliance Workspace are single-shot `InvokeModel` calls, not
agents, and are unaffected by anything in this section.

### Two layers

```
┌─ FRAMEWORK ─ the loop code ────────────────────────────┐
│  Strands Agents SDK (TypeScript)                       │
│  • tools = strands.tool() + Zod schema                 │
│  • calls the model, runs assemble → call → tool loop   │
│  • session state, streaming, multi-agent               │
└───────────────────────────┬───────────────────────────┘
                            │ runs on
                            ▼
┌─ HOSTING ─ where that code executes ───────────────────┐
│  AgentCore Runtime — serverless microVM, $0 idle,      │
│  8h sessions, per-session isolation, streaming         │
└───────────────────────────────────────────────────────┘
```

### Current implementation — Strands on AgentCore Runtime

`bedrock-agentcore:InvokeAgentRuntime` is called once per analyst message; the Strands agent
(`agent/` — a container, not a Lambda) runs the loop and calls `agent-tools/` for every tool
(`{ tool, input }` → `{ body }`). `cdk/lib/agent-stack.ts` deploys the Runtime + the agent-tools
Lambda; the async proxy in `lambda/api/chat.ts` bridges API Gateway's 29s limit.

Migrated 2026-09 from **classic Bedrock Agents**, which entered maintenance mode 2026-07-30
(closed to new customers, model catalog frozen, no EOL announced) and constrained the system
before that: a 10-functions-per-action-group ceiling, no streaming, session-only memory, and a
`PrepareAgent`/`configVersion` step on every prompt or schema change. None of that applies now.

The agent loop was the **only** thing that changed. The intent/execution boundary (§2), the
task-queue state machine, the Execution Lambda, the API layer's routes/auth, and both
`InvokeModel` workers were framework-independent and untouched by the migration.

The full history — phased plan, change list, IAM diff, and the create-time bugs hit along the
way — lives in [`agent-migration-plan.md`](agent-migration-plan.md), kept for reference and as
the template for the next agent-tier change (Gateway, Memory, or streaming — see that doc's
Phase 2).

### AWS pricing reference (verified 2026-09-09)

| Item | Rate |
| --- | --- |
| AgentCore Runtime — CPU | $0.0895 / vCPU-hour (active compute only; $0 while idle / in I/O wait) |
| AgentCore Runtime — memory | $0.00945 / GB-hour |
| AgentCore Memory — short-term | $0.25 / 1,000 events |
| AgentCore Memory — long-term storage (built-in) | $0.75 / 1,000 records / month |
| AgentCore Memory — long-term retrieval | $0.50 / 1,000 retrievals |
| AgentCore Gateway — API invocations | $0.005 / 1,000 |
| AgentCore Gateway — search API | $0.025 / 1,000 |
| AgentCore Gateway — tool indexing | $0.02 / 100 tools / month |
| AgentCore Identity | $0.01 / 1,000 token requests — free via Runtime or Gateway |

At single-analyst MVP volume the AgentCore surcharge is a few dollars a month; model-inference
spend dominates and is identical to the Classic setup. `cdk destroy` on the agent stack reverts
at any point.
