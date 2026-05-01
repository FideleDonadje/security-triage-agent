# docs/screenshots/

Screenshots used in the main README.md.

| File | Shows |
|---|---|
| `triage-agent-capabilities.png` | Two-panel layout: task queue with pending remediations (left) + agent greeting and capability overview (right) |
| `triage-agent-capabilities-security-posture.png` | Agent security posture analysis — synthesised findings across Security Hub, GuardDuty, Config, IAM, and cost anomalies |
| `triage-agent-tasks-queue.png` | Task queue with 8 pending tag_resource remediations awaiting approval, account IDs masked |
| `compliance-workspace.png` | Compliance Workspace: NIST RMF 7-step progress bar, all 7 steps complete |
| `compliance-workspace-expanded-1.png` | FIPS 199 categorization (Moderate C/I/A) and control baseline (345 controls) |
| `compliance-workspace-expanded-2.png` | All 6 generated RMF documents (SSP, SAR, RA, POA&M, ConMon, IRP) with generation timestamps |
| `compliance-workspace-SSP-overview.png` | SSP document viewer: system overview, authorization boundary, security categorization rationale, and 345-control color-coded status bar (Implemented / Partial / Inherited / N/A) |
| `compliance-workspace-control-narrative.png` | SSP IA family expanded: per-control implementation narrative, responsible entities, testing evidence, and CRM responsibility assignment (SP Specific / Customer / Hybrid / Inherited) |
| `ATO-Assist-dashbord.png` | ATO Report Generator: 1,831 findings, 68% pass rate, AC family breakdown with POA&M entries |

All screenshots have been scrubbed of account IDs before commit. The task queue applies `****XXXX` masking by default via the Show IDs toggle.
