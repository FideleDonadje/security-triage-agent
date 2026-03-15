# update-docs

When this skill is invoked, synchronise the project documentation to match the current state of the code. Follow these steps exactly:

## Step 1 — Identify what changed

Run `git diff HEAD --name-only` to list modified files.
If nothing is staged/modified, run `git diff HEAD~1 --name-only` to see the last commit.

Group the changed files by layer:
- `cdk/lib/agent-stack.ts` → agent tools, IAM permissions, system prompt, Bedrock schema
- `cdk/lib/security-triage-stack.ts` → API routes, Lambda roles, DynamoDB schema
- `lambda/agent-tools/index.ts` → agent tool implementations
- `lambda/api/tasks.ts` or `lambda/api/index.ts` → API endpoints
- `lambda/execution/` → execution actions (enable-logging, apply-tags, etc.)
- `frontend/src/` → UI changes

## Step 2 — Read the changed files

Read each changed file to understand what actually changed — new functions, removed functions, new routes, new statuses, new IAM actions, etc.

## Step 3 — Update CLAUDE.md

CLAUDE.md is the authoritative spec for AI agents working on this project. Update these sections if relevant:

- **MVP Scope** — add/remove capabilities based on what's built
- **Architecture rules** — update if write permissions changed
- **Task queue model** — update if statuses or field shapes changed
- **AgentCore tools** — keep the tools list and their backing AWS APIs accurate
- **Project structure** — update if files were added/removed

Do not change the overall format or remove sections. Only update content that is stale.

## Step 4 — Update README.md

README.md is for humans deploying and using the system. Update these sections if relevant:

- **In scope / Out of scope** — reflect new or removed features
- **Project structure** file tree — fix any stale filenames or comments
- **Prerequisites** — add any new AWS services the agent now queries
- **Test scenarios** — add a scenario if a major new capability was added; each scenario must be end-to-end testable
- **Task queue** — keep the state machine diagram and field table accurate
- **Troubleshooting** — remove entries that are no longer relevant

Do not rewrite sections that are not affected by the changes. Do not change tone, formatting style, or add new top-level sections without a clear reason.

## Step 5 — Report what you changed

After editing, print a concise bullet list:
- Which files you updated
- Which sections changed and why
- Anything you noticed that may need manual attention (e.g. a test scenario that is no longer accurate)
