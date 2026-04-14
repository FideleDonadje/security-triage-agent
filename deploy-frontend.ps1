# deploy-frontend.ps1 — builds the React app and deploys it to S3 + CloudFront (PowerShell)
# Mirrors deploy-frontend.sh exactly — reads all config from SSM, no .env.local needed.
#
# Usage:
#   .\deploy-frontend.ps1 [-Profile myprofile] [-Region us-east-1]

param(
  [string]$AwsProfile = $env:AWS_PROFILE,
  [string]$Region  = ($env:CDK_DEFAULT_REGION ?? 'us-east-1')
)

$ErrorActionPreference = 'Stop'

if ($AwsProfile) { $env:AWS_PROFILE = $AwsProfile }

# ── Read all config from SSM ───────────────────────────────────────────────────
Write-Host "==> Reading config from SSM..."

function SSMGet($name) {
  $val = aws ssm get-parameter --name $name --region $Region --query Parameter.Value --output text
  if ($LASTEXITCODE -ne 0) { Write-Error "Failed to read SSM parameter: $name"; exit 1 }
  return $val
}

$Bucket           = SSMGet '/security-triage/frontend-bucket-name'
$DistId           = SSMGet '/security-triage/cloudfront-distribution-id'
$CfUrl            = SSMGet '/security-triage/cloudfront-url'
$ApiUrl           = SSMGet '/security-triage/api-url'
$UserPoolId       = SSMGet '/security-triage/user-pool-id'
$UserPoolClientId = SSMGet '/security-triage/user-pool-client-id'
$CognitoDomain    = SSMGet '/security-triage/cognito-domain'

Write-Host "    Bucket        : $Bucket"
Write-Host "    Distribution  : $DistId"
Write-Host "    CloudFront URL: $CfUrl"

# ── Build with env vars baked in ──────────────────────────────────────────────
Write-Host ""
Write-Host "==> Building frontend..."
Push-Location frontend

$env:VITE_API_URL             = $ApiUrl
$env:VITE_APP_URL             = $CfUrl
$env:VITE_USER_POOL_ID        = $UserPoolId
$env:VITE_USER_POOL_CLIENT_ID = $UserPoolClientId
$env:VITE_COGNITO_DOMAIN      = $CognitoDomain

npm install --silent; if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
npm run build;        if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
Pop-Location

# ── Sync to S3 ────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==> Syncing to s3://$Bucket ..."
aws s3 sync frontend/dist/ "s3://$Bucket/" --delete
if ($LASTEXITCODE -ne 0) { exit 1 }

# ── Invalidate CloudFront cache ───────────────────────────────────────────────
Write-Host ""
Write-Host "==> Invalidating CloudFront distribution $DistId ..."
$InvalidationId = aws cloudfront create-invalidation `
  --distribution-id $DistId `
  --paths "/*" `
  --query 'Invalidation.Id' `
  --output text
Write-Host "    Invalidation: $InvalidationId"

Write-Host ""
Write-Host "Frontend deployed. Open: $CfUrl"
Write-Host ""
