#!/usr/bin/env bash
# Git pre-commit hook — blocks commits containing secrets or credentials.
#
# To install:
#   cp .claude/hooks/pre-commit-scan-secrets.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# To bypass in an emergency (use sparingly):
#   git commit --no-verify

set -euo pipefail

SCRIPT_DIR="$(git rev-parse --show-toplevel)/.claude/hooks"

if [[ ! -f "$SCRIPT_DIR/scan-secrets.sh" ]]; then
  echo "[pre-commit] scan-secrets.sh not found — skipping"
  exit 0
fi

bash "$SCRIPT_DIR/scan-secrets.sh" --staged
