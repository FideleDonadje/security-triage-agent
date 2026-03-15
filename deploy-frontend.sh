#!/usr/bin/env bash
# deploy-frontend.sh — builds the React app and syncs it to S3 + invalidates CloudFront
# Run this after: ./deploy.sh and after frontend/.env.local is configured
# Usage: ./deploy-frontend.sh [--profile myprofile] [cdk-outputs.json]
set -euo pipefail

PROFILE="${AWS_PROFILE:-}"
OUTPUTS_FILE="cdk-outputs.json"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    *.json)    OUTPUTS_FILE="$1"; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -n "$PROFILE" ]]; then
  export AWS_PROFILE="$PROFILE"
fi

# ── Validate inputs ───────────────────────────────────────────────────────────
if [[ ! -f "$OUTPUTS_FILE" ]]; then
  echo "ERROR: $OUTPUTS_FILE not found. Run ./deploy.sh first."
  exit 1
fi

if [[ ! -f "frontend/.env.local" ]]; then
  echo "ERROR: frontend/.env.local not found."
  echo "Copy frontend/.env.example to frontend/.env.local and fill in the values from $OUTPUTS_FILE"
  exit 1
fi

# ── Parse CDK outputs ─────────────────────────────────────────────────────────
BUCKET=$(node -e "const o=require('./$OUTPUTS_FILE'); const s=Object.values(o).find(s=>s.FrontendBucketName); console.log(s?.FrontendBucketName ?? '')")
DIST_ID=$(node -e "const o=require('./$OUTPUTS_FILE'); const s=Object.values(o).find(s=>s.DistributionId); console.log(s?.DistributionId ?? '')")
CF_URL=$(node -e "const o=require('./$OUTPUTS_FILE'); const s=Object.values(o).find(s=>s.DistributionUrl); console.log(s?.DistributionUrl ?? '')")

if [[ -z "$BUCKET" || -z "$DIST_ID" ]]; then
  echo "ERROR: Could not read FrontendBucketName or DistributionId from $OUTPUTS_FILE"
  echo "Make sure SecurityTriageFrontendStack deployed successfully."
  exit 1
fi

echo "    Profile : ${PROFILE:-default}"
echo "    Bucket  : $BUCKET"
echo "    Dist ID : $DIST_ID"
echo "    URL     : $CF_URL"

# ── Build and deploy ──────────────────────────────────────────────────────────
echo ""
echo "==> Building frontend..."
(cd frontend && npm install --silent && npm run build)

echo "==> Syncing to s3://$BUCKET ..."
aws s3 sync frontend/dist/ "s3://$BUCKET/" --delete

echo "==> Invalidating CloudFront distribution $DIST_ID ..."
aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" \
  --paths "/*" \
  --query 'Invalidation.Id' \
  --output text

echo ""
echo "Frontend deployed."
echo ""
echo "Open your browser at: $CF_URL"
