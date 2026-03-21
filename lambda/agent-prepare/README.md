# lambda/agent-prepare/

CDK custom resource Lambda — runs automatically on every `cdk deploy` to keep the Bedrock agent in sync.

## What it does

Calls Bedrock `PrepareAgent` after the agent and action group are created or updated. Without this, the agent uses a stale schema that doesn't reflect recent changes to tools, the system prompt, or IAM.

## When it runs

The CDK `CustomResource` that invokes this Lambda is keyed on `configVersion` in `cdk/lib/agent-stack.ts`. Bump that number whenever you change:
- The system prompt (`SYSTEM_PROMPT`)
- The Bedrock function schema (add/remove/change a tool)
- The foundation model

If you change IAM policies or Lambda code only, `PrepareAgent` is not required — but bumping `configVersion` is harmless.

## Why it exists

Bedrock agents require an explicit `PrepareAgent` API call before changes take effect. CDK has no native construct for this — a custom resource Lambda is the standard pattern for triggering out-of-band API calls during deployment.
