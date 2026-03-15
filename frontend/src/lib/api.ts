import { API_URL } from './config';
import { getStoredToken, redirectToLogin } from './auth';

// ── Types ──────────────────────────────────────────────────────────────────────

export type TaskStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'FAILED';
export type TaskAction = 'enable_s3_logging' | 'tag_resource';

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
  // POST returns 202 immediately with a request_id
  const startRes = await authFetch('/chat', {
    method: 'POST',
    body: JSON.stringify({ message, session_id: sessionId }),
  });
  const start = await startRes.json() as { request_id: string; session_id: string };

  // Poll until the async worker finishes (max 3 minutes)
  const maxPolls = 90;
  for (let i = 0; i < maxPolls; i++) {
    await delay(2000);
    const pollRes = await authFetch(`/chat/result/${encodeURIComponent(start.request_id)}`);
    const data = await pollRes.json() as { status?: string; reply?: string; session_id?: string };
    if (data.status !== 'pending') {
      return { reply: data.reply!, session_id: data.session_id ?? start.session_id };
    }
  }
  throw new Error('Agent took too long to respond. Please try again.');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function dismissTask(taskId: string): Promise<void> {
  await authFetch(`/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
}
