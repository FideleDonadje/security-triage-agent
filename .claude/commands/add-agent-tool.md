# add-agent-tool

Scaffold a new read-only agent tool end-to-end. The user will provide a tool name and description. If they haven't, ask for:
- Tool name (snake_case, e.g. `get_cost_anomalies`)
- What AWS API(s) it calls
- What parameters it accepts
- What it returns

Then make ALL of the following changes in order:

## 1 — lambda/agent-tools/index.ts

**Import** any new AWS SDK clients/commands at the top of the file alongside existing imports.

**Instantiate** any new client in the `// ── AWS Clients` section, following the same `new XClient({ region: REGION })` pattern.

**Add a case** to the `switch (event.function)` block:
```typescript
case 'your_tool_name':
  resultText = await yourToolName(params);
  break;
```

**Implement the function** before `// ── Helpers`, following the same pattern as existing tools:
- Accept `params: Record<string, string>`
- Return `Promise<string>` (JSON or plain text)
- Guard required params with early returns: `if (!params.x) return 'Error: x is required'`
- Return `JSON.stringify({ ... }, null, 2)` for structured data
- Return a plain English string for empty results

## 2 — lambda/agent-tools/package.json

If a new AWS SDK package is needed, add it to `dependencies` (e.g. `"@aws-sdk/client-cost-explorer": "^3.0.0"`).

## 3 — cdk/lib/agent-stack.ts

**IAM** — add a new `PolicyStatement` to `agentToolsLambdaRole` with:
- A descriptive `sid`
- `effect: iam.Effect.ALLOW`
- The minimum required actions (read-only)
- `resources: ['*']` unless a tighter scope is possible

**Bedrock function schema** — add an entry to the `functions` array inside `actionGroups`:
```typescript
{
  name: 'your_tool_name',
  description: 'One sentence the agent uses to decide when to call this tool.',
  parameters: {
    param_name: {
      type: 'string' | 'integer' | 'boolean',
      description: 'What this parameter does and example values.',
      required: true | false,
    },
  },
},
```

**System prompt** — add the tool to the `CAPABILITIES` section of `SYSTEM_PROMPT`.

**configVersion** — bump the number by 1 to trigger re-prepare on next deploy.

## 4 — Update docs

Run `/update-docs` to sync README.md and CLAUDE.md.

## 5 — Build

Run `cd lambda/agent-tools && npm run build` and `cd cdk && npm run build` to confirm no TypeScript errors.

## 6 — Report

Print a summary of every file changed and remind the user to run:
```bash
cd cdk && cdk deploy SecurityTriageAgentStack --require-approval never
```
