# scan-secrets

Scan the codebase for hardcoded secrets, credentials, and API keys.

Run the scan script against all tracked files (not just staged):

```bash
bash .claude/hooks/scan-secrets.sh
```

Report the results clearly:
- List every finding with file path, line number, and the matched pattern label
- If findings exist, explain what each one is and whether it looks like a real secret or a false positive
- If it is a false positive, tell the user they can add `# nosec` to the end of that line to suppress it
- If it is a real secret, tell the user to remove it, rotate the credential immediately, and check git history with `git log -p | grep -E "<pattern>"` to see if it was ever committed

If the scan is clean, confirm with a one-line summary of how many files were checked.
