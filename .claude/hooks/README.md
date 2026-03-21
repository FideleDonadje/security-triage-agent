# .claude/hooks/

Shell scripts that run automatically at specific points in the Claude Code workflow.

## Files

| File | When it runs | Purpose |
|---|---|---|
| `scan-secrets.sh` | On demand (called by `/scan-secrets` and pre-commit hook) | Scans tracked files for hardcoded secrets, API keys, and credentials using pattern matching |
| `pre-commit-scan-secrets.sh` | Before every git commit | Blocks the commit if any secrets are found — calls `scan-secrets.sh` internally |
| `pre-commit-update-docs.sh` | Before every git commit | Reminds Claude to run `/update-docs` if source files changed without corresponding doc updates |

## Hook configuration

Hooks are registered in `.claude/settings.json`. The pre-commit hooks run via git's hook system — see `.git/hooks/pre-commit` if you need to inspect or modify the trigger.

## Adding a new hook

1. Create the shell script here
2. Make it executable: `chmod +x .claude/hooks/your-hook.sh`
3. Register it in `.claude/settings.json` under the appropriate event
