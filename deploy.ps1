# deploy.ps1 — full infrastructure deploy for the Security Triage Agent (PowerShell)
# Mirrors deploy.sh exactly — two-pass CDK deploy, then frontend build + sync.
#
# Usage:
#   .\deploy.ps1 [-Profile myprofile] [-Region us-east-1] [-Env dev] [-Owner you@example.com]

param(
  [string]$AwsProfile = $env:AWS_PROFILE,
  [string]$Region  = $(if ($env:CDK_DEFAULT_REGION) { $env:CDK_DEFAULT_REGION } else { 'us-east-1' }),
  [string]$Account = $env:CDK_DEFAULT_ACCOUNT,
  [string]$Env     = $(if ($env:DEPLOY_ENV) { $env:DEPLOY_ENV } else { 'dev' }),
  [string]$Owner   = $(if ($env:OWNER_EMAIL) { $env:OWNER_EMAIL } else { 'unknown' })
)

$ErrorActionPreference = 'Stop'

# ── Apply profile ──────────────────────────────────────────────────────────────
if ($AwsProfile) { $env:AWS_PROFILE = $AwsProfile }

$env:CDK_DEFAULT_REGION  = $Region
$env:CDK_DEFAULT_ACCOUNT = $Account
$env:DEPLOY_ENV          = $Env
$env:OWNER_EMAIL         = $Owner

# ── Preflight checks ──────────────────────────────────────────────────────────
Write-Host "==> Checking prerequisites..."

foreach ($cmd in @('aws', 'node', 'cdk')) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Error "ERROR: '$cmd' not found. Install it and try again."; exit 1
  }
}

if (-not $Account) {
  $Account = aws sts get-caller-identity --query Account --output text
  if ($LASTEXITCODE -ne 0) { Write-Error "ERROR: Could not resolve AWS account."; exit 1 }
  $env:CDK_DEFAULT_ACCOUNT = $Account
}

Write-Host "    Profile : $(if ($AwsProfile) { $AwsProfile } else { 'default' })"
Write-Host "    Account : $Account"
Write-Host "    Region  : $Region"
Write-Host "    Env     : $Env"
Write-Host "    Owner   : $Owner"

# ── Step 1: Build CDK and Lambdas ─────────────────────────────────────────────
Write-Host ""
Write-Host "==> Building CDK..."
Push-Location cdk
npm install --silent; if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
npm run build --silent; if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
Pop-Location

Write-Host "==> Building Lambda packages..."
foreach ($pkg in @('api', 'execution', 'agent-tools', 'agent-prepare', 'ato-trigger', 'ato-worker')) {
  Write-Host "    lambda/$pkg"
  Push-Location "lambda/$pkg"
  npm install --silent; if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
  npm run build --silent; if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
  Pop-Location
}

# ── Step 2: CDK bootstrap ─────────────────────────────────────────────────────
Write-Host ""
Write-Host "==> Bootstrapping CDK (safe to re-run)..."
Push-Location cdk
cdk bootstrap "aws://$Account/$Region" --no-notices 2>&1 | Select-Object -Last 5
Pop-Location

# ── Step 3: Pass 1 — deploy FrontendStack ─────────────────────────────────────
Write-Host ""
Write-Host "==> Pass 1: deploying FrontendStack..."
Push-Location cdk
cdk deploy SecurityTriageFrontendStack --require-approval never --no-notices
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
Pop-Location

$CloudFrontUrl = aws ssm get-parameter `
  --name /security-triage/cloudfront-url `
  --region $Region `
  --query Parameter.Value --output text
Write-Host "    CloudFront URL: $CloudFrontUrl"

# ── Step 4: Pass 2 — deploy SecurityTriageStack + AgentStack ──────────────────
Write-Host ""
Write-Host "==> Pass 2: deploying SecurityTriageStack + AgentStack..."
Push-Location cdk
cdk deploy SecurityTriageStack SecurityTriageAgentStack `
  --context "frontendUrl=$CloudFrontUrl" `
  --require-approval never --no-notices `
  --outputs-file ..\cdk-outputs.json
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
Pop-Location

# ── Step 5: Build and deploy the frontend ─────────────────────────────────────
Write-Host ""
$frontendArgs = @("--Region", $Region)
if ($AwsProfile) { $frontendArgs += @("--Profile", $AwsProfile) }
& "$PSScriptRoot\deploy-frontend.ps1" @frontendArgs

# ── Step 6: Next steps ────────────────────────────────────────────────────────
$PoolId = aws ssm get-parameter `
  --name /security-triage/user-pool-id `
  --region $Region --query Parameter.Value --output text 2>$null
if (-not $PoolId) { $PoolId = '<UserPoolId>' }

Write-Host ""
Write-Host "=================================================="
Write-Host " Deploy complete."
Write-Host "=================================================="
Write-Host ""
Write-Host "Create the analyst account (one-time):"
Write-Host ""
Write-Host "  aws cognito-idp admin-create-user ``"
Write-Host "    --user-pool-id $PoolId ``"
Write-Host "    --username analyst@example.com ``"
Write-Host "    --user-attributes Name=email,Value=analyst@example.com Name=email_verified,Value=true ``"
Write-Host "    --temporary-password 'Temp1234!' ``"
Write-Host "    --message-action SUPPRESS"
Write-Host ""
