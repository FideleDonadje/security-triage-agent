# lambda/agent-tools/

Bedrock Agent action group Lambda — executes every tool the agent can call.

## Tools

| Tool | AWS API | What it does |
|---|---|---|
| `get_findings` | Security Hub `GetFindings` | Retrieves active findings, filterable by severity |
| `get_threat_context` | GuardDuty `ListFindings` + `GetFindings` | Threat intelligence for a specific resource |
| `get_config_status` | Config `DescribeComplianceByResource` | Compliance history for a resource |
| `get_trail_events` | CloudTrail `LookupEvents` | Recent API activity for a resource or event type |
| `get_tag_compliance` | ResourceGroupsTaggingAPI `GetResources` | Resources missing required tags (Environment, Owner, Project) |
| `get_enabled_standards` | Security Hub `GetEnabledStandards` + `DescribeStandards` | Active compliance standards in the account |
| `get_compliance_report` | Security Hub `DescribeStandardsControls` + `GetFindings` | Compliance posture report for a specific standard |
| `get_iam_analysis` | IAM `GetAccountSummary`, `GenerateCredentialReport`, `ListUsers` | IAM posture — MFA gaps, stale keys, admin users |
| `get_access_analyzer` | Access Analyzer `ListAnalyzers` + `ListFindings` | Resources with external or cross-account access |
| `get_cost_analysis` | Cost Explorer `GetCostAndUsage`, `GetAnomalies` | Spend by service or tag, cost anomaly detection |
| `queue_task` | DynamoDB `PutItem` | Queues a remediation task for analyst approval |
| `cancel_task` | DynamoDB `UpdateItem` | Cancels a PENDING task (PENDING → CANCELLED) |
| `get_task_queue` | DynamoDB `Query` | Lists tasks by status |

## IAM posture

This Lambda is **read-only across all AWS services**. Its only write permissions are:
- `dynamodb:PutItem` — queue_task
- `dynamodb:UpdateItem` — cancel_task (enforced as PENDING → CANCELLED only via ConditionExpression)

`dynamodb:DeleteItem` is explicitly DENIED.

## Required tag keys

The list of required tag keys is configurable via SSM at `/security-triage/required-tag-keys` (JSON array). The Lambda caches this value for the lifetime of the container. Change the parameter value in SSM to update the policy without redeploying.
