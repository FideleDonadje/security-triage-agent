# ATO Assist Mode — Design Specification

## Feature Overview
Extension to the existing Security Triage Agent. Pulls NIST 800-53 Rev 5
findings from Security Hub, uses Bedrock to generate control implementation
statements, risk assessments, and POA&M entries. Results stored in S3,
job lifecycle tracked in DynamoDB.

## Architecture Decisions
- Dedicated ATO Trigger Lambda (API handler) + ATO Worker Lambda (background processor)
- Async with polling — Trigger Lambda returns jobId immediately, Worker does the work
- Worker triggered by DynamoDB Streams INSERT events
- Job status/metadata stored in DynamoDB (AtoJobsTable)
- Generated report stored as JSON in S3 (AtoReportsBucket)
- New CDK Construct inside existing stack — reuses existing API Gateway and Cognito authorizer
- New dedicated IAM role per Lambda (least privilege)
- New route in existing React frontend at /ato

## API Routes
```
POST /ato/generate        → creates job, returns { jobId }
GET  /ato/status/{jobId}  → returns job status + presigned S3 URL when complete
```

## DynamoDB Job Record Schema
```json
{
  "jobId": "job_abc123",
  "username": "test@test.com",
  "status": "PENDING | IN_PROGRESS | COMPLETED | FAILED",
  "startTime": "2026-04-09T10:00:00Z",
  "endTime": "2026-04-09T10:01:45Z",
  "ttl": 1744200000,
  "error": null,
  "resultS3Key": "ato-reports/test@test.com/job_abc123.json"
}
```

## DynamoDB Table Config
- Partition key: jobId (String)
- TTL attribute: ttl
- GSI: username (partition) + startTime (sort) — for listing jobs per user

## S3 Report Document Schema
```json
{
  "controlFamilies": [
    {
      "family": "AC",
      "findingCount": 3,
      "passCount": 2,
      "failCount": 1,
      "riskAssessment": "Narrative risk summary for this control family",
      "implementationStatement": "Narrative describing how controls are implemented",
      "poamEntries": [
        {
          "poamId": "POAM-AC-001",
          "affectedControl": "AC-2",
          "description": "MFA not enforced on root account",
          "dateIdentified": "2026-04-09",
          "scheduledCompletionDate": "2026-05-09",
          "status": "Open",
          "riskRating": "High",
          "remediationPlan": "Enable MFA on root account, enforce via SCP"
        }
      ]
    }
  ],
  "summary": {
    "totalFindings": 87,
    "totalFailed": 14,
    "familiesEvaluated": 8
  }
}
```

## IAM — Trigger Lambda Role
- dynamodb:PutItem, GetItem, UpdateItem on AtoJobsTable
- s3:GetObject on AtoReportsBucket (for presigned URL generation)

## IAM — Worker Lambda Role
- securityhub:GetFindings
- bedrock:InvokeModel (scoped to model ARN)
- dynamodb:UpdateItem on AtoJobsTable
- s3:PutObject on AtoReportsBucket

## TTL Convention
TTL_DAYS = 90. Calculated in Trigger Lambda at job creation time.
Matching S3 lifecycle policy on AtoReportsBucket.

## Stuck Job Handling
Jobs that stay IN_PROGRESS beyond a timeout threshold should be
treated as failed by the polling endpoint.

## Frontend Spec
New route: /ato in existing React/Vite app

Components needed:
- Generate button → POST /ato/generate → store jobId in state
- Polling logic → GET /ato/status/{jobId} every 3 seconds until COMPLETED or FAILED
- Results renderer:
  - Summary card (totalFindings, totalFailed, familiesEvaluated)
  - Control family accordion (one section per family)
    - Risk assessment narrative
    - Implementation statement narrative
    - POA&M table (poamId, affectedControl, riskRating, status, scheduledCompletionDate, remediationPlan)
- Error state when status is FAILED
- Loading/progress state while polling
