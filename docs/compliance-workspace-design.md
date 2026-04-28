# Compliance Workspace — Architecture Design

> **Status**: In progress — decisions locked as of OMI-68 design session
> **Framework scope**: NIST 800-53 Rev 5 (MVP). PCI DSS, SOC 2 grayed out in UI, field exists from day one.

---

## Core decisions (do not revisit)

- Top-level entity is **System**, not ATO Package
- MVP is **single-system, single AWS account** — no system creation UI
- System METADATA record written to DynamoDB at deploy time via CDK Custom Resource
- URL routing is `/systems/:id/...` from day one (future multi-system support)
- Agent chat is a **resizable drawer** — collapsed by default, opens from a persistent topbar button, expandable to full-screen
- Settings contains only: system name, owner name, owner email, AWS account ID, region
- **FIPS 199** lives in the compliance workspace as the System Categorization document card — not in settings

---

## Data model

### DynamoDB — `security-triage-systems` (new table)

Single table, composite key.

| pk | sk | Description |
| --- | --- | --- |
| `SYSTEM#{id}` | `METADATA` | System name, owner, AWS account, region |
| `SYSTEM#{id}` | `DOC#NIST#FIPS199` | FIPS 199 C/I/A values + computed overall impact |
| `SYSTEM#{id}` | `DOC#NIST#POAM` | POA&M metadata (status, s3Key, lastGeneratedAt) |
| `SYSTEM#{id}` | `DOC#NIST#SSP` | SSP metadata |
| `SYSTEM#{id}` | `DOC#NIST#SAR` | SAR metadata |
| `SYSTEM#{id}` | `DOC#NIST#RA` | Risk Assessment metadata |
| `SYSTEM#{id}` | `DOC#NIST#CONMON` | ConMon Plan metadata |
| `SYSTEM#{id}` | `DOC#NIST#IRP` | IRP metadata |

**Metadata only in DynamoDB.** Full document content lives in S3, referenced by `s3Key`.

DynamoDB Streams enabled (`NEW_AND_OLD_IMAGES`). The compliance worker is triggered by stream events where `sk` begins with `DOC#NIST#` and `status = PENDING`. FIPS 199 never triggers the worker — it is written synchronously by the API Lambda.

#### Document record shape

```json
{
  "pk": "SYSTEM#default",
  "sk": "DOC#NIST#SSP",
  "status": "PENDING | IN_PROGRESS | COMPLETED | FAILED",
  "generationId": "uuid",
  "s3Key": "compliance/default/NIST/SSP/current.json",
  "lastGeneratedAt": "ISO8601 or null",
  "generatedBy": "analyst@example.com",
  "error": "string or null"
}
```

#### FIPS 199 record shape

```json
{
  "pk": "SYSTEM#default",
  "sk": "DOC#NIST#FIPS199",
  "confidentiality": "Low | Moderate | High",
  "integrity":       "Low | Moderate | High",
  "availability":    "Low | Moderate | High",
  "overallImpact":   "Low | Moderate | High",
  "updatedAt": "ISO8601",
  "updatedBy": "analyst@example.com"
}
```

`overallImpact` is computed by the API Lambda (highest of C/I/A per FIPS 199 rules) before writing.

#### System METADATA record shape

```json
{
  "pk": "SYSTEM#default",
  "sk": "METADATA",
  "systemName": "string",
  "ownerName": "string",
  "ownerEmail": "string",
  "awsAccountId": "string",
  "region": "string"
}
```

---

## S3 — `security-triage-compliance-{account}-{region}` (new bucket)

**S3 Versioning enabled.** Fixed key per document type — S3 manages version history.

```
compliance/{systemId}/NIST/SSP/current.json     ← always overwritten on regeneration
compliance/{systemId}/NIST/POAM/current.json
compliance/{systemId}/NIST/SAR/current.json
...
```

**Lifecycle policy:**
- Non-current versions: expire after 90 days
- Current version: expire after 7 years (compliance retention)

CORS enabled for GET (browser fetches via presigned URL). No public access.

**Presigned URL TTL**: 1 hour. A fresh presigned URL is returned on every status poll while the document is COMPLETED.

---

## Document types

| Document | Execution | Primary source | Secondary source |
| --- | --- | --- | --- |
| System Categorization (FIPS 199) | Sync — API Lambda writes directly | User input (3 dropdowns) | — |
| POA&M | Async + polling | SecurityHub GetFindings (NIST 800-53) | — |
| SSP | Async + polling | SecurityHub + Config resource inventory | IAM summary, FIPS 199 from DynamoDB |
| SAR | Async + polling | SecurityHub GetFindings | GuardDuty (optional) |
| Risk Assessment | Async + polling | SecurityHub + GuardDuty | AccessAnalyzer |
| ConMon Plan | Async + polling | SecurityHub (standards + findings summary + integrations) | — |
| IRP | Async + polling | SecurityHub (incident-type findings) | System METADATA (contacts) |

**Key rule**: no generator reads another generator's S3 output. Every document is independently regenerable from live AWS data. Exception: SSP reads the FIPS 199 record from DynamoDB (3 field values, lightweight GetItem — not an S3 dependency).

Order of generation does not matter.

---

## Execution model — async + polling (production-grade)

All document types except FIPS 199 use the same pattern:

```
POST /systems/:id/documents/:type/generate
  → API Lambda
    → DynamoDB UpdateItem: status=PENDING, generationId=uuid
      ConditionExpression: status <> IN_PROGRESS   (blocks double-submit)
    → 202 { status: "PENDING", generationId }

DynamoDB Stream → compliance-worker Lambda
  → markInProgress() — conditional write, idempotent against stream re-delivery
  → gather data from AWS APIs based on docType
  → Bedrock InvokeModel (one or more calls)
  → S3 PutObject to fixed key (versioning handles history)
  → DynamoDB UpdateItem: status=COMPLETED, s3Key, lastGeneratedAt

GET /systems/:id/documents/:type
  → returns status + fresh presigned URL if COMPLETED
  → if IN_PROGRESS + elapsed > 12 min → surface as FAILED (stuck detection)
```

### Production hardening (build from day one for compliance workspace)

| Concern | Implementation |
|---|---|
| Silent failures | SQS DLQ on compliance-worker event source. Recovery Lambda marks job FAILED in DynamoDB. |
| Retry behavior | `retryAttempts: 2`, `bisectBatchOnFunctionError: true` on event source mapping |
| Stuck jobs (tab closed) | EventBridge rule every 5 min → repair Lambda marks IN_PROGRESS jobs FAILED if elapsed > 12 min |
| Frontend polling | Exponential backoff (2s → 3s → 5s → 10s → 30s ceiling). Hard stop after 15 min. |
| Double-submit prevention | Conditional DynamoDB write on generate endpoint |
| Stale poll detection | `generationId` on every generation. Frontend tracks its own generationId. |

---

## API routes (added to existing `security-triage-api` Lambda)

```
GET    /systems/:id                              → read system metadata
PUT    /systems/:id/settings                     → update name / owner / account / region

GET    /systems/:id/documents                    → list all document metadata (no S3 content)
PUT    /systems/:id/documents/FIPS199            → sync save FIPS 199 (no worker triggered)
POST   /systems/:id/documents/:type/generate     → trigger async generation → 202
GET    /systems/:id/documents/:type              → status + presigned URL if COMPLETED
```

---

## Component placement

### Extend (existing Lambdas)

**`security-triage-api`**
- Add 6 compliance routes above
- New IAM: `dynamodb:*` on `security-triage-systems` table, `s3:GetObject` on compliance reports bucket (for presigning)
- New env vars: `SYSTEMS_TABLE_NAME`, `COMPLIANCE_BUCKET`

**`security-triage-agent-tools`**
- Add `get_document_status` tool: DynamoDB Query `pk=SYSTEM#{id}, sk begins_with DOC#NIST#`
- Returns array of `{ docType, status, lastGeneratedAt }` — no S3 content

### New

**`security-triage-compliance-worker`** (Lambda)
- Triggered by DynamoDB Streams on `security-triage-systems` table
- Stream filter: `status = PENDING` (FIPS 199 is never PENDING; it's written directly as a values record)
- Internal dispatch by `sk` value to the right generator function
- Timeout: 12 minutes. Memory: 1024MB.
- DLQ: `security-triage-compliance-worker-dlq` (SQS)
- IAM: see Lambda IAM section below

**`security-triage-systems`** (DynamoDB table)
- Composite key as described above
- Streams: `NEW_AND_OLD_IMAGES`
- TTL: not applicable (system records are permanent)
- PITR: enabled in prod

**`security-triage-compliance-{account}-{region}`** (S3 bucket)
- S3 Versioning enabled
- Lifecycle: non-current versions expire 90 days, current expires 7 years
- CORS: GET only, `*` origin (presigned URLs are IAM-signed)

**`security-triage-compliance-worker-dlq`** (SQS queue)
- Retention: 14 days
- Triggers recovery Lambda (or CloudWatch alarm on depth > 0)

**EventBridge rule** (stuck job detector)
- Schedule: every 5 minutes
- Target: repair Lambda (or inline in a lightweight function)
- Query: `security-triage-systems` table, GSI on status=IN_PROGRESS, filter elapsed > 12 min

### Unchanged

- `security-triage-execution` — triage remediation, untouched
- `security-triage-ato-trigger` — stays running, not extended, eventually deprecated
- `security-triage-ato-worker` — stays running, not extended, eventually deprecated
- `security-triage-agent-prepare`

### CDK deploy-time

Custom Resource Lambda writes the `SYSTEM#default / METADATA` record at deploy time with values from CDK context (system name, owner, account, region). Reuses the pattern of `agent-prepare`.

---

## Lambda IAM permissions

### `security-triage-compliance-worker` role

**DynamoDB — stream + read + update**
```
dynamodb:GetRecords, GetShardIterator, DescribeStream, ListStreams
  → security-triage-systems/stream/*

dynamodb:UpdateItem
  → security-triage-systems

dynamodb:GetItem
  → security-triage-systems         (SSP reads FIPS 199 record as input)
```

**S3 — write generated reports**
```
s3:PutObject
  → security-triage-compliance-{account}-{region}/compliance/*
```

**Bedrock**
```
bedrock:InvokeModel
  → inference profile ARN (cross-region)
  → foundation model ARNs (us-east-1, us-east-2, us-west-2)
```

**Security Hub — all async document types**
```
securityhub:GetFindings
securityhub:GetEnabledStandards
securityhub:DescribeStandardsControls
securityhub:DescribeHub              (ConMon: enumerate active integrations)
  → resource: *  (Security Hub does not support resource-level restrictions)
```

**Config — SSP, AI RMF**
```
config:DescribeConfigurationRecorders
config:DescribeComplianceByResource
config:ListDiscoveredResources
  → resource: *
```

**GuardDuty — SAR, Risk Assessment**
```
guardduty:ListDetectors
guardduty:ListFindings
guardduty:GetFindings
  → resource: *
```

**IAM — SSP only (summary view)**
```
iam:GetAccountSummary
iam:GetCredentialReport
iam:GenerateCredentialReport
  → resource: *  (IAM is global, no resource-level restriction on these actions)
```

> **Implementation note**: `GenerateCredentialReport` is async. Call it, handle
> `ReportInProgress`, retry until `GetCredentialReport` succeeds. Report is cached
> for up to 4 hours — if stale, regeneration takes a few seconds.

**AccessAnalyzer — Risk Assessment**
```
access-analyzer:ListAnalyzers
access-analyzer:ListFindings
  → resource: *
```

**Explicit denies (defense-in-depth)**
```
DENY s3:DeleteObject, DeleteBucket, PutBucketPolicy        → *
DENY dynamodb:DeleteItem, DeleteTable                      → *
DENY iam:CreateUser, AttachUserPolicy, PutUserPolicy       → *
```

---

### `security-triage-api` role additions

The existing role already covers DynamoDB on the tasks table and Bedrock InvokeAgent.
Two additions for the compliance workspace:

```
dynamodb:GetItem, PutItem, UpdateItem, Query
  → security-triage-systems
  → security-triage-systems/index/*

s3:GetObject
  → security-triage-compliance-{account}-{region}/compliance/*
  (required to generate presigned URLs — signed with the Lambda's own role)
```

---

### `security-triage-compliance-repair` role (shared by stuck-job detector + DLQ recovery)

One Lambda, one role, two triggers (EventBridge schedule + SQS DLQ).

```
dynamodb:UpdateItem
  → security-triage-systems         (mark stuck/failed jobs as FAILED)

dynamodb:Query
  → security-triage-systems/index/* (stuck-job detector queries by status + elapsed time)

sqs:ReceiveMessage, DeleteMessage, GetQueueAttributes
  → security-triage-compliance-worker-dlq
```

This role has no read access to S3, no Bedrock, no Security Hub.
It only writes a status field and reads a queue.

---

## CDK stack organization

### New stack: `ComplianceStack` (`cdk/lib/compliance-stack.ts`)

All compliance workspace infrastructure lives in a dedicated stack. Reasons:
- `SecurityTriageStack` is already ~900 lines. Compliance adds ~300 more.
- Compliance workspace is independently deployable: `cdk deploy SecurityTriageComplianceStack`
- ATO Lambdas can be removed from `SecurityTriageStack` later without touching compliance.

**Deploy order** (in `cdk/bin/app.ts`):

```
1. SecurityTriageFrontendStack   — unchanged
2. SecurityTriageStack           — two new exports added (see below)
3. SecurityTriageAgentStack      — unchanged
4. SecurityTriageComplianceStack — new, depends on SecurityTriageStack
```

`complianceStack.addDependency(mainStack)` — explicit, mirrors AgentStack pattern.
`cdk deploy --all` in `deploy.sh` picks it up automatically. No script changes needed.

### `SecurityTriageStack` — two new exports required

```typescript
// Already exported
public readonly userPool: cognito.UserPool;
public readonly api: apigateway.RestApi;

// Add these
public readonly apiLambda: lambdaNode.NodejsFunction;
public readonly cognitoAuthorizer: apigateway.CognitoUserPoolsAuthorizer;
```

### `ComplianceStack` prop interface

```typescript
interface ComplianceStackProps extends cdk.StackProps {
  apiLambda:         lambdaNode.NodejsFunction;
  cognitoAuthorizer: apigateway.CognitoUserPoolsAuthorizer;
  api:               apigateway.RestApi;
  userPool:          cognito.UserPool;
  frontendUrl?:      string;
}
```

### Cross-stack wiring pattern

```typescript
// IAM grants — CDK creates policy attachment in ComplianceStack,
// modifying the Lambda role defined in SecurityTriageStack. Valid cross-stack pattern.
systemsTable.grantReadWriteData(props.apiLambda);
complianceBucket.grantRead(props.apiLambda);  // needed to sign presigned URLs

// Env vars — addEnvironment() cross-stack works in CDK v2
props.apiLambda.addEnvironment('SYSTEMS_TABLE_NAME', systemsTable.tableName);
props.apiLambda.addEnvironment('COMPLIANCE_BUCKET',  complianceBucket.bucketName);

// Routes — addResource()/addMethod() cross-stack is supported.
// RestApi deployment in SecurityTriageStack picks up all methods at synth time.
const systemsResource = props.api.root.addResource('systems');
// ... add compliance routes here
```

### What `ComplianceStack` creates

```
DynamoDB:    security-triage-systems         (systems + documents table, Streams enabled)
S3:          security-triage-compliance-*    (versioned, lifecycle policy)
Lambda:      security-triage-compliance-worker
Lambda:      security-triage-compliance-repair  (stuck-job detector + DLQ recovery, shared role)
SQS:         security-triage-compliance-worker-dlq
EventBridge: every 5 min → repair Lambda
```

### Initial system record — CDK `AwsCustomResource` (no separate Lambda)

```typescript
new cr.AwsCustomResource(this, 'InitSystemRecord', {
  onCreate: {
    service: 'DynamoDB',
    action: 'putItem',
    parameters: {
      TableName: systemsTable.tableName,
      Item: {
        pk: { S: 'SYSTEM#default' },
        sk: { S: 'METADATA' },
        systemName:   { S: 'My System' },
        ownerName:    { S: '' },
        ownerEmail:   { S: '' },
        awsAccountId: { S: this.account },
        region:       { S: this.region },
      },
      ConditionExpression: 'attribute_not_exists(pk)',  // idempotent — never overwrites analyst edits
    },
    physicalResourceId: cr.PhysicalResourceId.of('InitSystemRecord'),
  },
  policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
    resources: [systemsTable.tableArn],
  }),
});
```

---

## Frontend routing and component structure

### Routes

```
/                            → redirect to /systems/default
/systems/:id                 → ComplianceWorkspace (default view)
/systems/:id/triage          → TriageView (task queue, full-width)
/systems/:id/settings        → SettingsView
```

All routes share the topbar. Agent drawer floats over all of them.
SPA routing already handled — CloudFront returns index.html on 403/404.

### Layout

```
┌──────────────────────────────────────────────────────┐
│ TOPBAR: [Logo | System name]  [Compliance] [Triage]  │
│         [Settings icon]                  [Chat ▼] [●]│
├──────────────────────────────────────────────────────┤
│ ComplianceWorkspace:                                  │
│   ┌──────────────────┬──────────────────────────┐    │
│   │  Document cards  │  Document viewer / empty  │    │
│   └──────────────────┴──────────────────────────┘    │
│                                                       │
│ TriageView:                                           │
│   ┌──────────────────────────────────────────────┐   │
│   │  Task queue (full-width)                     │   │
│   └──────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘

Agent drawer (overlay, any route):
  ┌────────────────────────────────────┐
  │  [─] Chat  [⛶ expand] [✕]        │  ← drag handle on left edge
  │  Chat.tsx content                  │
  └────────────────────────────────────┘
```

**Triage view is task queue full-width** — no chat panel alongside it. The agent drawer
replaces the pinned chat panel. Analysts get more space for findings; the drawer opens
on demand for investigation. This is a deliberate UX improvement over the current split layout.

### New files

```
frontend/src/
  router.tsx
  components/
    ComplianceWorkspace.tsx   ← document cards grid + viewer split
    DocumentCard.tsx          ← status badge, generate button, polling state, click to view
    Fips199Card.tsx           ← C/I/A dropdowns, sync save, computed overall impact
    DocumentViewer.tsx        ← renders document content by docType
    AgentDrawer.tsx           ← drawer shell (resize, collapse, fullscreen) wrapping Chat.tsx
    TriageView.tsx            ← thin wrapper around TaskQueue.tsx for full-width layout
    SettingsView.tsx          ← system name, owner, account, region form
  lib/
    compliance-api.ts         ← GET /systems/:id/documents, POST .../generate, PUT FIPS199
```

### Modified files

```
App.tsx        ← add Router, topbar nav, AgentDrawer mount, remove tab state
TaskQueue.tsx  ← remove hardcoded 40% width, adapt for full-width
```

### Retired (keep until compliance workspace has parity)

```
AtoAssist.tsx  ← stays routable at /ato during transition
```

### `ComplianceWorkspace` structure

```
ComplianceWorkspace
  ├── useDocuments(systemId)     ← GET /systems/:id/documents on mount
  ├── Left panel — document cards (fixed width)
  │   ├── Fips199Card            ← always first
  │   └── DocumentCard × 7      ← each manages its own polling state
  └── Right panel — DocumentViewer (flex)
      └── renders by docType when a COMPLETED card is selected
```

`DocumentCard` owns its own generation + polling lifecycle. Multiple cards can be
generating simultaneously. Polling uses exponential backoff (2s→3s→5s→10s→30s, 15 min ceiling).

### `AgentDrawer` state model

```typescript
type DrawerState = 'closed' | 'open' | 'fullscreen';
```

- Width in `open` state persisted in `localStorage`
- Drag handle on left edge to resize
- Button cycles `open → fullscreen → open`
- Topbar button toggles `closed ↔ open`
- Mounts once in `App.tsx`, persists across route changes
- `Chat.tsx` is the content — no internal changes

### New dependency

```bash
cd frontend && npm install react-router-dom
```

---

## Agent drawer context access

### Passive context — session prompt injection

On the first message of a new drawer session, the frontend includes a context payload:

```typescript
POST /chat
{
  message:   "...",
  sessionId: "...",
  context: {
    currentView: "compliance" | "triage",
    documentInventory: [
      { docType: "SSP",    status: "COMPLETED", lastGeneratedAt: "ISO8601" },
      { docType: "FIPS199", status: "COMPLETED", overallImpact: "Moderate" },
      { docType: "SAR",    status: "FAILED",    error: "Bedrock timeout" },
      { docType: "IRP",    status: null },
      ...
    ]
  }
}
```

The API Lambda prepends this as a preamble to the AgentCore session prompt. No new
Lambda or API call — `ComplianceWorkspace` already holds this data and passes it to
`AgentDrawer` as a prop. Subsequent messages in the same session omit it (AgentCore
session memory handles continuity). Cost: ~500 tokens on session open.

### Active reference — new agent tools

Two new tools added to `security-triage-agent-tools` Lambda:

**`get_document_status`**
```
DynamoDB Query: pk=SYSTEM#default, sk begins_with DOC#NIST#
Returns: [{ docType, status, lastGeneratedAt }]
```
Cheap (one Query). Agent calls this proactively when the analyst asks
anything compliance-related — gives the agent a map of what's available.

**`get_document_content`**
```
Input: docType, section? (e.g. "AC")
→ DynamoDB GetItem: get s3Key, check status=COMPLETED
→ S3 GetObject: fetch document JSON
→ If section provided: return that control family only (~2-5KB)
→ If no section: return summary + family list with pass/fail counts (no full content)
```

The `section` parameter is mandatory for content-heavy documents (SSP, POA&M).
A full SSP can be 200KB — never pass the full document into agent context.

Typical agent flow for "what does our SSP say about access control?":
```
get_document_status()           → confirms SSP is COMPLETED
get_document_content("SSP","AC") → fetches AC section only
→ responds with implementation statement + risk assessment for AC
```

### IAM additions to agent-tools Lambda role

```
dynamodb:GetItem, Query  → security-triage-systems
s3:GetObject             → security-triage-compliance-*/compliance/*
```

Both read-only. Consistent with the architecture rule: agent role has zero write
permissions to AWS services.

### What the agent cannot do

The agent cannot trigger document generation — it has no write access to the systems
table. If asked to "generate the SSP", the correct response is to direct the analyst
to the Generate button in the compliance workspace. Human approval of document
generation is intentional.

---

## Bedrock prompt design per document type

### Shared rules (all generators)

Every prompt includes:
```
CRITICAL: Respond with ONLY a valid JSON object. No markdown fences, no explanation,
no text before or after the JSON.

IMPORTANT JSON rules — violations will cause a parse error:
- Use plain prose in all string values.
- No curly braces, no square brackets, no quotes inside strings.
- Write procedural steps in plain English, not as code or CLI commands.
- Arrays must contain only string values or simple objects, never nested arrays.
```

Every generator wraps the parse call defensively:
```typescript
const jsonMatch = text.match(/\{[\s\S]*\}/);
if (!jsonMatch) throw new Error(`No JSON in Bedrock response for ${docType}`);
try {
  return JSON.parse(jsonMatch[0]);
} catch (e) {
  console.error(`Parse failed for ${docType}. Preview:`, text.slice(0, 500));
  throw e;
}
```

Per-section caps prevent token budget overruns. Cap at 10 findings per control family
(same as existing ATO worker).

---

### FIPS 199 — no Bedrock call

Computed by the API Lambda synchronously:
```typescript
function computeOverallImpact(c: string, i: string, a: string): string {
  const rank = { Low: 0, Moderate: 1, High: 2 };
  return ['Low', 'Moderate', 'High'][Math.max(rank[c], rank[i], rank[a])];
}
```

---

### POA&M — existing ATO worker logic, no change

---

### SSP — two-stage generation

SSP generation uses a two-stage approach to minimize Bedrock calls and maximize
accuracy by leveraging the AWS FedRAMP High P-ATO Customer Responsibility Matrix (CRM).

#### Stage A — AWS-inherited controls (no Bedrock call)

PE family (18 controls) and MA-3/MA-3(1-3) are fully inherited from AWS.
The worker pre-fills these controls with a standard boilerplate narrative:

> "This control is fully inherited from Amazon Web Services. [awsNote]
> AWS holds a FedRAMP High P-ATO and customers running workloads on AWS inherit
> this control through AWS's authorization. No additional customer action is required.
> Evidence: AWS FedRAMP package available in AWS Artifact."

Status: `inherited`. Origination: `inherited`.

#### Stage B — Bedrock for customer and shared controls

For each remaining family, controls are chunked at 18 per Bedrock call to prevent
token budget overruns (AC family has 39 controls at Moderate).

Each Bedrock call receives a context table:

```text
AC-2(1) | Account Management | Automated System Account Management
  Responsibility: Shared (AWS + Customer)
  SecurityHub: PASSING
```

Bedrock returns per-control entries with `status` and `origination` fields.

**Call 1 — system overview** (inputs: system metadata, FIPS 199, Security Hub summary):
```json
{
  "systemDescription": "...",
  "systemPurpose": "...",
  "authorizationBoundary": "...",
  "securityCategorizationRationale": "..."
}
```

**Call 2+ — per control family / chunk:**
```json
{
  "family": "AC",
  "controls": [
    {
      "controlId": "AC-2",
      "title": "Account Management",
      "status": "implemented | partially_implemented | planned | alternative_implementation | not_applicable | inherited | inherited_shared",
      "origination": "sp_system_specific | sp_hybrid | configured_by_customer | provided_by_customer | inherited",
      "responsibleEntities": "...",
      "implementationNarrative": "...",
      "testingEvidence": "..."
    }
  ]
}
```

SSP generator reads FIPS 199 from DynamoDB (GetItem) before invoking Bedrock.
Final S3 output merges Call 1 + all family results into one JSON document.

#### NIST 800-53 Rev 5 baseline control counts

Sourced from official NIST SP 800-53B (baselines) and SP 800-53r5 (titles).

| Baseline  | Controls |
|-----------|----------|
| Low       | 207      |
| Moderate  | 345      |
| High      | 428      |

PM controls (37): "N/A - Deployed organization-wide" — applicable at all baselines.
PT controls (21): privacy baseline — applicable at all baselines.
Both families are included at the `low` tier in `nist-catalog.ts`.

#### AWS CRM (`aws-crm.ts`)

Three responsibility tiers based on the AWS FedRAMP High P-ATO CRM (AWS Artifact):

| Tier | Count | Description |
| --- | --- | --- |
| `aws` | 22 | PE family + MA-3/MA-3(1-3) - fully inherited, no Bedrock call |
| `shared` | ~40 | SC, CM, CP, IA, IR, SI, SR - AWS provides capability, customer configures |
| `customer` | rest | Customer fully responsible |

Controls not listed in the CRM default to `customer`.

> **Note**: The static CRM in `aws-crm.ts` is based on published AWS FedRAMP documentation.
> Verify against the current AWS Artifact CRM before submitting for ATO.

---

### SAR — one summary call + per-family calls (failures only)

**Summary call** (inputs: severity breakdown, top 5 highest-risk findings):
```json
{
  "assessmentScope": "...",
  "assessmentMethodology": "...",
  "overallRiskPosture": "Low | Moderate | High | Critical",
  "executiveSummary": "..."
}
```

**Per-family call** (only families with failures, capped at 8 findings each):
```json
{
  "family": "AC",
  "findingsSummary": "...",
  "riskExposure": "...",
  "recommendations": "..."
}
```

---

### Risk Assessment — single call

Inputs: Security Hub severity counts, GuardDuty finding count + top threats,
AccessAnalyzer external findings count, FIPS 199 impact level.

```json
{
  "threatEnvironment": "...",
  "vulnerabilitySummary": "...",
  "likelihoodDetermination": "Low | Moderate | High",
  "impactDetermination": "Low | Moderate | High",
  "overallRiskRating": "Low | Moderate | High | Critical",
  "riskResponseRecommendations": "..."
}
```

---

### ConMon Plan — single call

Inputs: enabled standards, active integrations from DescribeHub, failure counts per
family (used to set monitoring frequency), FIPS 199 impact level.

Prompt instructs: families with >5 failures → monthly; 1–5 failures → quarterly;
0 failures → semi-annual. Claude calibrates from actual counts.

```json
{
  "monitoringTools": ["..."],
  "monitoringFrequencies": [
    { "family": "AC", "frequency": "Monthly", "rationale": "..." }
  ],
  "reportingCadence": "...",
  "escalationThresholds": "...",
  "rolesAndResponsibilities": "..."
}
```

---

### IRP — single call

Inputs: system name, owner name, owner email (from METADATA), Critical/High findings
filtered for incident-type (GuardDuty, unusual activity — capped at 15), region, account.

Only generator that uses the METADATA record for contact information.

```json
{
  "incidentCategories": ["..."],
  "detectionSources": ["..."],
  "responseTeam": { "primary": "...", "escalation": "..." },
  "containmentProcedures": "...",
  "eradicationProcedures": "...",
  "recoveryProcedures": "...",
  "lessonsLearnedProcess": "..."
}
```

---

---

## Decisions deferred / not yet designed

- [x] Lambda IAM permissions per role
- [x] CDK stack organization
- [x] Frontend routing and component structure
- [x] Agent drawer context access
- [x] Bedrock prompt design per document type
