/**
 * ato-trigger/index.ts — ATO Assist API handler
 *
 * Routes (all require a valid Cognito JWT):
 *   GET  /ato/standards          — lists enabled Security Hub standards with ATO suitability
 *   POST /ato/generate           — creates a job record in DynamoDB, returns { jobId }
 *   GET  /ato/status/{jobId}     — returns job status; when COMPLETED includes a presigned S3 URL
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  SecurityHubClient,
  GetEnabledStandardsCommand,
  DescribeStandardsCommand,
} from '@aws-sdk/client-securityhub';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { randomUUID } from 'crypto';

// ── Config ─────────────────────────────────────────────────────────────────────
const REGION           = process.env.REGION ?? process.env.AWS_REGION ?? 'us-east-1';
const JOBS_TABLE        = process.env.JOBS_TABLE_NAME!;
const JOBS_USERNAME_IDX = process.env.JOBS_USERNAME_INDEX ?? 'username-index';
const REPORTS_BUCKET    = process.env.REPORTS_BUCKET!;
const TTL_DAYS         = 365 * 7; // 7-year retention — POAM reports are compliance artifacts
const STUCK_TIMEOUT_MS = 10 * 60 * 1000;
const PRESIGNED_TTL_S  = 3600;

// Standards that produce NIST-family control mappings usable in an ATO package.
// Others (FSBP, CIS) use proprietary control IDs that don't map to NIST families.
const ATO_SUITABLE_ARNS = [
  'arn:aws:securityhub:::ruleset/finding-format/aws/securityhub/nist-800-53',
  'nist-800-53',  // partial match fallback
  'fedramp',
];

// ── AWS clients ────────────────────────────────────────────────────────────────
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } },
);
const s3  = new S3Client({ region: REGION });
const hub = new SecurityHubClient({ region: REGION });

const verifier = CognitoJwtVerifier.create({
  userPoolId:  process.env.USER_POOL_ID!,
  tokenUse:    'id',
  clientId:    process.env.USER_POOL_CLIENT_ID!,
});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  process.env.ALLOWED_ORIGIN ?? '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

// ── Handler ────────────────────────────────────────────────────────────────────

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  let email: string;
  try {
    const authHeader = event.headers?.Authorization ?? event.headers?.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      const e = new Error('Missing Authorization header'); e.name = 'JwtMissingError'; throw e;
    }
    const payload = await verifier.verify(authHeader.slice(7));
    email = typeof payload.email === 'string' ? payload.email : payload.sub;
  } catch (e: unknown) {
    const isJwt = e instanceof Error && (e.name.startsWith('Jwt') || e.name === 'JwtMissingError');
    if (isJwt) {
      console.warn('JWT validation failed:', (e as Error).message);
      return withCors(err(401, 'Unauthorized'));
    }
    throw e;
  }

  const { httpMethod, resource } = event;

  try {
    if (httpMethod === 'GET' && resource === '/ato/standards') {
      return withCors(await handleStandards());
    }
    if (httpMethod === 'GET' && resource === '/ato/jobs') {
      return withCors(await handleJobs(email));
    }
    if (httpMethod === 'POST' && resource === '/ato/generate') {
      return withCors(await handleGenerate(event, email));
    }
    if (httpMethod === 'GET' && resource === '/ato/status/{jobId}') {
      const jobId = event.pathParameters?.jobId ?? '';
      return withCors(await handleStatus(jobId));
    }
    return withCors(err(404, `${httpMethod} ${resource} not found`));
  } catch (e: unknown) {
    console.error('ATO trigger unhandled error:', e);
    return withCors(err(500, 'Internal server error'));
  }
};

// ── GET /ato/standards ─────────────────────────────────────────────────────────

interface StandardInfo {
  standardsSubscriptionArn: string;
  standardsArn: string;
  name: string;
  description: string;
  status: string;
  atoSuitable: boolean;
  notSuitableReason?: string;
}

async function handleStandards(): Promise<APIGatewayProxyResult> {
  // Get enabled subscriptions
  const subscriptions = await hub.send(new GetEnabledStandardsCommand({}));
  const enabled = subscriptions.StandardsSubscriptions ?? [];

  if (enabled.length === 0) {
    return ok({ standards: [], message: 'No Security Hub standards are currently enabled.' });
  }

  // Get full standard metadata (name, description)
  const allStandards = await hub.send(new DescribeStandardsCommand({}));
  type StdMeta = { StandardsArn?: string; Name?: string; Description?: string };
  const metaByArn = new Map(
    (allStandards.Standards ?? []).map((s: StdMeta) => [s.StandardsArn, s] as const),
  );

  type SubMeta = { StandardsSubscriptionArn?: string; StandardsArn?: string; StandardsStatus?: string };
  const standards: StandardInfo[] = (enabled as SubMeta[]).map((sub) => {
    const meta  = metaByArn.get(sub.StandardsArn ?? '');
    const arn   = sub.StandardsArn ?? '';
    const name  = meta?.Name ?? arn.split('/').pop() ?? arn;
    const desc  = meta?.Description ?? '';
    const arnLc = arn.toLowerCase();

    const atoSuitable = ATO_SUITABLE_ARNS.some((pattern) => arnLc.includes(pattern));
    const notSuitableReason = atoSuitable
      ? undefined
      : 'This standard does not map findings to NIST 800-53 control families. ATO packages require NIST control mappings.';

    return {
      standardsSubscriptionArn: sub.StandardsSubscriptionArn ?? '',
      standardsArn: arn,
      name,
      description: desc,
      status: sub.StandardsStatus ?? 'UNKNOWN',
      atoSuitable,
      notSuitableReason,
    };
  });

  return ok({ standards });
}

// ── GET /ato/jobs ──────────────────────────────────────────────────────────────

async function handleJobs(email: string): Promise<APIGatewayProxyResult> {
  const result = await ddb.send(new QueryCommand({
    TableName: JOBS_TABLE,
    IndexName: JOBS_USERNAME_IDX,
    KeyConditionExpression: 'username = :u',
    ExpressionAttributeValues: { ':u': email },
    ScanIndexForward: false,  // newest first
    Limit: 20,
  }));

  const jobs = (result.Items ?? []) as Array<{
    jobId: string; status: string; startTime: string; endTime?: string;
    standardName?: string; error?: string;
  }>;

  return ok({ jobs });
}

// ── POST /ato/generate ─────────────────────────────────────────────────────────

async function handleGenerate(event: APIGatewayProxyEvent, email: string): Promise<APIGatewayProxyResult> {
  let standardsArn = '';
  let standardName = 'NIST 800-53 Rev 5';

  try {
    const body = JSON.parse(event.body ?? '{}') as { standardsArn?: string; standardName?: string };
    standardsArn = body.standardsArn ?? '';
    standardName = body.standardName ?? standardName;
  } catch {
    // body is optional — proceed with defaults
  }

  const jobId       = `job_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const now         = new Date();
  const ttl         = Math.floor(now.getTime() / 1000) + TTL_DAYS * 86_400;
  const resultS3Key = `ato-reports/${email}/${jobId}.json`;

  await ddb.send(new PutCommand({
    TableName: JOBS_TABLE,
    Item: {
      jobId,
      username:     email,
      status:       'PENDING',
      startTime:    now.toISOString(),
      endTime:      null,
      ttl,
      error:        null,
      resultS3Key,
      standardsArn,
      standardName,
    },
    ConditionExpression: 'attribute_not_exists(jobId)',
  }));

  console.log('ATO job created', { jobId, username: email, standardsArn, standardName });
  return ok({ jobId });
}

// ── GET /ato/status/{jobId} ────────────────────────────────────────────────────

async function handleStatus(jobId: string): Promise<APIGatewayProxyResult> {
  if (!jobId) return err(400, 'jobId path parameter is required');

  const result = await ddb.send(new GetCommand({ TableName: JOBS_TABLE, Key: { jobId } }));
  if (!result.Item) return err(404, 'Job not found');

  const job = result.Item as {
    jobId: string; username: string; status: string;
    startTime: string; endTime: string | null;
    error: string | null; resultS3Key: string;
    standardsArn?: string; standardName?: string;
  };

  if (job.status === 'IN_PROGRESS') {
    const elapsed = Date.now() - new Date(job.startTime).getTime();
    if (elapsed > STUCK_TIMEOUT_MS) {
      console.warn('ATO job stuck, surfacing as FAILED', { jobId, elapsedMs: elapsed });
      return ok({ ...job, status: 'FAILED', error: 'Report generation timed out after 10 minutes' });
    }
  }

  if (job.status === 'COMPLETED' && job.resultS3Key) {
    const presignedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: REPORTS_BUCKET, Key: job.resultS3Key }),
      { expiresIn: PRESIGNED_TTL_S },
    );
    return ok({ ...job, presignedUrl });
  }

  return ok(job);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function withCors(response: APIGatewayProxyResult): APIGatewayProxyResult {
  return { ...response, headers: { ...response.headers, ...CORS_HEADERS } };
}

function ok(body: unknown): APIGatewayProxyResult {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function err(status: number, message: string): APIGatewayProxyResult {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: message }) };
}
