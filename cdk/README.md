# cdk/

AWS CDK v2 infrastructure — deploys all three stacks.

## Stacks

| File | Stack | What it creates |
|---|---|---|
| `lib/security-triage-stack.ts` | `SecurityTriageStack` | Cognito, DynamoDB, API Lambda, Execution Lambda, API Gateway, WAF |
| `lib/agent-stack.ts` | `SecurityTriageAgentStack` | Bedrock Agent, action group Lambda, IAM roles, SSM parameters, auto-prepare custom resource |
| `lib/frontend-stack.ts` | `SecurityTriageFrontendStack` | S3 bucket, CloudFront distribution |

## Deploy order

`SecurityTriageStack` must deploy before `SecurityTriageAgentStack` — the agent stack reads the DynamoDB table ARN from it.

```bash
# From repo root
bash ./deploy.sh --profile myprofile --region us-east-1 --owner you@example.com
```

## Key exports

`deploy.sh` writes all stack outputs to `cdk-outputs.json` at repo root. The frontend `.env.local` is populated from those values.

## Changing the agent

After modifying `lib/agent-stack.ts` (system prompt, tools, IAM), bump `configVersion` in the `AgentPrepareResource` custom resource — this triggers a `PrepareAgent` call on the next deploy.
