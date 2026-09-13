# Agent Tier Migration — Classic Bedrock Agents → Strands on AgentCore Runtime

**Status:** Phase 1 deployed to production and live-verified (2026-09-11). Branch
`feature/agent-agentcore` → [PR #34](https://github.com/FideleDonadje/security-triage-agent/pull/34).
Phase 2 (Gateway, Memory, streaming, Observability) not started — optional, as-needed.
**Scope:** the Triage Agent loop only. ATO Assist, Compliance Workspace, task queue,
Execution Lambda, approval flow, API routes/auth, and the frontend contract do **not** change.

---

## Why

Amazon Bedrock Agents Classic entered maintenance mode on **2026-07-30**: closed to new
customers, foundation-model catalog frozen at that date, no new features. No end-of-life date is
announced and existing agents keep running — account `898319808197` is grandfathered because the
agent was created before the cutoff. Nothing is broken today (we are pinned to a pre-freeze
Sonnet model), but the platform is a dead end: no newer models, no new capabilities, growing
distance from AWS's supported path.

Independent of the deprecation, Classic already constrains us:

| Constraint | Impact today |
| --- | --- |
| 10 functions per action group | 13 tools split across 2 groups; every new tool worsens this |
| No streaming to the browser | Worker buffers the whole completion; client poll-loops. Chat feels slow. |
| Session memory only, 30-min TTL | No persistent analyst memory across sessions |
| `PrepareAgent` + `configVersion` bump on every change | Deploy friction for prompt/tool edits |
| Self-invoke Lambda hack (`lambda/api/chat.ts`) | Doubles Lambda cost for chat, 15-min ceiling, coarse errors |

## Decision

- **Framework:** Strands Agents SDK for **TypeScript** (`@strands-agents/sdk`, 1.x, GA
  2026-04-30). Bedrock is its default model provider; tools are `strands.tool()` + a Zod schema.
  Keeps the whole stack in one language.
- **Hosting:** AgentCore Runtime — serverless microVM, **$0 while idle**, 8-hour sessions,
  per-session isolation, native streaming. Skip the "Strands in plain Lambda first" step; we are
  committing to AgentCore, so there is no reason to build the intermediate hosting.
- **Tools:** keep `lambda/agent-tools/` as a separate Lambda. The Strands agent reaches it —
  directly in Phase 1, via AgentCore Gateway (MCP) in Phase 2. This preserves the two-role IAM
  split (agent identity ≠ tool identity) and reuses all 13 tool implementations unchanged.
- **IaC:** CDK constructs in `aws-cdk-lib/aws-bedrockagentcore`. The locked aws-cdk-lib (2.248)
  ships **L1 only** (`CfnRuntime`, `CfnGateway`, `CfnGatewayTarget`, `CfnMemory`, …) — enough to
  build everything. The **L2** constructs (`Runtime` with `AgentRuntimeArtifact.fromAsset`,
  `Gateway`, `Memory`) need aws-cdk-lib ~2.256+; that bump has blast radius (see Phase 0
  findings) and is deferred to a dedicated Phase 1 task. Phase 0 uses L1.

## Target architecture

```
BEFORE (Classic)                          AFTER (Strands on AgentCore)
────────────────                          ───────────────────────────
API Lambda ──InvokeAgent──▶ Bedrock       API Lambda ──InvokeAgentRuntime──▶ AgentCore Runtime
                 runs the loop                                                  │ Strands runs the loop
              ──▶ agent-tools Lambda                                            ├─ Bedrock InvokeModel (any current model)
                                                                               ├─ tools ──▶ agent-tools Lambda
                                                                               │            (direct in P1, Gateway/MCP in P2)
                                                                               ├─ session history ──▶ DynamoDB (P1) / AgentCore Memory (P2)
                                                                               └─ streams tokens back (P2)
```

---

## Phases

### Phase 0 — Spike  ·  **DONE (2026-09-09)** — deployed + verified end to end

Prove the IaC + container + deploy + invoke + destroy loop before committing real code.

- [x] `agent/` — Strands TS app: `GET /ping`, `POST /invocations`, `BedrockModel` on the
      Sonnet profile, **all 13 tools** wired as `strands.tool()` proxies to the `agent-tools`
      Lambda (`src/prompt.ts`, `src/tools.ts`, `src/agent.ts`, `src/index.ts`). `tsc` clean.
- [x] `agent/Dockerfile` — `node:22-slim`, multi-stage, listens on 8080. `.dockerignore`.
- [x] `lambda/agent-tools/index.ts` — added the `{ tool, input } → { body }` direct entry path
      alongside the Bedrock action-group handler (`runTool` shared dispatch). `tsc` clean.
- [x] `cdk/lib/agent-runtime-stack.ts` — `CfnRuntime` (L1) + `CfnRuntimeEndpoint` +
      `DockerImageAsset` (LINUX_ARM64), execution role (`bedrock:InvokeModel` on the Sonnet
      profile + `lambda:InvokeFunction` on `agent-tools` + ECR pull + CW logs), SSM param
      `/security-triage/agent-runtime-arn`. `tsc` clean.
- [x] Wired into `cdk/bin/app.ts` behind `-c deployAgentRuntime=true`. `cdk list` confirms the
      stack appears only with the flag; default `cdk synth` (4 stacks) unaffected.
- [x] Deployed to `898319808197`/`us-east-1`. Runtime ARN
      `arn:aws:bedrock-agentcore:us-east-1:898319808197:runtime/security_triage_agent-awLsYx98cq`.
      `invoke-agent-runtime` (payload = raw prompt string, `--cli-binary-format raw-in-base64-out`)
      returns HTTP 200 + a model reply matching the ported prompt. A tool-calling prompt drove
      `get_findings` + `get_threat_context` through the proxy → `agent-tools` Lambda → real
      Security Hub / GuardDuty, two-role IAM split intact.
- [ ] `cdk destroy` — not yet run (left up for Phase 1; `$0` idle).

**Exit criteria:** container builds in CDK ✅, Runtime deploys ✅ and responds ✅ (incl. tool calls ✅).

#### Phase 0 create-time bugs (fixed, commit 19fb5a7)

- IAM role `description` with an em dash → IAM only accepts Latin-1. Use a hyphen. Watch every
  string that reaches an AWS API for smart punctuation.
- AgentCore validates the execution role can pull the ECR image *at Runtime create time*. The
  role's inline `DefaultPolicy` was still attaching in parallel → `Access denied while
  validating ECR URI`. Fix: put all perms in one explicit `iam.Policy` and
  `runtime.node.addDependency(policy)`; spell out `ecr:GetAuthorizationToken` on `*` + pull
  actions on the repo ARN rather than relying on `grantPull` ordering.
- Runtime logs did not appear in `/security-triage/agent-runtime` via `logs tail` — observability
  wiring (CloudWatch Transaction Search / OTEL) is a Phase 2 item; not blocking.

#### Phase 0 findings

- **`aws-cdk-lib` 2.248 → 2.268 bump has real blast radius** — do it as its own task, not
  bundled into a feature. Newer `NodejsFunction` enforces `entry` under `projectRoot`, which
  breaks all 8 existing `NodejsFunction` calls (`«PathNotUnderRoot»`); the fix is a
  `depsLockFilePath` (or `projectRoot`) prop on each. It also pulls esbuild 0.25 → 0.28, and
  with per-lambda `projectRoot` the bundler looks for esbuild in each lambda dir (not found →
  `npx esbuild@0.28.2` fails offline / in CI). Net: the bump needs (a) a prop on every
  `NodejsFunction`, (b) an esbuild strategy (shared install, or Docker bundling), (c) a full
  redeploy of all lambdas (asset hashes change). Tracked as **Phase 1 task 0**.
- **L1 `CfnRuntime` is complete for our needs** on the locked version — `containerConfiguration.containerUri`
  from a `DockerImageAsset`, `networkMode: 'PUBLIC'`, `protocolConfiguration: 'HTTP'`. The L2
  upgrade is a nice-to-have, not a blocker.
- **Strands TS `@strands-agents/sdk` is `1.17.0`** (not `1.0`), engine `node >= 22`, and its
  `express` peer is `^5.1.0` — the agent app uses Express 5.
- **`Agent` API:** `new Agent({ model, systemPrompt, tools, printer:false })`,
  `await agent.invoke(prompt)` → `AgentResult`, `.toString()` for the text.
  `strands.tool({ name, description, inputSchema: z.object(...), callback })`.

### Phase 1 — Full cutover  ·  CODE DONE (2026-09-10, not yet deployed)

Single-cutover approach: `SecurityTriageAgentStack` is rewritten in place, so one
`cdk deploy` deletes the Classic resources and creates the AgentCore Runtime in the same stack
update. Fast path taken — **no DynamoDB session table** (leans on AgentCore Runtime's per-session
isolation; real persistence deferred to Phase 2 Memory).

- [x] **`cdk/lib/agent-stack.ts`** rewritten: `CfnAgent` / `CfnAgentAlias` / both action groups /
      `agent-prepare` provider+resource+lambda / `AgentCoreRole` / `AgentIdParam` / `AgentAliasIdParam`
      **removed**. Added `DockerImageAsset` (LINUX_ARM64), `CfnRuntime` + `CfnRuntimeEndpoint`,
      `security-triage-agent-runtime` role + one explicit `iam.Policy` the Runtime depends on,
      `AgentRuntimeArnParam` (`/security-triage/agent-runtime-arn`). The `agent-tools` Lambda +
      role + log group are unchanged (same logical IDs → in-place update, just loses the
      `BedrockInvokePermission` resource policy). `SYSTEM_PROMPT` deleted (now in the container).
- [x] **`lambda/agent-prepare/`** deleted. **`cdk/lib/agent-runtime-stack.ts`** deleted (folded in).
- [x] **`lambda/api/chat.ts`**: `@aws-sdk/client-bedrock-agent-runtime` →
      `@aws-sdk/client-bedrock-agentcore`; `InvokeAgentRuntimeCommand({ agentRuntimeArn,
      runtimeSessionId, qualifier: 'prod', contentType: 'text/plain', payload })`; parse the
      streaming response → `{ reply }`. `runtimeSessionId` padded to the 33-char minimum.
      `ChatWorkerEvent` carries `runtimeArn` instead of `agentId`/`agentAliasId`. 202 + poll +
      self-invoke pattern unchanged.
- [x] **`cdk/lib/security-triage-stack.ts`**: API role `bedrock:InvokeAgent*` →
      `bedrock-agentcore:InvokeAgentRuntime` on `runtime/*` + `runtime/*/runtime-endpoint/*`;
      SSM read + env var → `AGENT_RUNTIME_ARN_PARAM`. `lambda/api/package.json` dep swapped.
- [x] **`cdk/bin/app.ts`**: dropped the `deployAgentRuntime` gate — AgentStack IS the runtime now.
- [x] **`deploy.sh` / `deploy.ps1`**: `agent-prepare` removed from the lambda build loop.
- [x] **Docs**: `CLAUDE.md`, `docs/architecture.md`, `docs/runbook.md`, `MEMORY.md` updated.
- [x] Verified: `cdk synth` (all 4 stacks) + every lambda `tsc --noEmit` clean.
- [ ] **Deploy** `./deploy.sh` (Docker must be running). Then run the six Triage scenarios in
      `CLAUDE.md` end to end through the real API/UI.
- [ ] Optional cleanup after cutover: delete the now-dead Bedrock `BedrockAgentEvent` branch +
      `parseParams` from `lambda/agent-tools/index.ts`; delete the `@aws-sdk/client-bedrock-agent-runtime`
      lockfile entry.

#### Deploy risks for the cutover

- **CFN deletes the `agent-prepare` custom resource** on this update — it sends a `Delete` to the
  still-deployed provider Lambda first. Verified: the old handler returns cleanly on
  `RequestType === 'Delete'`, so this should not hang. (If it ever does:
  `aws cloudformation continue-update-rollback`.)
- The `agent-tools` Lambda keeps its function name/logical ID → in-place update. Good.
- Old log group `/security-triage/agentcore` (`RemovalPolicy.DESTROY`) is deleted; new
  `/security-triage/agent-runtime` created.
- The classic Bedrock agent (`AQXN8YBX7D`) + alias are deleted by CFN. No manual step expected;
  `aws bedrock-agent delete-agent` only if an orphan remains.
- The `aws-cdk-lib` bump is **still deferred** (L1 `CfnRuntime` works). Do NOT `npm install` in
  `cdk/` — it floats to a broken 2.268. Use `npm ci`.

### Phase 1 leftover — `aws-cdk-lib` bump (standalone task, still open)

**Now also a CI blocker, not just an L1→L2 upgrade (found 2026-09-13):** `npm audit
--audit-level=high` in `cdk/` fails on `aws-cdk-lib <=2.259.0` —
[GHSA-vcrf-j523-4mrf](https://github.com/advisories/GHSA-vcrf-j523-4mrf) (OS Command Injection
in `NodejsFunction` Docker Bundling) plus a CodeBuild S3 log-encryption boolean-inversion
advisory, and two transitive-only findings (`brace-expansion`, `fast-uri`) bundled inside
`aws-cdk-lib`'s own dependency tree. The only real fix is the same version bump below — this
raises its priority but doesn't change the blocker.

**Attempted 2026-09-11, reverted.** Two Windows-specific bundling failures hit in sequence:

1. Fixing `PathNotUnderRoot` with `projectRoot` (repo root) + `depsLockFilePath` (cdk's own
   lockfile) gets past the entry-path error, but `NodejsFunction`'s local esbuild resolution
   then wants an esbuild install it can't find from `projectRoot` (`npx --no-install esbuild`
   fails looking for a specific version — `PackageInstallation.detect('esbuild')` doesn't
   resolve the cdk/node_modules copy once `projectRoot` no longer points at `cdk/`).
2. Working around that with `bundling.forceDockerBundling: true` gets esbuild to run
   successfully **inside Docker** (bundled output is produced correctly), but the final
   rename of the bundling-temp directory then fails with `EPERM: operation not permitted` —
   consistently, not transient. This is a known class of Windows + Docker Desktop file-locking
   issue in CDK asset bundling, unrelated to this repo's code.

Reverted cleanly (`git checkout` + `npm ci`) — `aws-cdk-lib` stays pinned at `2.248.0`,
matching every deployed stack. L1 `CfnRuntime` remains the approach.

**Before retrying:** do this from a non-Windows environment (Linux CI runner, WSL2 native
filesystem instead of a `/mnt/d`-style Windows-drive mount, or macOS) where the Docker-bundling
rename issue doesn't apply. Steps once environment is right:

- `aws-cdk-lib` 2.248 → current; add `projectRoot` + `depsLockFilePath` to all 8
  `NodejsFunction` calls (repo root / cdk's lockfile, or per-lambda lockfiles — either works)
- Either get local esbuild resolving cleanly (may need an esbuild install reachable from
  `projectRoot`) or accept Docker bundling (only viable off Windows, per above)
- `cdk diff` should show only asset-hash changes; redeploy all stacks; smoke-test
- Once green, `agent-stack.ts` can move from L1 `CfnRuntime` to the L2 `Runtime` construct

### Phase 2 — Add managed pieces, incrementally  ·  ~1–2 days, as needed

Each is independent and separately deployable:

- **Gateway** — `agentcore.Gateway` + `GatewayTarget` (Lambda target → `agent-tools`). Strands
  consumes tools over MCP; drop the direct `lambda:InvokeFunction` wiring. Do this when tool
  count justifies it or to get semantic tool search.
- **Memory** — `agentcore.Memory` with a long-term strategy for analyst preferences and prior
  investigations. Replaces the Phase 1 DynamoDB session table.
- **Streaming** — switch `/invocations` to a streaming response, change `chat.ts` to stream to
  the browser, **delete the self-invoke worker and the client poll loop**.
- **Observability** — enable OTEL export to CloudWatch GenAI Observability. High value: a full
  trace of the agent's reasoning and every tool call, for the security audit trail.

---

## IAM changes

| Role | Classic | After | Notes |
| --- | --- | --- | --- |
| `security-triage-agentcore` (Bedrock **service** role) | trusts `bedrock.amazonaws.com`; `bedrock:InvokeModel`; `lambda:InvokeFunction` on `agent-tools` | **deleted** — no Bedrock service principal in the loop | — |
| **new** `security-triage-agent-runtime` (Runtime execution role) | — | `bedrock:InvokeModel` (+ `InvokeModelWithResponseStream` in P2) on the Sonnet profile; `lambda:InvokeFunction` on `agent-tools`; CloudWatch logs; P1 also `dynamodb:*Item` on the chat-sessions table | small — tools stay in their own Lambda/role |
| `security-triage-agent-tools-lambda` | read-only AWS + DynamoDB PutItem/UpdateItem/Query + explicit `Deny` DeleteItem | **unchanged** | the two-role split is preserved |
| `security-triage-api-lambda` | `bedrock:InvokeAgent` + `InvokeAgentWithResponseStream`; self-invoke `lambda:InvokeFunction` | drop `bedrock:InvokeAgent*`; add `bedrock-agentcore:InvokeAgentRuntime` on the Runtime ARN; self-invoke perm stays through P1 | — |

Architecture rule §1 ("agent IAM role has ZERO write to AWS services") still holds — the Runtime
role's only writes are to DynamoDB (chat-sessions in P1; nothing in P2 once Memory takes over).
Rule §3 ("agent's only writes are queue_task / cancel_task → DynamoDB") holds — those go through
`agent-tools`, unchanged.

## What does NOT change

- The intent/execution boundary — the agent still only appends `PENDING` tasks
- The task-queue state machine and every transition
- The Execution Lambda, its role, and the DynamoDB-stream trigger
- `lambda/ato-worker/` and `lambda/compliance-worker/` — already plain `InvokeModel`
- API layer routes, Cognito auth, the async job pattern
- Frontend — the `POST /chat` → `202` → `GET /chat/result/:id` contract is preserved

## Cost & rollback

- AgentCore Runtime bills active compute only — **$0 when idle**. At single-analyst MVP volume
  the surcharge over Classic is a few dollars a month. Model-inference spend is identical and
  dominates either way.
- `cdk destroy` on the agent stack (or removing the Runtime construct and redeploying) reverts
  cleanly — Runtime / Gateway / Memory delete with no orphaned provisioned capacity.
- No data migration: the `security-triage-tasks` schema is untouched.

## Open questions

- Exact `@strands-agents/sdk` session-management API (`sessionManager` prop) for wiring the
  DynamoDB history store in Phase 1
- Whether Phase 2 streaming can use the SDK's response streaming or needs the lower-level
  `@aws-sdk/client-bedrock-agentcore` stream
- Final container size / cold-start on `node:22-slim` + the SDK's dependency tree
- Does AgentCore Runtime need `authorizerConfiguration` (inbound auth) set, or is the execution
  role + API-Lambda-only caller enough? (Phase 1 — the API Lambda is the only caller.)
- The L1→L2 switch after the aws-cdk-lib bump — confirm `AgentRuntimeArtifact.fromAsset` builds
  the same image the current `DockerImageAsset` does

## References

- [Bedrock Agents Classic maintenance mode](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-classic-maintenance-mode.html)
- [Strands TypeScript 1.0 announcement](https://strandsagents.com/blog/strands-agents-typescript-v1/)
- [Deploy Strands TS to AgentCore Runtime](https://strandsagents.com/docs/user-guide/deploy/deploy_to_bedrock_agentcore/typescript/)
- [AWS: AgentCore CLI in TypeScript](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-cli-typescript.html)
- [aws-cdk-lib/aws-bedrockagentcore module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_bedrockagentcore-readme.html)
- [AgentCore CloudFormation resource types](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/AWS_BedrockAgentCore.html)
- [AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)
