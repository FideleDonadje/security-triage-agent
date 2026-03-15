#!/usr/bin/env bash
# Optional git pre-commit hook — runs /update-docs before every commit.
# Custom commands live in .claude/commands/ — Claude Code picks them up automatically.
#
# To activate:
#   cp .claude/hooks/pre-commit-update-docs.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# Requires the `claude` CLI to be installed and authenticated.
# If claude is not available the hook exits 0 (non-blocking).

set -euo pipefail

if ! command -v claude &>/dev/null; then
  echo "[update-docs] claude CLI not found — skipping doc sync"
  exit 0
fi

echo "[update-docs] Syncing documentation..."
claude --print "/update-docs" && git add README.md CLAUDE.md || true
