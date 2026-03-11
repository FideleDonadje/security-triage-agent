import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { AuthContext } from './auth';

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.REGION }),
  { marshallOptions: { removeUndefinedValues: true } },
);

const TABLE = process.env.TABLE_NAME!;
const STATUS_INDEX = process.env.STATUS_INDEX_NAME!;

// Valid task statuses the analyst can filter by
const VALID_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED'] as const;
type TaskStatus = (typeof VALID_STATUSES)[number];

/**
 * GET /tasks?status=PENDING
 *
 * Returns tasks from the status-index GSI, newest first.
 * Defaults to PENDING if no status query param is provided.
 */
export async function handleGetTasks(
  event: APIGatewayProxyEvent,
  _auth: AuthContext,
): Promise<APIGatewayProxyResult> {
  const status = (event.queryStringParameters?.status ?? 'PENDING').toUpperCase();

  if (!VALID_STATUSES.includes(status as TaskStatus)) {
    return err(400, `status must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: STATUS_INDEX,
      KeyConditionExpression: '#s = :status',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':status': status },
      ScanIndexForward: false, // newest created_at first
    }),
  );

  return ok({ tasks: result.Items ?? [], count: result.Count ?? 0 });
}

/**
 * POST /tasks/{task_id}/approve
 *
 * Transitions a PENDING task to APPROVED.
 * Sets approved_at and approved_by from the analyst's JWT.
 * Uses a ConditionExpression to prevent double-approval races.
 *
 * DynamoDB stream will detect status=APPROVED and trigger the Execution Lambda.
 */
export async function handleApproveTask(
  event: APIGatewayProxyEvent,
  auth: AuthContext,
): Promise<APIGatewayProxyResult> {
  const taskId = event.pathParameters?.task_id;
  if (!taskId) return err(400, 'task_id path parameter is required');

  // Verify the task exists and is PENDING before attempting the update
  const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: { task_id: taskId } }));

  if (!existing.Item) return err(404, 'Task not found');
  if (existing.Item.status !== 'PENDING') {
    return err(409, `Cannot approve: task is already ${existing.Item.status}`);
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { task_id: taskId },
        // ConditionExpression prevents a race where two analysts approve simultaneously
        ConditionExpression: '#s = :pending',
        UpdateExpression: 'SET #s = :approved, approved_at = :now, approved_by = :who',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':approved': 'APPROVED',
          ':pending': 'PENDING',
          ':now': new Date().toISOString(),
          ':who': auth.email,
        },
      }),
    );
  } catch (e: unknown) {
    if (isConditionalCheckFailed(e)) {
      return err(409, 'Task was already actioned by another request');
    }
    throw e;
  }

  return ok({ task_id: taskId, status: 'APPROVED', approved_by: auth.email });
}

/**
 * POST /tasks/{task_id}/reject
 *
 * Transitions a PENDING task to REJECTED.
 * Uses a ConditionExpression to prevent races.
 */
export async function handleRejectTask(
  event: APIGatewayProxyEvent,
  auth: AuthContext,
): Promise<APIGatewayProxyResult> {
  const taskId = event.pathParameters?.task_id;
  if (!taskId) return err(400, 'task_id path parameter is required');

  const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: { task_id: taskId } }));

  if (!existing.Item) return err(404, 'Task not found');
  if (existing.Item.status !== 'PENDING') {
    return err(409, `Cannot reject: task is already ${existing.Item.status}`);
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { task_id: taskId },
        ConditionExpression: '#s = :pending',
        UpdateExpression: 'SET #s = :rejected',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':rejected': 'REJECTED',
          ':pending': 'PENDING',
        },
      }),
    );
  } catch (e: unknown) {
    if (isConditionalCheckFailed(e)) {
      return err(409, 'Task was already actioned by another request');
    }
    throw e;
  }

  return ok({ task_id: taskId, status: 'REJECTED' });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(body: unknown): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function err(status: number, message: string): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: message }),
  };
}

function isConditionalCheckFailed(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'name' in e &&
    (e as { name: string }).name === 'ConditionalCheckFailedException'
  );
}
