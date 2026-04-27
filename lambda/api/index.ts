import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { validateToken } from './auth';
import { handleChat, handleChatResult, handleChatWorker, type ChatWorkerEvent } from './chat';
import { handleApproveTask, handleDismissTask, handleGetTasks, handleRejectTask } from './tasks';
import {
  handleGetSystem,
  handleUpdateSettings,
  handleListDocuments,
  handleSaveFips199,
  handleGenerateDocument,
  handleGetDocument,
} from './compliance';

// Set ALLOWED_ORIGIN env var on this Lambda to your CloudFront URL.
// Falls back to '*' only when the variable is absent (local dev / CI).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN ?? '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

export const handler = async (
  event: APIGatewayProxyEvent | ChatWorkerEvent,
): Promise<APIGatewayProxyResult | void> => {
  // Async worker invocation — not from API GW, no HTTP context, no JWT needed
  if ('__chatWorker' in event) {
    await handleChatWorker(event);
    return;
  }

  // Handle CORS preflight without auth
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    // Defense-in-depth: validate JWT even though API GW Cognito authorizer already checked it.
    // This also extracts the email claim we need for the approve/reject audit trail.
    const auth = await validateToken(event);

    const { httpMethod, resource } = event;
    let response: APIGatewayProxyResult;

    if (httpMethod === 'POST' && resource === '/chat') {
      response = await handleChat(event, auth);
    } else if (httpMethod === 'GET' && resource === '/chat/result/{request_id}') {
      const requestId = event.pathParameters?.request_id ?? '';
      response = await handleChatResult(requestId);
    } else if (httpMethod === 'GET' && resource === '/tasks') {
      response = await handleGetTasks(event, auth);
    } else if (httpMethod === 'POST' && resource === '/tasks/{task_id}/approve') {
      response = await handleApproveTask(event, auth);
    } else if (httpMethod === 'POST' && resource === '/tasks/{task_id}/reject') {
      response = await handleRejectTask(event, auth);
    } else if (httpMethod === 'DELETE' && resource === '/tasks/{task_id}') {
      response = await handleDismissTask(event, auth);
    } else if (httpMethod === 'GET' && resource === '/systems/{systemId}') {
      response = await handleGetSystem(event, auth);
    } else if (httpMethod === 'PUT' && resource === '/systems/{systemId}/settings') {
      response = await handleUpdateSettings(event, auth);
    } else if (httpMethod === 'GET' && resource === '/systems/{systemId}/documents') {
      response = await handleListDocuments(event, auth);
    } else if (httpMethod === 'PUT' && resource === '/systems/{systemId}/documents/FIPS199') {
      response = await handleSaveFips199(event, auth);
    } else if (httpMethod === 'POST' && resource === '/systems/{systemId}/documents/{docType}/generate') {
      response = await handleGenerateDocument(event, auth);
    } else if (httpMethod === 'GET' && resource === '/systems/{systemId}/documents/{docType}') {
      response = await handleGetDocument(event, auth);
    } else {
      response = {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `${httpMethod} ${resource} not found` }),
      };
    }

    return withCors(response);
  } catch (e: unknown) {
    // JWT errors → 401 (don't leak internal details)
    if (isJwtError(e)) {
      console.warn('JWT validation failed:', (e as Error).message);
      return withCors({
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unauthorized' }),
      });
    }

    // Everything else → 500
    console.error('Unhandled error:', e);
    return withCors({
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' }),
    });
  }
};

function withCors(response: APIGatewayProxyResult): APIGatewayProxyResult {
  return {
    ...response,
    headers: { ...response.headers, ...CORS_HEADERS },
  };
}

function isJwtError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  // aws-jwt-verify throws errors with names like JwtExpiredError, JwtInvalidClaimError, etc.
  return e.name.startsWith('Jwt') || e.name === 'JwtMissingError';
}
