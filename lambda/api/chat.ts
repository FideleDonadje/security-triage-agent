import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
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
  agentId: string;
  agentAliasId: string;
}

const REGION = process.env.REGION ?? process.env.AWS_REGION ?? 'us-east-1';
const TABLE = process.env.TABLE_NAME!;
const FUNCTION_NAME = process.env.FUNCTION_NAME!;

const bedrockClient = new BedrockAgentRuntimeClient({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });
const ssmClient = new SSMClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } },
);

// ── Agent config — resolved from SSM once per cold start, then cached ─────────

let cachedAgentId: string | undefined;
let cachedAgentAliasId: string | undefined;

async function resolveAgentConfig(): Promise<{ agentId: string; agentAliasId: string }> {
  if (cachedAgentId && cachedAgentAliasId) {
    return { agentId: cachedAgentId, agentAliasId: cachedAgentAliasId };
  }

  const idParam    = process.env.AGENT_ID_PARAM;
  const aliasParam = process.env.AGENT_ALIAS_ID_PARAM;

  if (idParam && aliasParam) {
    const [idResult, aliasResult] = await Promise.all([
      ssmClient.send(new GetParameterCommand({ Name: idParam })),
      ssmClient.send(new GetParameterCommand({ Name: aliasParam })),
    ]);
    cachedAgentId      = idResult.Parameter?.Value;
    cachedAgentAliasId = aliasResult.Parameter?.Value;
  } else {
    cachedAgentId      = process.env.AGENT_ID;
    cachedAgentAliasId = process.env.AGENT_ALIAS_ID;
  }

  if (!cachedAgentId || !cachedAgentAliasId) {
    throw new Error('Agent not yet configured — deploy AgentStack first');
  }

  return { agentId: cachedAgentId, agentAliasId: cachedAgentAliasId };
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

  let agentId: string;
  let agentAliasId: string;
  try {
    ({ agentId, agentAliasId } = await resolveAgentConfig());
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(503, msg);
  }

  const sessionId  = sanitizeSessionId(session_id ?? auth.sub);
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
    agentId,
    agentAliasId,
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
  const { requestId, message, sessionId, agentId, agentAliasId } = workerEvent;

  let reply: string;
  let status: 'CHAT_DONE' | 'CHAT_FAILED';

  try {
    const agentResponse = await bedrockClient.send(new InvokeAgentCommand({
      agentId,
      agentAliasId,
      sessionId,
      inputText: message,
    }));

    reply = '';
    if (agentResponse.completion) {
      for await (const chunk of agentResponse.completion) {
        if (chunk.chunk?.bytes) {
          reply += Buffer.from(chunk.chunk.bytes).toString('utf-8');
        }
      }
    }
    if (!reply) reply = 'The agent returned an empty response. Please try again.';
    status = 'CHAT_DONE';
  } catch (e: unknown) {
    console.error('Bedrock InvokeAgent error in worker:', e);
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

function sanitizeSessionId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 100);
  return cleaned.length >= 2 ? cleaned : `sess-${Date.now()}`;
}
