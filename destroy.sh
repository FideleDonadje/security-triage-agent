#!/usr/bin/env bash
# destroy.sh — tears down all stacks and cleans up RETAIN resources
# Usage: ./destroy.sh --profile myprofile [--region us-east-1]
#
# WARNING: This deletes all infrastructure including the DynamoDB task table.
#          Only use for dev/test teardown. Not for production.
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
PROFILE="${AWS_PROFILE:-}"
REGION="${CDK_DEFAULT_REGION:-us-east-1}"
ACCOUNT="${CDK_DEFAULT_ACCOUNT:-}"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --region)  REGION="$2";  shift 2 ;;
    --account) ACCOUNT="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -n "$PROFILE" ]]; then
  export AWS_PROFILE="$PROFILE"
fi

export CDK_DEFAULT_REGION="$REGION"
export CDK_DEFAULT_ACCOUNT="$ACCOUNT"

# ── Resolve account ───────────────────────────────────────────────────────────
if [[ -z "$ACCOUNT" ]]; then
  ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) || {
    echo "ERROR: Could not resolve AWS account. Check your credentials / profile."
    exit 1
  }
  export CDK_DEFAULT_ACCOUNT="$ACCOUNT"
fi

echo "=================================================="
echo " WARNING: This will DELETE all stacks and resources"
echo " Profile : ${PROFILE:-default}"
echo " Account : $ACCOUNT"
echo " Region  : $REGION"
echo "=================================================="
echo ""
read -r -p "Type 'yes' to confirm: " CONFIRM
[[ "$CONFIRM" == "yes" ]] || { echo "Aborted."; exit 0; }

# ── Step 1: CDK destroy (stacks with DESTROY removal policy) ──────────────────
echo ""
echo "==> Destroying CDK stacks..."
(cd cdk && npm run build --silent)
(cd cdk && cdk destroy --all --force --no-notices) || true

# ── Step 2: Delete RETAIN resources ──────────────────────────────────────────
echo ""
echo "==> Cleaning up RETAIN resources..."

# DynamoDB table
echo "    Deleting DynamoDB table: security-triage-tasks"
aws dynamodb delete-table \
  --table-name security-triage-tasks \
  --region "$REGION" 2>/dev/null \
  && echo "    Done." \
  || echo "    Not found or already deleted — skipping."

# Cognito User Pool — find all pools named security-triage-analysts and delete each
echo "    Finding Cognito User Pool(s): security-triage-analysts"
# Use JSON output + node to split correctly — --output text collapses multiple IDs
POOL_IDS=$(aws cognito-idp list-user-pools --max-results 60 --region "$REGION" \
  --query "UserPools[?Name=='security-triage-analysts'].Id" \
  --output json 2>/dev/null \
  | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const ids=JSON.parse(d); ids.forEach(id=>console.log(id));" \
  || true)

if [[ -n "$POOL_IDS" ]]; then
  while IFS= read -r POOL_ID; do
    [[ -z "$POOL_ID" ]] && continue
    echo "    Deleting Cognito User Pool: $POOL_ID"
    aws cognito-idp delete-user-pool --user-pool-id "$POOL_ID" --region "$REGION" \
      && echo "    Done." \
      || echo "    Failed — delete manually: aws cognito-idp delete-user-pool --user-pool-id $POOL_ID"
  done <<< "$POOL_IDS"
else
  echo "    Not found — skipping."
fi

# S3 frontend bucket
FRONTEND_BUCKET="security-triage-frontend-${ACCOUNT}-${REGION}"
echo "    Emptying and deleting S3 bucket: $FRONTEND_BUCKET"
aws s3 rm "s3://$FRONTEND_BUCKET/" --recursive --region "$REGION" 2>/dev/null || true
aws s3api delete-bucket --bucket "$FRONTEND_BUCKET" --region "$REGION" 2>/dev/null \
  && echo "    Done." \
  || echo "    Not found or already deleted — skipping."

# S3 access logs bucket
LOGS_BUCKET="security-triage-access-logs-${ACCOUNT}-${REGION}"
echo "    Emptying and deleting S3 bucket: $LOGS_BUCKET"
aws s3 rm "s3://$LOGS_BUCKET/" --recursive --region "$REGION" 2>/dev/null || true
aws s3api delete-bucket --bucket "$LOGS_BUCKET" --region "$REGION" 2>/dev/null \
  && echo "    Done." \
  || echo "    Not found or already deleted — skipping."

# SSM parameters (created by AgentStack — may already be gone with the stack)
echo "    Deleting SSM parameters..."
for PARAM in /security-triage/agent-id /security-triage/agent-alias-id /security-triage/required-tag-keys; do
  aws ssm delete-parameter --name "$PARAM" --region "$REGION" 2>/dev/null \
    && echo "    $PARAM deleted." \
    || echo "    $PARAM not found — skipping."
done

# ── Step 3: Clean local artefacts ─────────────────────────────────────────────
echo ""
echo "==> Cleaning local build artefacts..."
rm -f cdk-outputs.json
rm -rf cdk/cdk.out

# ── Step 4: Print manual cleanup reference ────────────────────────────────────
# CDK does not delete RETAIN resources automatically. The steps above attempt
# deletion, but if anything was skipped or failed, use these commands to finish.
echo ""
echo "=================================================="
echo " Teardown complete."
echo " Note: Cognito domain deletion can take a few minutes to"
echo " propagate. Wait ~2 min before redeploying."
echo "=================================================="
echo ""
echo "── Manual cleanup (run these if any resource above was not deleted) ──────"
echo ""
echo "  # DynamoDB task table"
echo "  aws dynamodb delete-table --table-name security-triage-tasks --region $REGION"
echo ""
echo "  # Cognito User Pool (look up ID first)"
echo "  POOL_ID=\$(aws cognito-idp list-user-pools --max-results 60 --region $REGION \\"
echo "    --query \"UserPools[?Name=='security-triage-analysts'].Id\" --output text)"
echo "  aws cognito-idp delete-user-pool --user-pool-id \"\$POOL_ID\" --region $REGION"
echo ""
echo "  # S3 frontend bucket"
echo "  aws s3 rm s3://security-triage-frontend-${ACCOUNT}-${REGION}/ --recursive"
echo "  aws s3api delete-bucket --bucket security-triage-frontend-${ACCOUNT}-${REGION} --region $REGION"
echo ""
echo "  # S3 access logs bucket"
echo "  aws s3 rm s3://security-triage-access-logs-${ACCOUNT}-${REGION}/ --recursive"
echo "  aws s3api delete-bucket --bucket security-triage-access-logs-${ACCOUNT}-${REGION} --region $REGION"
echo ""
echo "  # SSM parameters"
echo "  aws ssm delete-parameters --region $REGION \\"
echo "    --names /security-triage/agent-id /security-triage/agent-alias-id /security-triage/required-tag-keys"
echo ""
