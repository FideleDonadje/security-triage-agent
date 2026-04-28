/**
 * compliance.ts — compliance workspace API handlers
 *
 * Routes:
 *   GET  /systems/:systemId              — read system metadata
 *   PUT  /systems/:systemId/settings     — update system name/owner/account/region
 *   GET  /systems/:systemId/documents    — list all document metadata (no S3 content)
 *   PUT  /systems/:systemId/documents/FIPS199  — sync save FIPS 199 C/I/A values
 *   POST /systems/:systemId/documents/:docType/generate — trigger async generation
 *   GET  /systems/:systemId/documents/:docType          — status + presigned URL
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import type { AuthContext } from './auth';

// ── Config ─────────────────────────────────────────────────────────────────────
const REGION          = process.env.REGION ?? process.env.AWS_REGION ?? 'us-east-1';
const SYSTEMS_TABLE   = process.env.SYSTEMS_TABLE_NAME!;
const COMPLIANCE_BUCKET = process.env.COMPLIANCE_BUCKET!;
const PRESIGNED_TTL_S = 3600;
const STUCK_TIMEOUT_MS = 12 * 60 * 1000;

// ── AWS clients ────────────────────────────────────────────────────────────────
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({ region: REGION });

// ── Valid document types ───────────────────────────────────────────────────────
const VALID_DOC_TYPES = new Set(['POAM', 'SSP', 'SAR', 'RA', 'CONMON', 'IRP']);

// Impact levels ranked for FIPS 199 overall impact computation
const IMPACT_RANK: Record<string, number> = { Low: 0, Moderate: 1, High: 2 };
const IMPACT_LEVELS = ['Low', 'Moderate', 'High'];

// ── GET /systems/:systemId ─────────────────────────────────────────────────────

export async function handleGetSystem(
  event: APIGatewayProxyEvent,
  _auth: AuthContext,
): Promise<APIGatewayProxyResult> {
  const systemId = event.pathParameters?.systemId;
  if (!systemId) return err(400, 'systemId is required');

  const result = await ddb.send(new GetCommand({
    TableName: SYSTEMS_TABLE,
    Key: { pk: `SYSTEM#${systemId}`, sk: 'METADATA' },
  }));

  if (!result.Item) return err(404, 'System not found');
  return ok(result.Item);
}

// ── PUT /systems/:systemId/settings ───────────────────────────────────────────

export async function handleUpdateSettings(
  event: APIGatewayProxyEvent,
  auth: AuthContext,
): Promise<APIGatewayProxyResult> {
  const systemId = event.pathParameters?.systemId;
  if (!systemId) return err(400, 'systemId is required');

  let body: Record<string, string>;
  try {
    body = JSON.parse(event.body ?? '{}') as Record<string, string>;
  } catch {
    return err(400, 'Invalid JSON body');
  }

  const allowed = ['systemName', 'ownerName', 'ownerEmail', 'awsAccountId', 'region'];
  const updates = Object.fromEntries(
    Object.entries(body).filter(([k]) => allowed.includes(k)),
  );

  if (Object.keys(updates).length === 0) return err(400, 'No valid fields to update');

  const setExpr  = Object.keys(updates).map((k, i) => `#f${i} = :v${i}`).join(', ');
  const names    = Object.fromEntries(Object.keys(updates).map((k, i) => [`#f${i}`, k]));
  const values   = Object.fromEntries(Object.keys(updates).map((k, i) => [`:v${i}`, updates[k]]));
  values[':updater'] = auth.email;
  values[':now']     = new Date().toISOString();

  await ddb.send(new UpdateCommand({
    TableName:                 SYSTEMS_TABLE,
    Key:                       { pk: `SYSTEM#${systemId}`, sk: 'METADATA' },
    ConditionExpression:       'attribute_exists(pk)',
    UpdateExpression:          `SET ${setExpr}, updatedAt = :now, updatedBy = :updater`,
    ExpressionAttributeNames:  names,
    ExpressionAttributeValues: values,
  }));

  return ok({ updated: true });
}

// ── GET /systems/:systemId/documents ──────────────────────────────────────────

export async function handleListDocuments(
  event: APIGatewayProxyEvent,
  _auth: AuthContext,
): Promise<APIGatewayProxyResult> {
  const systemId = event.pathParameters?.systemId;
  if (!systemId) return err(400, 'systemId is required');

  const result = await ddb.send(new QueryCommand({
    TableName:                 SYSTEMS_TABLE,
    KeyConditionExpression:    'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': `SYSTEM#${systemId}`, ':prefix': 'DOC#NIST#' },
  }));

  const documents = (result.Items ?? []).map(stripS3Key);
  return ok({ documents });
}

// ── PUT /systems/:systemId/documents/FIPS199 ──────────────────────────────────

export async function handleSaveFips199(
  event: APIGatewayProxyEvent,
  auth: AuthContext,
): Promise<APIGatewayProxyResult> {
  const systemId = event.pathParameters?.systemId;
  if (!systemId) return err(400, 'systemId is required');

  let body: { confidentiality?: string; integrity?: string; availability?: string };
  try {
    body = JSON.parse(event.body ?? '{}') as typeof body;
  } catch {
    return err(400, 'Invalid JSON body');
  }

  const { confidentiality, integrity, availability } = body;
  const valid = ['Low', 'Moderate', 'High'];
  if (!confidentiality || !integrity || !availability ||
      !valid.includes(confidentiality) || !valid.includes(integrity) || !valid.includes(availability)) {
    return err(400, 'confidentiality, integrity, and availability must each be Low, Moderate, or High');
  }

  const overallImpact = IMPACT_LEVELS[
    Math.max(IMPACT_RANK[confidentiality] ?? 0, IMPACT_RANK[integrity] ?? 0, IMPACT_RANK[availability] ?? 0)
  ];

  await ddb.send(new PutCommand({
    TableName: SYSTEMS_TABLE,
    Item: {
      pk:              `SYSTEM#${systemId}`,
      sk:              'DOC#NIST#FIPS199',
      confidentiality,
      integrity,
      availability,
      overallImpact,
      updatedAt:       new Date().toISOString(),
      updatedBy:       auth.email,
    },
  }));

  return ok({ overallImpact });
}

// ── POST /systems/:systemId/documents/:docType/generate ───────────────────────

export async function handleGenerateDocument(
  event: APIGatewayProxyEvent,
  auth: AuthContext,
): Promise<APIGatewayProxyResult> {
  const systemId = event.pathParameters?.systemId;
  const docType  = event.pathParameters?.docType?.toUpperCase();

  if (!systemId) return err(400, 'systemId is required');
  if (!docType || !VALID_DOC_TYPES.has(docType)) return err(400, `docType must be one of: ${[...VALID_DOC_TYPES].join(', ')}`);

  const generationId = randomUUID();
  const pk = `SYSTEM#${systemId}`;
  const sk = `DOC#NIST#${docType}`;

  try {
    await ddb.send(new UpdateCommand({
      TableName:                 SYSTEMS_TABLE,
      Key:                       { pk, sk },
      // Block double-submit: allow new items (attribute_not_exists) and non-IN_PROGRESS items
      ConditionExpression:       'attribute_not_exists(#s) OR #s <> :inprogress',
      UpdateExpression:          'SET #s = :pending, generationId = :genId, generatedBy = :email, generationStartedAt = :now',
      ExpressionAttributeNames:  { '#s': 'status' },
      ExpressionAttributeValues: {
        ':inprogress': 'IN_PROGRESS',
        ':pending':    'PENDING',
        ':genId':      generationId,
        ':email':      auth.email,
        ':now':        new Date().toISOString(),
      },
    }));
  } catch (e: unknown) {
    if ((e as { name?: string }).name === 'ConditionalCheckFailedException') {
      return err(409, 'Document generation is already in progress');
    }
    throw e;
  }

  return {
    statusCode: 202,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'PENDING', generationId }),
  };
}

// ── GET /systems/:systemId/documents/:docType ──────────────────────────────────

export async function handleGetDocument(
  event: APIGatewayProxyEvent,
  _auth: AuthContext,
): Promise<APIGatewayProxyResult> {
  const systemId = event.pathParameters?.systemId;
  const docType  = event.pathParameters?.docType?.toUpperCase();

  if (!systemId) return err(400, 'systemId is required');
  if (!docType) return err(400, 'docType is required');

  const pk = `SYSTEM#${systemId}`;
  const sk = `DOC#NIST#${docType}`;

  const result = await ddb.send(new GetCommand({ TableName: SYSTEMS_TABLE, Key: { pk, sk } }));

  if (!result.Item) {
    // Document has never been generated — return a blank stub
    return ok({ pk, sk, status: null, docType });
  }

  const item = result.Item as Record<string, unknown>;

  // Stuck detection: IN_PROGRESS for longer than threshold → surface as FAILED
  if (item['status'] === 'IN_PROGRESS') {
    const startedAt = item['generationStartedAt'] as string | undefined;
    if (startedAt && Date.now() - new Date(startedAt).getTime() > STUCK_TIMEOUT_MS) {
      return ok({ ...stripS3Key(item), status: 'FAILED', error: 'Generation timed out — the repair job will clean this up shortly' });
    }
  }

  // For completed documents, attach a fresh presigned URL
  if (item['status'] === 'COMPLETED' && item['s3Key']) {
    const presignedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: COMPLIANCE_BUCKET, Key: item['s3Key'] as string }),
      { expiresIn: PRESIGNED_TTL_S },
    );
    return ok({ ...stripS3Key(item), presignedUrl });
  }

  return ok(stripS3Key(item));
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// Strip s3Key from responses — clients use presigned URLs, not raw keys
function stripS3Key(item: Record<string, unknown>): Record<string, unknown> {
  const { s3Key: _s3Key, ...rest } = item;
  return rest;
}

function ok(body: unknown): APIGatewayProxyResult {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function err(status: number, message: string): APIGatewayProxyResult {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: message }) };
}
