import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { APIGatewayProxyEvent } from 'aws-lambda';

export interface AuthContext {
  sub: string;
  email: string;
}

// Verifier is created once and reused across warm Lambda invocations.
// Validates ID tokens so that the `email` claim is available.
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: 'id',
  clientId: process.env.USER_POOL_CLIENT_ID!,
});

/**
 * Extract and validate the Cognito ID token from the Authorization header.
 * Throws if the token is missing, malformed, expired, or from the wrong user pool.
 *
 * API Gateway already validated the token via the Cognito authorizer,
 * but we re-verify here (defense-in-depth) and extract claims we need.
 */
export async function validateToken(event: APIGatewayProxyEvent): Promise<AuthContext> {
  const authHeader = event.headers?.Authorization ?? event.headers?.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    const err = new Error('Missing or invalid Authorization header');
    err.name = 'JwtMissingError';
    throw err;
  }

  const token = authHeader.slice(7);
  const payload = await verifier.verify(token);

  return {
    sub: payload.sub,
    // email is guaranteed in ID tokens when email scope is requested
    email: typeof payload.email === 'string' ? payload.email : payload.sub,
  };
}
