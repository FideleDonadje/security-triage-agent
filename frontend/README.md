# frontend/

React + Vite single-page application — the analyst's interface to the agent.

## Layout

Two-panel layout:
- **Left panel** — Task Queue: pending approvals, recent activity, approve/reject/dismiss controls
- **Right panel** — Chat: conversation with the Bedrock agent

## Key files

| File | Purpose |
|---|---|
| `src/App.tsx` | Root component — auth gate, two-panel layout |
| `src/components/Chat.tsx` | Chat panel — message thread, input, polling for async responses |
| `src/components/TaskQueue.tsx` | Task queue panel — pending tasks, activity list, action buttons |
| `src/lib/api.ts` | API client — all calls to the backend Lambda (chat, tasks) |
| `src/lib/auth.ts` | Cognito PKCE auth flow — sign in, token refresh, sign out |
| `src/lib/config.ts` | Reads `VITE_*` environment variables |

## Local development

```bash
cp .env.example .env.local   # fill in values from cdk-outputs.json
npm install
npm run dev                  # starts at http://localhost:5173
```

The local dev server proxies to the deployed API — there is no local backend.

## Environment variables

All values come from `cdk-outputs.json` after running `deploy.sh`. See `.env.example` for the full list with field name references.

## Deploy

```bash
bash ../deploy-frontend.sh --profile myprofile
```

Builds the app, syncs to S3, and invalidates the CloudFront cache. The CloudFront URL is printed at the end.
