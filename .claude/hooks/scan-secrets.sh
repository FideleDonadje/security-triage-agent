#!/usr/bin/env bash
# scan-secrets.sh — scans files for hardcoded secrets and credentials.
#
# Usage:
#   bash .claude/hooks/scan-secrets.sh            # scan all tracked files
#   bash .claude/hooks/scan-secrets.sh --staged   # scan only git-staged files
#
# Exit codes:  0 = clean,  1 = secrets found

set -euo pipefail

STAGED_ONLY=false
[[ "${1:-}" == "--staged" ]] && STAGED_ONLY=true

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

# ── Files to scan ─────────────────────────────────────────────────────────────
if $STAGED_ONLY; then
  mapfile -t FILES < <(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)
else
  mapfile -t FILES < <(git ls-files 2>/dev/null || true)
fi

# Skip binary files, lock files, and generated assets
SKIP_PATTERNS=('\.png$' '\.jpg$' '\.gif$' '\.ico$' '\.woff' '\.ttf' '\.map$'
               'package-lock\.json$' 'yarn\.lock$' '\.lock$'
               'node_modules/' 'dist/' 'cdk\.out/')

filter_files() {
  local filtered=()
  for f in "${FILES[@]}"; do
    local skip=false
    for pat in "${SKIP_PATTERNS[@]}"; do
      [[ "$f" =~ $pat ]] && skip=true && break
    done
    $skip || filtered+=("$f")
  done
  FILES=("${filtered[@]+"${filtered[@]}"}")
}
filter_files

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo -e "${GREEN}[scan-secrets] No files to scan.${NC}"
  exit 0
fi

# ── Patterns ──────────────────────────────────────────────────────────────────
# Format: "LABEL|REGEX"
PATTERNS=(
  # AWS credentials
  "AWS Access Key ID|AKIA[0-9A-Z]{16}"
  "AWS Temporary Key ID|ASIA[0-9A-Z]{16}"
  "AWS Secret Key (near 'secret')|(?i)(aws.{0,20}secret.{0,20}=.{0,5})[A-Za-z0-9+/]{40}"
  # Anthropic / OpenAI
  "Anthropic API Key|sk-ant-[a-zA-Z0-9\-_]{20,}"
  "OpenAI API Key|sk-[a-zA-Z0-9]{48}"
  # Generic secrets
  "Private Key block|-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY"
  "Generic password assignment|(?i)(password|passwd|pwd)\s*[:=]\s*['\"][^'\"]{8,}['\"]"
  "Generic secret assignment|(?i)(secret|api.?key|api.?token|auth.?token|access.?token)\s*[:=]\s*['\"][A-Za-z0-9+/\-_]{16,}['\"]"
  # Connection strings
  "Connection string with credentials|(?i)(mongodb|mysql|postgres|redis|amqp)://[^:]+:[^@]{4,}@"
  # JWT
  "Hardcoded JWT|eyJ[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}"
)

# ── False-positive allowlist (lines matching these are skipped) ────────────────
ALLOWLIST=(
  '\.env\.example'                          # placeholder file by design
  'xxxx\|xxxxxxxxxx\|<.*>\|your-'           # obvious placeholders
  '^\s*#'                                   # comment lines
  'example\.com\|example\.org'              # example domains
  'TODO\|FIXME\|PLACEHOLDER'
)

# ── Scan ──────────────────────────────────────────────────────────────────────
FOUND=0

for pattern_entry in "${PATTERNS[@]}"; do
  label="${pattern_entry%%|*}"
  regex="${pattern_entry#*|}"

  while IFS=: read -r file line content; do
    # Apply allowlist
    skip=false
    for allow in "${ALLOWLIST[@]}"; do
      if echo "$file:$content" | grep -qE "$allow" 2>/dev/null; then
        skip=true
        break
      fi
    done
    $skip && continue

    if [[ $FOUND -eq 0 ]]; then
      echo -e "\n${RED}[scan-secrets] SECRETS DETECTED — commit blocked${NC}\n"
    fi
    echo -e "  ${RED}✗ $label${NC}"
    echo -e "    ${YELLOW}$file:$line${NC}"
    echo -e "    ${content:0:120}"
    echo
    FOUND=$((FOUND + 1))

  done < <(grep -rPn "$regex" "${FILES[@]}" 2>/dev/null || true)
done

# ── Result ────────────────────────────────────────────────────────────────────
if [[ $FOUND -eq 0 ]]; then
  echo -e "${GREEN}[scan-secrets] Clean — no secrets detected in ${#FILES[@]} file(s).${NC}"
  exit 0
else
  echo -e "${RED}[scan-secrets] $FOUND finding(s). Remove secrets before committing.${NC}"
  echo -e "  If a finding is a false positive, add an inline comment:  # nosec"
  exit 1
fi
