import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import type { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { enableS3Logging } from './enable-logging';
import { applyTags } from './apply-tags';

const REGION = process.env.REGION ?? process.env.AWS_REGION ?? 'us-east-1';
const TABLE = process.env.TABLE_NAME!;
const LOGGING_BUCKET = process.env.LOGGING_BUCKET!;

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } },
);

const s3 = new S3Client({ region: REGION });

// Only these two actions are allowed in MVP Tier 1
const ALLOWED_ACTIONS = new Set(['enable_s3_logging', 'tag_resource']);

/**
 * Execution Lambda — triggered by DynamoDB stream when task status → APPROVED.
 *
 * ARCHITECTURE RULES enforced here:
 *  1. Only fires on PENDING → APPROVED transitions (not on re-approval or other changes)
 *  2. Only executes actions in ALLOWED_ACTIONS
 *  3. Validates resource ARN and action_params before executing
 *  4. Tags every modified resource
 *  5. Marks the task EXECUTED on success, FAILED on any error
 *  6. Never throws — errors are captured and written back to DynamoDB
 */
export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  for (const record of event.Records) {
    await processRecord(record);
  }
};

async function processRecord(record: DynamoDBRecord): Promise<void> {
  // Only act on MODIFY events (INSERT = new task, REMOVE = shouldn't happen)
  if (record.eventSource !== 'aws:dynamodb' || record.eventName !== 'MODIFY') {
    return;
  }

  const newImage = record.dynamodb?.NewImage;
  const oldImage = record.dynamodb?.OldImage;

  if (!newImage || !oldImage) return;

  const taskId = newImage.task_id?.S;
  const newStatus = newImage.status?.S;
  const oldStatus = oldImage.status?.S;

  // Only fire on PENDING → APPROVED transition
  // (avoids re-processing retries or APPROVED → EXECUTED updates)
  if (!taskId || oldStatus !== 'PENDING' || newStatus !== 'APPROVED') {
    return;
  }

  const action = newImage.action?.S;
  const resourceId = newImage.resource_id?.S;
  const actionParams = newImage.action_params?.S;
  const findingId = newImage.finding_id?.S ?? 'unknown';

  console.log('Processing approved task', { taskId, action, resourceId, findingId });

  // ── Validate ──────────────────────────────────────────────────────────────
  if (!action || !ALLOWED_ACTIONS.has(action)) {
    await markFailed(taskId, `Rejected: action '${action}' is not in the MVP allowed list`);
    return;
  }

  if (!resourceId?.startsWith('arn:aws:')) {
    await markFailed(taskId, `Rejected: resource '${resourceId}' is not a valid AWS ARN`);
    return;
  }

  if (action === 'enable_s3_logging' && !resourceId.startsWith('arn:aws:s3:::')) {
    await markFailed(taskId, `Rejected: enable_s3_logging requires an S3 ARN (arn:aws:s3:::*)`);
    return;
  }

  if (action === 'tag_resource' && !actionParams) {
    await markFailed(taskId, 'Rejected: tag_resource requires action_params with tag key-value pairs');
    return;
  }

  // ── Execute ───────────────────────────────────────────────────────────────
  try {
    let result: { success: boolean; message: string };

    if (action === 'enable_s3_logging') {
      if (!LOGGING_BUCKET) {
        await markFailed(taskId, 'Configuration error: LOGGING_BUCKET env var not set');
        return;
      }
      const bucketName = resourceId.replace('arn:aws:s3:::', '').split('/')[0];
      if (!bucketName) {
        await markFailed(taskId, `Rejected: could not extract bucket name from ARN '${resourceId}'`);
        return;
      }
      result = await enableS3Logging(s3, bucketName, LOGGING_BUCKET);
    } else {
      // tag_resource
      result = await applyTags(resourceId, actionParams!);
    }

    if (result.success) {
      await markExecuted(taskId, result.message);
      console.log('Task executed successfully', { taskId, message: result.message });
    } else {
      await markFailed(taskId, result.message);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error('Action execution failed', { taskId, action, resourceId, error: e });
    await markFailed(taskId, `Execution error: ${msg}`);
  }
}

// ── DynamoDB status helpers ────────────────────────────────────────────────────

async function markExecuted(taskId: string, resultMessage: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { task_id: taskId },
      // Guard: only update if still APPROVED (idempotent on retry)
      ConditionExpression: '#s = :approved',
      UpdateExpression: 'SET #s = :executed, executed_at = :now, #result = :result',
      ExpressionAttributeNames: {
        '#s': 'status',
        '#result': 'result',
      },
      ExpressionAttributeValues: {
        ':approved': 'APPROVED',
        ':executed': 'EXECUTED',
        ':now': new Date().toISOString(),
        ':result': resultMessage,
      },
    }),
  ).catch((e: unknown) => {
    // ConditionalCheckFailedException means status already changed (e.g. re-delivery)
    if ((e as { name?: string }).name !== 'ConditionalCheckFailedException') throw e;
    console.warn('markExecuted: task status already changed, skipping update', { taskId });
  });
}

async function markFailed(taskId: string, reason: string): Promise<void> {
  console.error('Marking task as FAILED', { taskId, reason });
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { task_id: taskId },
      ConditionExpression: '#s = :approved',
      UpdateExpression: 'SET #s = :failed, executed_at = :now, #result = :result',
      ExpressionAttributeNames: {
        '#s': 'status',
        '#result': 'result',
      },
      ExpressionAttributeValues: {
        ':approved': 'APPROVED',
        ':failed': 'FAILED',
        ':now': new Date().toISOString(),
        ':result': reason,
      },
    }),
  ).catch((e: unknown) => {
    if ((e as { name?: string }).name !== 'ConditionalCheckFailedException') throw e;
    console.warn('markFailed: task status already changed, skipping update', { taskId });
  });
}
