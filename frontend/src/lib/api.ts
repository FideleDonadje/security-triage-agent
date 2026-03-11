import { API_URL } from './config';
import { getStoredToken, redirectToLogin } from './auth';

// ── Types ──────────────────────────────────────────────────────────────────────

export type TaskStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'FAILED';
export type TaskAction = 'enable_s3_logging' | 'enable_s3_encryption';

export interface Task {
  task_id: string;
  status: TaskStatus;
  finding_id: string;
  resource_id: string;
  action: TaskAction;
  rationale: string;
  risk_tier: number;
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
  executed_at: string | null;
  result: string | null;
}

// ── Core fetch with auth ───────────────────────────────────────────────────────

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getStoredToken();
  if (!token) {
    redirectToLogin();
    throw new Error('Not authenticated');
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...init?.headers,
    },
  });

  if (res.status === 401) {
    redirectToLogin();
    throw new Error('Session expired');
  }

  if (!res.ok) {
    let message: string;
    try {
      const body = (await res.json()) as { error?: string };
      message = body.error ?? res.statusText;
    } catch {
      message = res.statusText;
    }
    throw new Error(message);
  }

  return res;
}

// ── API methods ────────────────────────────────────────────────────────────────

export async function sendChat(
  message: string,
  sessionId?: string,
): Promise<{ reply: string; session_id: string }> {
  const res = await authFetch('/chat', {
    method: 'POST',
    body: JSON.stringify({ message, session_id: sessionId }),
  });
  return res.json() as Promise<{ reply: string; session_id: string }>;
}

export async function getTasks(
  status: TaskStatus,
): Promise<{ tasks: Task[]; count: number }> {
  const res = await authFetch(`/tasks?status=${encodeURIComponent(status)}`);
  return res.json() as Promise<{ tasks: Task[]; count: number }>;
}

export async function approveTask(taskId: string): Promise<void> {
  await authFetch(`/tasks/${encodeURIComponent(taskId)}/approve`, { method: 'POST' });
}

export async function rejectTask(taskId: string): Promise<void> {
  await authFetch(`/tasks/${encodeURIComponent(taskId)}/reject`, { method: 'POST' });
}
