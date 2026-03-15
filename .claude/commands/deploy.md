# deploy

Run the deployment scripts for the security-triage-agent project.

Ask the user which parts they want to deploy if it isn't clear from context:
- **Full deploy** (infrastructure + frontend) — use both scripts
- **Infrastructure only** — `deploy.sh`
- **Frontend only** — `deploy-frontend.sh`
- **Redeployment after code changes** — build Lambdas first, then run the relevant script

---

## Full deploy (first time or all stacks)

```bash
bash ./deploy.sh --profile <profile> --region us-east-1 --owner you@example.com
```

This single script handles everything:
1. Builds all CDK and Lambda packages
2. Bootstraps CDK (safe to re-run)
3. Deploys all stacks in correct order (SecurityTriageStack → AgentStack → FrontendStack)
4. Saves outputs to `cdk-outputs.json`
5. Prints the remaining manual steps (Cognito user creation, login branding)

After `deploy.sh` completes, if the frontend `.env.local` is already configured:
```bash
bash ./deploy-frontend.sh --profile <profile>
```

---

## Redeployment after Lambda or CDK changes

When code has changed since the last deploy, build first:

```bash
cd lambda/agent-tools && npm run build
cd ../api && npm run build
cd ../execution && npm run build
cd ../../cdk && npm run build
```

Then re-run the deploy script — it will only update changed stacks:
```bash
bash ./deploy.sh --profile <profile>
```

Or if only the frontend changed:
```bash
bash ./deploy-frontend.sh --profile <profile>
```

---

## Frontend only

```bash
bash ./deploy-frontend.sh --profile <profile>
```

Requires `cdk-outputs.json` and `frontend/.env.local` to exist. After completion the script prints the CloudFront URL.

---

## Post-deploy checklist

After any infrastructure deploy, verify:
1. `cdk-outputs.json` contains `UserPoolId`, `UserPoolClientId`, `ApiUrl`, `CloudFrontUrl`
2. `frontend/.env.local` values match the new outputs (especially if API URL or Cognito domain changed)
3. The AgentStack deploy triggered `AgentPrepareResource` — check CloudFormation events if the agent behaves unexpectedly after a schema change
