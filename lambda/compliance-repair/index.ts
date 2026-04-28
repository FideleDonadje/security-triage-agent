/**
 * compliance-repair/index.ts — stuck-job detector and DLQ recovery
 *
 * Two triggers:
 *   1. EventBridge schedule (every 5 min) — scans for IN_PROGRESS documents
 *      that have been stuck longer than STUCK_THRESHOLD_MIN and marks them FAILED.
 *   2. SQS DLQ — receives records from the compliance-worker DLQ (failed Lambda
 *      invocations that exhausted retries). Extracts the pk/sk and marks FAILED.
 *
 * This Lambda has only one write action: DynamoDB UpdateItem to set status=FAILED.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent, SQSRecord, ScheduledEvent } from 'aws-lambda';

// ── Config ─────────────────────────────────────────────────────────────────────
const REGION              = process.env.REGION ?? process.env.AWS_REGION ?? 'us-east-1';
const SYSTEMS_TABLE       = process.env.SYSTEMS_TABLE_NAME!;
const STATUS_INDEX_NAME   = process.env.STATUS_INDEX_NAME ?? 'status-all-index';
const STUCK_THRESHOLD_MIN = parseInt(process.env.STUCK_THRESHOLD_MIN ?? '16', 10);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

// ── Handler ────────────────────────────────────────────────────────────────────

export const handler = async (event: SQSEvent | ScheduledEvent): Promise<void> => {
  // SQS DLQ trigger: failed worker records
  if ('Records' in event && event.Records?.[0]?.eventSource === 'aws:sqs') {
    await handleDlqRecords((event as SQSEvent).Records);
    return;
  }

  // EventBridge scheduled trigger: scan for stuck jobs
  await handleStuckJobScan();
};

// ── DLQ recovery ───────────────────────────────────────────────────────────────

async function handleDlqRecords(records: SQSRecord[]): Promise<void> {
  for (const record of records) {
    try {
      const body = JSON.parse(record.body) as unknown;
      const { pk, sk } = extractPkSkFromDlqBody(body);
      if (!pk || !sk) {
        console.warn('DLQ record missing pk/sk — skipping', { messageId: record.messageId });
        continue;
      }
      await markFailed(pk, sk, 'Processing failed after retries — check compliance-worker logs');
      console.log('DLQ recovery: marked FAILED', { pk, sk });
    } catch (e: unknown) {
      console.error('Failed to process DLQ record', { messageId: record.messageId, error: (e as Error).message });
    }
  }
}

function extractPkSkFromDlqBody(body: unknown): { pk?: string; sk?: string } {
  // DynamoDB stream failure records include the original stream record in the DLQ message.
  // The structure varies — try multiple paths defensively.
  const b = body as Record<string, unknown>;

  // Path 1: direct DynamoDB stream record wrapped in DLQ
  const dynamoRecord = b?.['DynamoDB'] as Record<string, unknown> | undefined;
  const newImage     = (dynamoRecord?.['NewImage'] ?? (b?.['dynamodb'] as Record<string, unknown>)?.['NewImage']) as Record<string, Record<string, string>> | undefined;
  if (newImage?.['pk']?.['S'] && newImage?.['sk']?.['S']) {
    return { pk: newImage['pk']['S'], sk: newImage['sk']['S'] };
  }

  // Path 2: requestContext with item identity
  const item = b?.['item'] as Record<string, Record<string, string>> | undefined;
  if (item?.['pk']?.['S'] && item?.['sk']?.['S']) {
    return { pk: item['pk']['S'], sk: item['sk']['S'] };
  }

  return {};
}

// ── Stuck-job scan ─────────────────────────────────────────────────────────────

async function handleStuckJobScan(): Promise<void> {
  const stuckBefore = new Date(Date.now() - STUCK_THRESHOLD_MIN * 60 * 1000).toISOString();

  // Query the status GSI for all IN_PROGRESS documents
  let lastKey: Record<string, unknown> | undefined;
  let stuckCount = 0;

  do {
    const result = await ddb.send(new QueryCommand({
      TableName:                 SYSTEMS_TABLE,
      IndexName:                 STATUS_INDEX_NAME,
      KeyConditionExpression:    '#s = :inprogress',
      ExpressionAttributeNames:  { '#s': 'status' },
      ExpressionAttributeValues: { ':inprogress': 'IN_PROGRESS' },
      ExclusiveStartKey:         lastKey,
    }));

    for (const item of result.Items ?? []) {
      const pk = item['pk'] as string | undefined;
      const sk = item['sk'] as string | undefined;
      if (!pk || !sk) continue;

      // GSI may not project generationStartedAt if projection was KEYS_ONLY before migration.
      // Fall back to a GetItem to fetch the full record.
      let startedAt = item['generationStartedAt'] as string | undefined;
      if (!startedAt) {
        const full = await ddb.send(new GetCommand({ TableName: SYSTEMS_TABLE, Key: { pk, sk } }));
        startedAt = full.Item?.['generationStartedAt'] as string | undefined;
      }

      if (!startedAt || startedAt > stuckBefore) continue;

      await markFailed(pk, sk, `Generation timed out after ${STUCK_THRESHOLD_MIN} minutes`);
      stuckCount++;
      console.log('Stuck-job detector: marked FAILED', { pk, sk, startedAt });
    }

    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  if (stuckCount > 0) {
    console.log(`Stuck-job detector: repaired ${stuckCount} stuck jobs`);
  }
}

// ── DynamoDB helper ────────────────────────────────────────────────────────────

async function markFailed(pk: string, sk: string, reason: string): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName:                 SYSTEMS_TABLE,
      Key:                       { pk, sk },
      ConditionExpression:       '#s = :inprogress',
      UpdateExpression:          'SET #s = :failed, #err = :reason',
      ExpressionAttributeNames:  { '#s': 'status', '#err': 'error' },
      ExpressionAttributeValues: { ':inprogress': 'IN_PROGRESS', ':failed': 'FAILED', ':reason': reason },
    }));
  } catch (e: unknown) {
    // ConditionalCheckFailed means the job already moved to COMPLETED or was already FAILED — ignore
    if ((e as { name?: string }).name !== 'ConditionalCheckFailedException') {
      console.error('markFailed UpdateItem error', { pk, sk, error: (e as Error).message });
    }
  }
}
