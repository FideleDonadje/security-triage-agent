#!/usr/bin/env bash
# deploy-frontend.sh — builds the React app and deploys it to S3 + CloudFront
#
# Reads all configuration from SSM Parameter Store (written by CDK on deploy).
# No manual .env.local file needed — values are injected into the Vite build.
#
# Run after: ./deploy.sh
# Usage: ./deploy-frontend.sh [--profile myprofile] [--region us-east-1]
set -euo pipefail

# Prevent Git Bash from converting /security-triage/... paths to Windows paths
export MSYS_NO_PATHCONV=1

PROFILE="${AWS_PROFILE:-}"
REGION="${CDK_DEFAULT_REGION:-us-east-1}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --region)  REGION="$2";  shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -n "$PROFILE" ]]; then
  export AWS_PROFILE="$PROFILE"
fi

PROFILE_ARG="${PROFILE:+--profile $PROFILE}"
SSM_GET="aws ssm get-parameter --region $REGION $PROFILE_ARG --query Parameter.Value --output text --name"

# ── Read all config from SSM ───────────────────────────────────────────────────
echo "==> Reading config from SSM..."

BUCKET=$($SSM_GET /security-triage/frontend-bucket-name)
DIST_ID=$($SSM_GET /security-triage/cloudfront-distribution-id)
CF_URL=$($SSM_GET /security-triage/cloudfront-url)
API_URL=$($SSM_GET /security-triage/api-url)
USER_POOL_ID=$($SSM_GET /security-triage/user-pool-id)
USER_POOL_CLIENT_ID=$($SSM_GET /security-triage/user-pool-client-id)
COGNITO_DOMAIN=$($SSM_GET /security-triage/cognito-domain)

echo "    Bucket        : $BUCKET"
echo "    Distribution  : $DIST_ID"
echo "    CloudFront URL: $CF_URL"

# ── Build with env vars baked in (no .env.local needed) ──────────────────────
echo ""
echo "==> Building frontend..."
(cd frontend && npm install --silent && \
  VITE_API_URL="$API_URL" \
  VITE_APP_URL="$CF_URL" \
  VITE_USER_POOL_ID="$USER_POOL_ID" \
  VITE_CLIENT_ID="$USER_POOL_CLIENT_ID" \
  VITE_COGNITO_DOMAIN="$COGNITO_DOMAIN" \
  npm run build)

# ── Sync to S3 ────────────────────────────────────────────────────────────────
echo ""
echo "==> Syncing to s3://$BUCKET ..."
aws s3 sync frontend/dist/ "s3://$BUCKET/" --delete

# ── Invalidate CloudFront cache ───────────────────────────────────────────────
echo ""
echo "==> Invalidating CloudFront distribution $DIST_ID ..."
INVALIDATION_ID=$(aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" \
  --paths "/*" \
  --query 'Invalidation.Id' \
  --output text)
echo "    Invalidation: $INVALIDATION_ID"

echo ""
echo "Frontend deployed. Open: $CF_URL"
echo ""
