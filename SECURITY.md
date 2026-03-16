# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, **please do not open a public GitHub issue**.

Report it privately via GitHub's built-in vulnerability reporting:
1. Go to the **Security** tab of this repository
2. Click **Report a vulnerability**
3. Fill in the details — include steps to reproduce, potential impact, and any suggested fixes

You can also reach the maintainer directly through the contact information on their GitHub profile.

## What to Expect

- **Acknowledgement** within 48 hours
- **Status update** within 7 days (confirmed, not reproducible, or fix in progress)
- Credit in the release notes if you'd like it

## Scope

Vulnerabilities of interest include:

- IAM privilege escalation paths in the CDK stacks
- Agent prompt injection that could cause the agent to execute actions outside its defined scope
- Authentication or authorisation bypass in the API Lambda
- Secrets or credentials inadvertently included in the repository
- DynamoDB access control issues (e.g. the agent being able to approve its own tasks)

## Out of Scope

- Findings from automated scanners without a proof-of-concept exploit
- Vulnerabilities in third-party dependencies — report those upstream
- Social engineering

## Security Design Notes

This project is intentionally conservative with permissions:

- The agent (Bedrock) has **zero write access** to AWS services — it can only queue tasks in DynamoDB
- Only the Execution Lambda can modify AWS resources, and only when triggered by an analyst-approved DynamoDB record
- All browser traffic goes through a Cognito-authenticated API Gateway — no AWS credentials ever reach the browser
- Every autonomous action tags the modified resource with `security-agent-action: true` and a timestamp for auditability
