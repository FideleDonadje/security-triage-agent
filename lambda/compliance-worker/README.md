# compliance-worker/

Generates compliance documents for the NIST RMF Compliance Workspace.
Triggered by DynamoDB Streams on `security-triage-systems` when a document record is written with `status = PENDING`.

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | Stream handler — validates the record, marks IN_PROGRESS, dispatches to the right generator, writes the result to S3, marks COMPLETED or FAILED |
| `nist-catalog.ts` | Official NIST SP 800-53B baseline lists (207/345/428 controls for Low/Moderate/High) and SP 800-53r5 control titles |
| `aws-crm.ts` | AWS FedRAMP High P-ATO Customer Responsibility Matrix — which controls are fully inherited from AWS, shared, or customer-owned |

## Document types

| `sk` value | Document | Primary AWS sources | Bedrock calls |
| --- | --- | --- | --- |
| `DOC#NIST#SSP` | System Security Plan | SecurityHub, Config, IAM | Stage A: none (inherited controls pre-filled); Stage B: 1 call per family chunk |
| `DOC#NIST#POAM` | Plan of Action & Milestones | SecurityHub NIST 800-53 findings | 1 per control family with failures |
| `DOC#NIST#SAR` | Security Assessment Report | SecurityHub, GuardDuty | 1 summary + 1 per failing family |
| `DOC#NIST#RA` | Risk Assessment | SecurityHub, GuardDuty, AccessAnalyzer | 1 call |
| `DOC#NIST#CONMON` | Continuous Monitoring Plan | SecurityHub standards + integrations | 1 call |
| `DOC#NIST#IRP` | Incident Response Plan | SecurityHub incident findings + system metadata | 1 call |

## SSP generation — two-stage approach

**Stage A — inherited controls (no Bedrock call)**

PE family (18 controls) and MA-3/MA-3(1)–MA-3(3) are fully inherited from AWS under the FedRAMP High P-ATO.
`aws-crm.ts` pre-fills these with a standard boilerplate narrative. Status = `inherited`, origination = `inherited`.

**Stage B — customer and shared controls (Bedrock)**

Each remaining family is chunked at 18 controls per Bedrock call (prevents token budget overruns — AC has 39 controls at Moderate).
Each call receives a context table of: control ID, official title, AWS responsibility tier, and current SecurityHub pass/fail status.
Bedrock returns `status` (e.g. `implemented`, `partially_implemented`) and `origination` (e.g. `sp_system_specific`, `inherited_shared`) per control.

## NIST baseline counts

Sourced from the official NIST SP 800-53B Excel file. Counts are cumulative:

| Baseline | Controls |
| --- | --- |
| Low | 207 |
| Moderate | 345 |
| High | 428 |

PM controls (37) are "organization-wide" and apply at all baselines.
PT controls (21) are the privacy baseline and also apply at all baselines.

## Error handling

- Each record is processed independently — one failure does not block others.
- `markInProgress()` uses a conditional DynamoDB write to prevent duplicate processing on stream re-delivery.
- All generator errors are caught and written back to DynamoDB as `FAILED` with the error message.
- The Compliance Repair Lambda (EventBridge, every 5 min) marks jobs stuck IN_PROGRESS for more than 12 minutes as `FAILED`.
- The SQS DLQ (`security-triage-compliance-worker-dlq`) catches repeated Lambda failures; the Repair Lambda redrives them up to 3 times.

## Build

```bash
npm run build
```

Output is bundled by CDK's `NodejsFunction` (esbuild) — no separate dist step needed for deploy.
