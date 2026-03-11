import { CLIENT_ID, COGNITO_DOMAIN } from './config';

const TOKEN_KEY = 'id_token';
const VERIFIER_KEY = 'pkce_verifier';

// ── PKCE helpers ───────────────────────────────────────────────────────────────

function base64urlEncode(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generateVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes.buffer);
}

async function deriveChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64urlEncode(digest);
}

// ── Token storage ──────────────────────────────────────────────────────────────

function decodePayload(token: string): Record<string, unknown> {
  try {
    return JSON.parse(atob(token.split('.')[1])) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Returns the stored id_token if still valid (>60 s remaining), else null. */
export function getStoredToken(): string | null {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  const { exp } = decodePayload(token) as { exp?: number };
  if (!exp || Date.now() / 1000 > exp - 60) {
    sessionStorage.removeItem(TOKEN_KEY);
    return null;
  }
  return token;
}

/** Extract email from the stored token's payload. */
export function getEmail(): string | null {
  const token = getStoredToken();
  if (!token) return null;
  const { email } = decodePayload(token) as { email?: string };
  return email ?? null;
}

// ── Authorization code + PKCE flow ────────────────────────────────────────────

/**
 * Call on every page load. If Cognito redirected back with ?code=...,
 * exchange it for tokens, persist the id_token, clean the URL, and return true.
 * Returns false when no code is present (normal page load).
 */
export async function handleCallback(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return false;

  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);

  // Clean the code from the URL immediately (don't leave it in history)
  window.history.replaceState(null, '', window.location.pathname);

  if (!verifier) return false;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: `${window.location.origin}/`,
    code_verifier: verifier,
  });

  try {
    const res = await fetch(`https://${COGNITO_DOMAIN}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { id_token?: string };
    if (data.id_token) {
      sessionStorage.setItem(TOKEN_KEY, data.id_token);
      return true;
    }
  } catch {
    // fall through — caller will redirect to login
  }
  return false;
}

/** Generate a PKCE verifier, store it, and redirect to the Cognito login page. */
export async function redirectToLogin(): Promise<void> {
  const verifier = generateVerifier();
  const challenge = await deriveChallenge(verifier);
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  const redirectUri = encodeURIComponent(`${window.location.origin}/`);
  window.location.href =
    `https://${COGNITO_DOMAIN}/oauth2/authorize` +
    `?response_type=code` +
    `&client_id=${CLIENT_ID}` +
    `&redirect_uri=${redirectUri}` +
    `&code_challenge=${challenge}` +
    `&code_challenge_method=S256` +
    `&scope=openid+email`;
}

/** Clear session and redirect to Cognito logout. */
export function signOut(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  const logoutUri = encodeURIComponent(`${window.location.origin}/`);
  window.location.href =
    `https://${COGNITO_DOMAIN}/logout` +
    `?client_id=${CLIENT_ID}` +
    `&logout_uri=${logoutUri}`;
}
