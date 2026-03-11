import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { AuthContext } from './auth';

interface ChatRequest {
  message: string;
  session_id?: string;
}

const bedrockClient = new BedrockAgentRuntimeClient({
  region: process.env.REGION ?? process.env.AWS_REGION ?? 'us-east-1',
});

/**
 * POST /chat
 *
 * Proxies analyst messages to Bedrock AgentCore and returns the complete response.
 * The analyst's Cognito sub is used as the session ID so conversation memory
 * persists across browser refreshes within the same session TTL.
 */
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

  const agentId = process.env.AGENT_ID;
  const agentAliasId = process.env.AGENT_ALIAS_ID;

  if (!agentId || !agentAliasId) {
    return err(503, 'Agent not yet configured - deploy AgentStack and set AGENT_ID / AGENT_ALIAS_ID');
  }

  // Use session_id from client if provided; fall back to analyst's Cognito sub.
  // Bedrock session IDs must be alphanumeric + hyphens, 2-100 chars.
  const sessionId = sanitizeSessionId(session_id ?? auth.sub);

  const cmd = new InvokeAgentCommand({
    agentId,
    agentAliasId,
    sessionId,
    inputText: message,
  });

  let reply: string;
  try {
    const agentResponse = await bedrockClient.send(cmd);

    // Collect streamed text chunks from the completion stream.
    // Use 'chunk' not 'event' to avoid shadowing the outer Lambda event parameter.
    reply = '';
    if (agentResponse.completion) {
      for await (const chunk of agentResponse.completion) {
        if (chunk.chunk?.bytes) {
          reply += Buffer.from(chunk.chunk.bytes).toString('utf-8');
        }
      }
    }

    if (!reply) {
      reply = 'The agent returned an empty response. Please try again.';
    }
  } catch (e: unknown) {
    // Log full error internally; return sanitized message to client.
    console.error('Bedrock InvokeAgent error:', e);
    const clientMsg = e instanceof Error && e.message.length < 200
      ? e.message.replace(/\(Service:.*?\)/, '').trim()  // strip internal AWS service detail
      : 'Agent service temporarily unavailable. Please try again.';
    return err(500, `Agent error: ${clientMsg}`);
  }

  return ok({ reply, session_id: sessionId });
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

/**
 * Bedrock session IDs: 2-100 chars, alphanumeric and hyphens only.
 * Cognito subs are UUIDs (fine as-is). Custom session_ids from the browser
 * are sanitized just in case.
 */
function sanitizeSessionId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 100);
  return cleaned.length >= 2 ? cleaned : `sess-${Date.now()}`;
}
