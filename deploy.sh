#!/usr/bin/env bash
# deploy.sh — builds and deploys the Security Triage Agent to AWS
# Usage: ./deploy.sh [--profile myprofile] [--region us-east-1] [--env dev] [--owner you@example.com]
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
PROFILE="${AWS_PROFILE:-}"
REGION="${CDK_DEFAULT_REGION:-us-east-1}"
ACCOUNT="${CDK_DEFAULT_ACCOUNT:-}"
ENV="${DEPLOY_ENV:-dev}"
OWNER="${OWNER_EMAIL:-unknown}"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --region)  REGION="$2";  shift 2 ;;
    --account) ACCOUNT="$2"; shift 2 ;;
    --env)     ENV="$2";     shift 2 ;;
    --owner)   OWNER="$2";   shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Export profile so all child processes (aws CLI, cdk) pick it up
if [[ -n "$PROFILE" ]]; then
  export AWS_PROFILE="$PROFILE"
fi

export CDK_DEFAULT_REGION="$REGION"
export CDK_DEFAULT_ACCOUNT="$ACCOUNT"
export DEPLOY_ENV="$ENV"
export OWNER_EMAIL="$OWNER"

# ── Preflight checks ──────────────────────────────────────────────────────────
echo "==> Checking prerequisites..."

command -v aws   >/dev/null 2>&1 || { echo "ERROR: AWS CLI not found. Install it first."; exit 1; }
command -v node  >/dev/null 2>&1 || { echo "ERROR: Node.js not found. Install Node 22+."; exit 1; }
command -v cdk   >/dev/null 2>&1 || { echo "ERROR: CDK CLI not found. Run: npm install -g aws-cdk"; exit 1; }

# Resolve account from caller identity if not set
if [[ -z "$ACCOUNT" ]]; then
  ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) || {
    echo "ERROR: Could not resolve AWS account. Check your credentials / profile."
    exit 1
  }
  export CDK_DEFAULT_ACCOUNT="$ACCOUNT"
fi

echo "    Profile : ${PROFILE:-default}"
echo "    Account : $ACCOUNT"
echo "    Region  : $REGION"
echo "    Env     : $ENV"
echo "    Owner   : $OWNER"

# ── Step 1: Install and build CDK ─────────────────────────────────────────────
echo ""
echo "==> Installing and building CDK..."
(cd cdk && npm install --silent && npm run build --silent)

# ── Step 2: Install and build Lambdas ─────────────────────────────────────────
echo ""
echo "==> Installing and building Lambda packages..."
for pkg in api execution agent-tools agent-prepare; do
  echo "    lambda/$pkg"
  (cd "lambda/$pkg" && npm install --silent && npm run build --silent)
done

# ── Step 3: CDK bootstrap (safe to re-run) ────────────────────────────────────
echo ""
echo "==> Bootstrapping CDK (safe to re-run)..."
(cd cdk && cdk bootstrap "aws://$ACCOUNT/$REGION" --no-notices 2>&1 | tail -5)

# ── Step 4: Deploy all stacks ─────────────────────────────────────────────────
echo ""
echo "==> Deploying all stacks..."
(cd cdk && cdk deploy --all --require-approval never --no-notices --outputs-file ../cdk-outputs.json)

# ── Step 5: Print next steps ──────────────────────────────────────────────────
PROFILE_FLAG=""
[[ -n "$PROFILE" ]] && PROFILE_FLAG=" --profile $PROFILE"

echo ""
echo "=================================================="
echo " Deploy complete. CDK outputs saved to cdk-outputs.json"
echo "=================================================="
echo ""
echo "Remaining manual steps:"
echo ""
echo "1. Create the analyst account:"
POOL_ID=$(node -e "const o=require('./cdk-outputs.json'); console.log(Object.values(o).find(s=>s.UserPoolId)?.UserPoolId ?? '<UserPoolId>')" 2>/dev/null || echo "<UserPoolId>")
CLIENT_ID=$(node -e "const o=require('./cdk-outputs.json'); console.log(Object.values(o).find(s=>s.UserPoolClientId)?.UserPoolClientId ?? '<UserPoolClientId>')" 2>/dev/null || echo "<UserPoolClientId>")
echo ""
echo "   aws$PROFILE_FLAG cognito-idp admin-create-user \\"
echo "     --user-pool-id $POOL_ID \\"
echo "     --username analyst@example.com \\"
echo "     --user-attributes Name=email,Value=analyst@example.com Name=email_verified,Value=true \\"
echo "     --temporary-password 'Temp1234!' \\"
echo "     --message-action SUPPRESS"
echo ""
echo "2. Publish Cognito login branding (one-time):"
echo ""
echo "   aws$PROFILE_FLAG cognito-idp create-managed-login-branding \\"
echo "     --user-pool-id $POOL_ID \\"
echo "     --client-id $CLIENT_ID \\"
echo "     --use-cognito-provided-values"
echo ""
echo "3. Configure frontend/.env.local — see cdk-outputs.json for values."
echo "4. Build and deploy the frontend — run: ./deploy-frontend.sh${PROFILE_FLAG}"
echo ""
