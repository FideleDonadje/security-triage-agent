import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { AuthContext } from './auth';

interface ChatRequest {
  message: string;
  session_id?: string;
}

// Internal event shape when Lambda invokes itself asynchronously
export interface ChatWorkerEvent {
  __chatWorker: true;
  requestId: string;
  message: string;
  sessionId: string;
  runtimeArn: string;
}

const REGION = process.env.REGION ?? process.env.AWS_REGION ?? 'us-east-1';
const TABLE = process.env.TABLE_NAME!;
const FUNCTION_NAME = process.env.FUNCTION_NAME!;
// AgentCore Runtime endpoint to invoke (named endpoint created by AgentStack)
const RUNTIME_QUALIFIER = process.env.AGENT_RUNTIME_QUALIFIER ?? 'prod';

const agentCore = new BedrockAgentCoreClient({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });
const ssmClient = new SSMClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } },
);

// ── Runtime ARN — resolved from SSM once per cold start, then cached ─────────

let cachedRuntimeArn: string | undefined;

async function resolveRuntimeArn(): Promise<string> {
  if (cachedRuntimeArn) return cachedRuntimeArn;

  const param = process.env.AGENT_RUNTIME_ARN_PARAM;
  if (param) {
    const result = await ssmClient.send(new GetParameterCommand({ Name: param }));
    cachedRuntimeArn = result.Parameter?.Value;
  } else {
    cachedRuntimeArn = process.env.AGENT_RUNTIME_ARN;
  }

  if (!cachedRuntimeArn) {
    throw new Error('Agent not yet configured — deploy AgentStack first');
  }
  return cachedRuntimeArn;
}

// ── POST /chat — returns 202 immediately, worker runs async ──────────────────

export async function handleChat(
  event: APIGatewayProxyEvent,
  auth: AuthContext,
): Promise<APIGatewayProxyResult> {
  let body: ChatRequest;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return err(400, 'Request body must be valid JSON');
  }

  const { message, session_id } = body;

  if (!message?.trim()) {
    return err(400, '"message" is required');
  }

  let runtimeArn: string;
  try {
    runtimeArn = await resolveRuntimeArn();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(503, msg);
  }

  const sessionId  = toRuntimeSessionId(session_id ?? auth.sub);
  const requestId  = randomUUID();
  const now        = new Date().toISOString();

  // Store PENDING record — TTL 2 hours so it auto-deletes from the tasks table
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      task_id:    `chat-${requestId}`,
      status:     'CHAT_PENDING',
      session_id: sessionId,
      created_at: now,
      ttl:        Math.floor(Date.now() / 1000) + 7200,
    },
  }));

  // Invoke self asynchronously — bypasses the 29-second API Gateway limit
  const workerEvent: ChatWorkerEvent = {
    __chatWorker: true,
    requestId,
    message,
    sessionId,
    runtimeArn,
  };
  await lambdaClient.send(new InvokeCommand({
    FunctionName: FUNCTION_NAME,
    InvocationType: 'Event',                         // async — Lambda returns 202 immediately
    Payload: Buffer.from(JSON.stringify(workerEvent)),
  }));

  return {
    statusCode: 202,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: requestId, status: 'pending', session_id: sessionId }),
  };
}

// ── Worker — executes inside the async Lambda invocation ─────────────────────

export async function handleChatWorker(workerEvent: ChatWorkerEvent): Promise<void> {
  const { requestId, message, sessionId, runtimeArn } = workerEvent;

  let reply: string;
  let status: 'CHAT_DONE' | 'CHAT_FAILED';

  try {
    const agentResponse = await agentCore.send(new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      runtimeSessionId: sessionId,
      qualifier: RUNTIME_QUALIFIER,
      contentType: 'text/plain',
      accept: 'application/json',
      payload: Buffer.from(message, 'utf-8'),
    }));

    // response is a streaming blob — the agent container returns { "reply": "..." }
    const raw = agentResponse.response
      ? await agentResponse.response.transformToString('utf-8')
      : '';
    reply = extractReply(raw);
    if (!reply) reply = 'The agent returned an empty response. Please try again.';
    status = 'CHAT_DONE';
  } catch (e: unknown) {
    console.error('AgentCore InvokeAgentRuntime error in worker:', e);
    const msg = e instanceof Error && e.message.length < 200
      ? e.message.replace(/\(Service:.*?\)/, '').trim()
      : 'Agent service temporarily unavailable. Please try again.';
    reply  = `Agent error: ${msg}`;
    status = 'CHAT_FAILED';
  }

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { task_id: `chat-${requestId}` },
    UpdateExpression: 'SET #s = :s, reply = :r, completed_at = :t',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':s': status,
      ':r': reply,
      ':t': new Date().toISOString(),
    },
  }));
}

// ── GET /chat/result/{request_id} ─────────────────────────────────────────────

export async function handleChatResult(
  requestId: string,
): Promise<APIGatewayProxyResult> {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { task_id: `chat-${requestId}` },
  }));

  const item = result.Item;
  if (!item) {
    return err(404, 'Request not found');
  }

  if (item.status === 'CHAT_PENDING') {
    return {
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pending', request_id: requestId }),
    };
  }

  if (item.status === 'CHAT_FAILED') {
    return err(500, (item.reply as string | undefined) ?? 'Agent error');
  }

  // CHAT_DONE
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reply:      item.reply as string,
      session_id: item.session_id as string,
    }),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function err(status: number, message: string): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: message }),
  };
}

/**
 * AgentCore Runtime requires runtimeSessionId to be 33-256 chars. A Cognito sub
 * (36-char UUID) passes through unchanged; a shorter client-supplied session_id
 * is padded deterministically so the same input maps to the same session.
 */
function toRuntimeSessionId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 200);
  const base = cleaned.length >= 2 ? cleaned : `sess-${Date.now()}`;
  return base.length >= 33 ? base : base.padEnd(33, '0');
}

/** The agent container replies with { "reply": "..." }; tolerate a bare string too. */
function extractReply(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as { reply?: string; error?: string };
    return parsed.reply ?? parsed.error ?? trimmed;
  } catch {
    return trimmed;
  }
}
