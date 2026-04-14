# ATO Assist Mode — Design Specification

## Feature Overview

Extension to the Security Triage Agent. Pulls NIST 800-53 Rev 5 findings from
Security Hub, uses Bedrock (Claude Sonnet) to generate control implementation
statements, risk assessments, and POA&M entries per control family.
Results stored as JSON in S3. Job lifecycle tracked in DynamoDB.

---

## Architecture

- **ATO Trigger Lambda** — thin API handler: creates jobs, polls status, lists
  enabled standards, returns per-user job history
- **ATO Worker Lambda** — background processor: fetches up to 2000 Security Hub
  findings, groups by NIST 800-53 control family, calls Bedrock once per failing
  family, writes structured JSON report to S3
- Async pattern: POST /ato/generate returns `jobId` immediately; browser polls
  GET /ato/status/{jobId} until `COMPLETED` or `FAILED`
- Worker triggered by DynamoDB Streams INSERT on AtoJobsTable (not invoked directly)
- Reuses existing API Gateway, Cognito authorizer, and WAF from SecurityTriageStack
- Dedicated IAM role per Lambda (least privilege)

---

## API Routes

All routes require a valid Cognito JWT.

```
GET  /ato/standards           → list enabled Security Hub standards with ATO suitability flags
POST /ato/generate            → create job, return { jobId }
GET  /ato/status/{jobId}      → job status; when COMPLETED includes a presigned S3 URL (1-hour TTL)
GET  /ato/jobs                → list last 20 jobs for the authenticated user (job history sidebar)
```

### ATO suitability

Only standards whose findings include NIST 800-53 control family mappings in
`RelatedRequirements` are marked `atoSuitable: true`. AWS Foundational Security
Best Practices and CIS Benchmarks use proprietary control IDs that don't map to
NIST families and are flagged as not suitable.

---

## DynamoDB — AtoJobsTable

Partition key: `jobId` (String)
TTL attribute: `ttl` — set to 7 years at creation (POA&M records are compliance artifacts)
GSI: `username-index` — partition key `username`, sort key `startTime` (for per-user history)

### Job record schema

```json
{
  "jobId": "job_abc123",
  "username": "analyst@example.com",
  "status": "PENDING | IN_PROGRESS | COMPLETED | FAILED",
  "startTime": "2026-04-09T10:00:00Z",
  "endTime":   "2026-04-09T10:04:30Z",
  "ttl": 1965000000,
  "error": null,
  "resultS3Key": "ato-reports/analyst@example.com/job_abc123.json",
  "standardsArn": "arn:aws:securityhub:...:subscription/nist-800-53/v/5.0.0",
  "standardName": "NIST Special Publication 800-53 Revision 5"
}
```

---

## S3 — AtoReportsBucket

Bucket: `security-triage-ato-reports-{account}-{region}`

- Reports accessed by the browser via presigned GET URLs (1-hour expiry)
- CORS enabled for `GET` from any origin (presigned URLs are IAM-signed and time-limited)
- **Lifecycle:** Glacier transition after 365 days; hard delete after 7 years (2555 days)
  - Rationale: POA&M reports are compliance artifacts with federal records retention requirements.
    Active audit cycles typically close within a year; Glacier tier covers long-term storage at low cost.

### Report JSON schema

```json
{
  "controlFamilies": [
    {
      "family": "AC",
      "familyName": "Access Control",
      "findingCount": 49,
      "passCount": 31,
      "failCount": 18,
      "riskAssessment": "Narrative risk posture for this control family (Bedrock-generated)",
      "implementationStatement": "Narrative describing current control implementation (Bedrock-generated)",
      "poamEntries": [
        {
          "poamId": "POAM-AC-001",
          "affectedControl": "AC-2",
          "description": "One-sentence description of the compliance gap",
          "dateIdentified": "2026-04-09",
          "scheduledCompletionDate": "2026-07-08",
          "status": "Open",
          "riskRating": "High | Medium | Low",
          "remediationPlan": "Plain-English remediation steps"
        }
      ]
    }
  ],
  "summary": {
    "totalFindings": 522,
    "totalFailed": 249,
    "familiesEvaluated": 11
  },
  "generatedAt": "2026-04-14T01:44:17Z"
}
```

**Note:** `totalFindings` is the cross-family sum — a finding mapped to multiple families
is counted once per family. It is not the raw count of unique findings fetched from Security Hub.

---

## Worker — finding fetch and grouping

- Fetches up to **2000** findings (was 500 — raised to avoid missing control families
  that only appear beyond the first 500 results in larger accounts).
- Filters: `RecordState = ACTIVE`, `WorkflowStatus != SUPPRESSED`, optionally `StandardsArn = <selected>`
- Groups findings by NIST 800-53 control family using `RelatedRequirements` regex:
  `NIST[\s.]800-53[\s.](?:r5|Rev[\s.]?5)?[\s.]?([A-Z]{2})-`
- Families with only passing findings receive a generated passing statement without a Bedrock call
- Families with failures: Bedrock is called once per family with up to 10 failing findings in the prompt
  (capped to stay within the 4096 token limit)
- Risk rating schedule: High → 30-day remediation deadline, Medium → 60 days, Low → 90 days

---

## IAM

### ATO Trigger Lambda role

- `dynamodb:PutItem`, `GetItem`, `Query` on AtoJobsTable (and its `username-index` GSI)
- `s3:GetObject` on `AtoReportsBucket/ato-reports/*` (for presigned URL generation)
- `securityhub:GetEnabledStandards`, `DescribeStandards`

### ATO Worker Lambda role

- `securityhub:GetFindings`
- `bedrock:InvokeModel` (scoped to Claude Sonnet model ARN)
- `dynamodb:UpdateItem` on AtoJobsTable
- `s3:PutObject` on `AtoReportsBucket/ato-reports/*`

---

## Stuck job handling

Jobs that stay `IN_PROGRESS` beyond 10 minutes are treated as `FAILED` by the
polling endpoint (`GET /ato/status/{jobId}`). The trigger Lambda checks elapsed
time against a configurable timeout threshold (`STUCK_TIMEOUT_MS = 10 * 60 * 1000`).

---

## Frontend — AtoAssist component

Route: tab in the existing React SPA (no separate `/ato` route — single-page layout).

### Layout

```text
Header: ATO Report Generator | Standards dropdown | Export POAM | Generate Report
Left sidebar (200px): Report History
Main area: Progress card / Empty state / Report view
```

### Report History sidebar

- Shows last 20 jobs for the authenticated user (from `GET /ato/jobs`)
- Clickable rows load a past report by fetching `GET /ato/status/{jobId}` then the presigned URL
- **Soft archive**: each row has a `×` button that hides it from the main list via `localStorage`.
  No data is deleted from S3 or DynamoDB. "Show archived (N)" toggle reveals archived entries with `↩` restore.

### Progress card (shown while polling)

- Headline: "Job queued — waiting for worker" (PENDING) or "Generating report" (IN_PROGRESS)
- Standard name (e.g. "NIST Special Publication 800-53 Revision 5")
- Plain-English description of what the worker is doing
- Live elapsed timer (increments every second, format: `Xm Ys`)
- Pulsing blue dot indicator
- Job ID in small muted text

### Completion notifications

- **Browser notification**: requested on first Generate click (tied to user gesture to avoid popup blocker).
  Fires `new Notification('ATO Report Ready', ...)` when the job completes or fails.
- **In-app toast**: slides up from bottom-right corner. Green for success, red for failure.
  Auto-dismisses after 6 seconds; has a manual `×` close button.

### Report view

- Summary card: Findings / Passed / Failed / Pass Rate / Families
- Control family tabs (horizontal scrollable strip, one tab per family)
  - Tab badge shows fail count; red accent for families with failures
  - Resets to first tab when a new report is loaded
- Family detail panel (active tab):
  - Header: family code + name + pass/fail counts
  - Side-by-side narrative cards: Risk Assessment | Implementation Statement
  - POA&M table (only shown for failing families): POA&M ID, Control, Risk, Status, Due, Description, Remediation Plan
  - "All N controls passing" banner for fully-compliant families

### Export POAM button

- Visible in the header when a report is loaded
- Downloads `ATO_POAM_YYYYMMDD.xlsx` via SheetJS (client-side, no server round-trip)
- Sheet 1 — Summary: standard name, generated date, total findings, pass rate, families evaluated
- Sheet 2 — POAM: one row per `PoamEntry` across all control families; rows color-coded by risk rating
  (High = light red, Medium = light yellow, Low = light green); frozen bold header row

---

## Bedrock prompt rules

To prevent JSON parse failures:

- Respond with only a valid JSON object (no markdown fences, no surrounding text)
- All string values must be plain prose — no curly braces, square brackets, or quotes inside strings
- Remediation steps must be plain English (no shell commands with JSON arguments)
- One POA&M entry per failing finding shown (capped at 10 per family)
- `max_tokens: 4096`

---

## Implementation status

| Feature | Status |
| --- | --- |
| GET /ato/standards | Done |
| POST /ato/generate | Done |
| GET /ato/status/{jobId} | Done |
| GET /ato/jobs (history) | Done |
| Worker: Security Hub fetch (up to 2000 findings) | Done |
| Worker: NIST 800-53 family grouping | Done |
| Worker: Bedrock narrative generation | Done |
| Worker: fallback on Bedrock failure | Done |
| S3 lifecycle (Glacier + 7-year delete) | Done |
| DynamoDB TTL (7 years) | Done |
| Frontend: standards dropdown | Done |
| Frontend: report history sidebar + soft archive | Done |
| Frontend: progress card with elapsed timer | Done |
| Frontend: tab layout (replaced accordions) | Done |
| Frontend: Export POAM (.xlsx) | Done |
| Frontend: browser notification + in-app toast | Done |
| Frontend: avatar dropdown (header) | Done |
| Frontend: filter tabs + pending badge (Task Queue) | Done |
