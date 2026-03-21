# .claude/commands/

Custom slash commands for Claude Code. Type `/command-name` in the chat to invoke.

## Available commands

| Command | Purpose |
|---|---|
| `/deploy` | Full deployment sequence — builds all Lambdas, CDK diff, deploys stacks in order, redeploys frontend if changed |
| `/scan-secrets` | Scans the codebase for hardcoded secrets, API keys, and credentials |
| `/update-docs` | Syncs README.md and CLAUDE.md to match the current state of the code |
| `/review-iam` | Reviews all CDK IAM policies for overly broad permissions and validates DENY statements |
| `/add-agent-tool` | Scaffolds a new read-only agent tool end-to-end (Lambda + IAM + Bedrock schema + docs) |
| `/add-execution-action` | Scaffolds a new Tier 1 remediation action (Lambda file + IAM + ALLOWED_ACTIONS + docs) |
| `/debug-task` | Given a task_id, looks up the DynamoDB record and CloudWatch logs to diagnose failures |

## Adding a new command

Create a `.md` file in this directory. The filename (without `.md`) becomes the slash command name. Claude Code loads the file content as the prompt when the command is invoked.
