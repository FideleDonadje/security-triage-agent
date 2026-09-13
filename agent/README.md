# agent/

The Strands Triage Agent — a container, not a Lambda. Runs on Amazon Bedrock AgentCore Runtime
(migrated 2026-09 from classic Bedrock Agents; see `../docs/agent-migration-plan.md`). It lives
outside `lambda/` because nothing about it is a Lambda function: it's built with
`DockerImageAsset`, deployed via `AWS::BedrockAgentCore::Runtime`, and runs as a long-lived HTTP
server, not a per-invocation zip.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | `node:22-slim`, linux/arm64 (AgentCore Runtime requirement), multi-stage build |
| `.dockerignore` | Excludes `node_modules`, `dist`, logs from the build context |
| `src/index.ts` | Express server — implements the AgentCore Runtime HTTP contract: `GET /ping` (health) and `POST /invocations` (run the agent, return the reply) |
| `src/agent.ts` | Builds the Strands `Agent` — model, system prompt, tools |
| `src/prompt.ts` | The system prompt (role, capabilities, rules, workflow, communication style) |
| `src/tools.ts` | The 13 tools as `strands.tool()` definitions — each is a thin proxy that forwards `{ tool, input }` to the `agent-tools` Lambda (`../lambda/agent-tools/`) and returns its string body |

## Why tools are proxies, not local functions

The agent identity (the AgentCore Runtime execution role) has zero AWS read/write access beyond
`bedrock:InvokeModel`, pulling its own image, and `lambda:InvokeFunction` on `agent-tools`. All
actual AWS API calls — Security Hub, GuardDuty, Config, CloudTrail, DynamoDB — happen inside
`agent-tools`, which holds its own separately-scoped IAM role. This keeps the two-role split from
`docs/architecture.md` §1 ("agent IAM role has ZERO write permissions to AWS services") intact
even though the loop itself now runs in code we own instead of a fully managed service.

## Build & deploy

There's no manual build step — `cdk/lib/agent-stack.ts` builds the container from this directory
via `DockerImageAsset` on every `cdk deploy` (Docker must be running on the deploy host). To
typecheck locally without building the image:

```bash
cd agent && npm install && npm run build
```

## Local testing

The container just needs Node 22 and the port free:

```bash
npm run build && node dist/index.js
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: text/plain" \
  --data-raw "What security findings do you see?"
```

Tool calls will fail locally unless `AGENT_TOOLS_FUNCTION_NAME` resolves to a real, reachable
Lambda with valid AWS credentials in the environment — local testing is mainly useful for
prompt/response-shape iteration, not full tool-calling runs.

## Environment variables (set by CDK)

| Variable | Value |
|---|---|
| `BEDROCK_MODEL_ID` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| `BEDROCK_REGION` | Stack region |
| `AGENT_TOOLS_FUNCTION_NAME` | `security-triage-agent-tools` |

## Adding a tool

See `docs/runbook.md` §5 "How to Add a New Agent Tool" — it's a two-file change (a case in
`lambda/agent-tools/index.ts`'s `runTool` switch, and a `proxyTool(...)` entry in `src/tools.ts`).
