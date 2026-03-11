import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { validateToken } from './auth';
import { handleChat } from './chat';
import { handleApproveTask, handleGetTasks, handleRejectTask } from './tasks';

// Set ALLOWED_ORIGIN env var on this Lambda to your CloudFront URL.
// Falls back to '*' only when the variable is absent (local dev / CI).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN ?? '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
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
    } else if (httpMethod === 'GET' && resource === '/tasks') {
      response = await handleGetTasks(event, auth);
    } else if (httpMethod === 'POST' && resource === '/tasks/{task_id}/approve') {
      response = await handleApproveTask(event, auth);
    } else if (httpMethod === 'POST' && resource === '/tasks/{task_id}/reject') {
      response = await handleRejectTask(event, auth);
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
