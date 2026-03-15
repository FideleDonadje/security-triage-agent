# add-execution-action

Scaffold a new Tier 1 remediation action end-to-end. The user will provide an action name and description. If they haven't, ask for:
- Action name (snake_case, e.g. `enable_vpc_flow_logs`)
- What AWS API it calls to make the change
- What parameters it needs (resource ARN is always required; what else?)
- What audit tag it should apply

Then make ALL of the following changes in order:

## 1 — lambda/execution/{action-name}.ts  (new file)

Create a new file following the exact pattern of `enable-logging.ts`:

```typescript
import { ... } from '@aws-sdk/client-...';
import type { ActionResult } from './index';

const REGION = process.env.REGION ?? process.env.AWS_REGION ?? 'us-east-1';
const client = new XClient({ region: REGION });

export async function actionName(resourceArn: string): Promise<ActionResult> {
  // 1. Parse the resource identifier from the ARN
  // 2. Call the AWS API to make the change
  // 3. Tag the resource with audit tags:
  //    'security-agent-action': 'action_name'
  //    'security-agent-executed-at': new Date().toISOString()
  // 4. Return { success: true, message: '...' }
}
```

Key rules:
- Every action MUST tag the resource it touches (architecture rule #4)
- Validate the ARN format before calling any API
- Return `{ success: false, message: 'reason' }` on failure — do not throw

## 2 — lambda/execution/index.ts

**Import** the new function at the top.

**Add to `ALLOWED_ACTIONS`**:
```typescript
const ALLOWED_ACTIONS = ['enable_s3_logging', 'tag_resource', 'your_new_action'] as const;
```

**Add a branch** in the main switch/if block to call the new function with the correct parameters parsed from the DynamoDB stream record.

**Validate the ARN** in the same style as existing branches (e.g. require `arn:aws:service:::`).

## 3 — lambda/execution/package.json

Add any new AWS SDK dependency if needed.

## 4 — cdk/lib/security-triage-stack.ts

Add the required IAM permissions to the **execution Lambda role** (`executionLambdaRole`):
- The specific `service:Action` needed to make the change
- Tagging permission for that service if needed (e.g. `ec2:CreateTags`)
- Scope to `*` only if a tighter ARN pattern is not feasible

## 5 — cdk/lib/agent-stack.ts

Update the `queue_task` Bedrock parameter description to list the new action name alongside existing ones. Update the system prompt RULES section (rule 2) to include the new action.

Bump `configVersion` by 1.

## 6 — CLAUDE.md

- Add the new action to the **Action tiers** → Tier 1 list
- Add it to the `action` field in the Task record shape

## 7 — Build

```bash
cd lambda/execution && npm run build
cd ../agent-tools && npm run build
cd ../../cdk && npm run build
```

Fix any TypeScript errors before proceeding.

## 8 — Report

Print a summary of every file changed and remind the user to run:
```bash
cd cdk && cdk deploy SecurityTriageStack SecurityTriageAgentStack --require-approval never
```
