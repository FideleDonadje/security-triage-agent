#!/usr/bin/env bash
# deploy.sh — full infrastructure deploy for the Security Triage Agent
#
# Two-pass strategy:
#   Pass 1 — deploys FrontendStack alone → CloudFront URL written to SSM
#   Pass 2 — deploys SecurityTriageStack + AgentStack, passing the CloudFront
#             URL as CDK context so Cognito callback URLs are configured correctly
#
# Usage:
#   ./deploy.sh [--profile myprofile] [--region us-east-1] [--env dev] [--owner you@example.com]
set -euo pipefail

# Prevent Git Bash from converting /security-triage/... paths to Windows paths
export MSYS_NO_PATHCONV=1

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

if [[ -n "$PROFILE" ]]; then
  export AWS_PROFILE="$PROFILE"
fi

PROFILE_ARG=""
[[ -n "$PROFILE" ]] && PROFILE_ARG="--profile $PROFILE"

export CDK_DEFAULT_REGION="$REGION"
export CDK_DEFAULT_ACCOUNT="$ACCOUNT"
export DEPLOY_ENV="$ENV"
export OWNER_EMAIL="$OWNER"

# ── Preflight checks ──────────────────────────────────────────────────────────
echo "==> Checking prerequisites..."

command -v aws  >/dev/null 2>&1 || { echo "ERROR: AWS CLI not found."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js not found. Install Node 22+."; exit 1; }
command -v cdk  >/dev/null 2>&1 || { echo "ERROR: CDK CLI not found. Run: npm install -g aws-cdk"; exit 1; }

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

# ── Step 1: Build CDK and Lambdas ─────────────────────────────────────────────
echo ""
echo "==> Building CDK..."
(cd cdk && npm install --silent && npm run build)

echo ""
echo "==> CDK template verified (TypeScript build passed above)."

echo ""
echo "==> Building Lambda packages..."
for pkg in api execution agent-tools agent-prepare ato-trigger ato-worker compliance-worker compliance-repair; do
  echo "    lambda/$pkg"
  (cd "lambda/$pkg" && npm install --silent && npm run build --silent)
done

# ── Step 2: CDK bootstrap ─────────────────────────────────────────────────────
echo ""
echo "==> Bootstrapping CDK (safe to re-run)..."
# shellcheck disable=SC2086
(cd cdk && cdk bootstrap "aws://$ACCOUNT/$REGION" $PROFILE_ARG --no-notices 2>&1 | tail -5)

# ── Step 3: Pass 1 — deploy FrontendStack to get the CloudFront URL ───────────
echo ""
echo "==> Pass 1: deploying FrontendStack..."
# shellcheck disable=SC2086
(cd cdk && cdk deploy SecurityTriageFrontendStack \
  $PROFILE_ARG --require-approval never --no-notices)

echo "==> Reading CloudFront URL from SSM..."
echo "    Region  : $REGION"
echo "    Profile : ${PROFILE:-default}"
echo "    Param   : /security-triage/cloudfront-url"
echo "    Command : aws ssm get-parameter $PROFILE_ARG --region $REGION --name /security-triage/cloudfront-url"

# shellcheck disable=SC2086
CLOUDFRONT_URL=$(aws ssm get-parameter \
  $PROFILE_ARG \
  --region "$REGION" \
  --name /security-triage/cloudfront-url \
  --query Parameter.Value --output text 2>&1) || true

if [[ "$CLOUDFRONT_URL" == *"ParameterNotFound"* || "$CLOUDFRONT_URL" == *"error"* || -z "$CLOUDFRONT_URL" ]]; then
  echo "ERROR: SSM read failed: $CLOUDFRONT_URL"
  echo ""
  echo "Listing all /security-triage/* parameters:"
  # shellcheck disable=SC2086
  aws ssm get-parameters-by-path \
    $PROFILE_ARG \
    --path /security-triage \
    --region "$REGION" \
    --query 'Parameters[*].Name' --output table 2>&1
  exit 1
fi

echo "    CloudFront URL: $CLOUDFRONT_URL"

# ── Step 4: Pass 2 — deploy core + agent with the real CloudFront URL ─────────
echo ""
echo "==> Pass 2: deploying SecurityTriageStack + AgentStack..."
# shellcheck disable=SC2086
(cd cdk && cdk deploy SecurityTriageStack SecurityTriageAgentStack SecurityTriageComplianceStack \
  $PROFILE_ARG \
  --context frontendUrl="$CLOUDFRONT_URL" \
  --require-approval never --no-notices \
  --outputs-file ../cdk-outputs.json)

# ── Step 5: Build and deploy the frontend ────────────────────────────────────
echo ""
PROFILE_FLAG=""
[[ -n "$PROFILE" ]] && PROFILE_FLAG="--profile $PROFILE"
# shellcheck disable=SC2086
"$(dirname "$0")/deploy-frontend.sh" $PROFILE_FLAG --region "$REGION"

# ── Step 6: Print next steps ──────────────────────────────────────────────────
# shellcheck disable=SC2086
POOL_ID=$(aws ssm get-parameter \
  $PROFILE_ARG \
  --name /security-triage/user-pool-id \
  --region "$REGION" \
  --query Parameter.Value --output text 2>/dev/null || echo "<UserPoolId>")
CLIENT_ID=$(aws ssm get-parameter \
  --name /security-triage/user-pool-client-id \
  --region "$REGION" --query Parameter.Value --output text 2>/dev/null || echo "<UserPoolClientId>")

echo "=================================================="
echo " Deploy complete."
echo "=================================================="
echo ""
echo "Create the analyst account (one-time):"
echo ""
echo "   aws cognito-idp admin-create-user \\"
echo "     --user-pool-id $POOL_ID \\"
echo "     --username analyst@example.com \\"
echo "     --user-attributes Name=email,Value=analyst@example.com Name=email_verified,Value=true \\"
echo "     --temporary-password 'Temp1234!' \\"
echo "     --message-action SUPPRESS"
echo ""
