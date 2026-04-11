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

// ── ATO Assist ─────────────────────────────────────────────────────────────────

export interface SecurityStandard {
  standardsSubscriptionArn: string;
  standardsArn: string;
  name: string;
  description: string;
  status: string;
  atoSuitable: boolean;
  notSuitableReason?: string;
}

/** GET /ato/standards — list enabled Security Hub standards with ATO suitability flags */
export async function getEnabledStandards(): Promise<{ standards: SecurityStandard[]; message?: string }> {
  const res = await authFetch('/ato/standards');
  return res.json() as Promise<{ standards: SecurityStandard[]; message?: string }>;
}

export type AtoJobStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export interface AtoJob {
  jobId: string;
  username: string;
  status: AtoJobStatus;
  startTime: string;
  endTime: string | null;
  error: string | null;
  resultS3Key: string;
  presignedUrl?: string;
}

export interface PoamEntry {
  poamId: string;
  affectedControl: string;
  description: string;
  dateIdentified: string;
  scheduledCompletionDate: string;
  status: string;
  riskRating: string;
  remediationPlan: string;
}

export interface ControlFamily {
  family: string;
  familyName: string;
  findingCount: number;
  passCount: number;
  failCount: number;
  riskAssessment: string;
  implementationStatement: string;
  poamEntries: PoamEntry[];
}

export interface AtoReport {
  controlFamilies: ControlFamily[];
  summary: {
    totalFindings: number;
    totalFailed: number;
    familiesEvaluated: number;
  };
  generatedAt: string;
}

/** POST /ato/generate — kick off a new ATO report job, returns the jobId */
export async function generateAtoReport(
  standardsArn: string,
  standardName: string,
): Promise<{ jobId: string }> {
  const res = await authFetch('/ato/generate', {
    method: 'POST',
    body: JSON.stringify({ standardsArn, standardName }),
  });
  return res.json() as Promise<{ jobId: string }>;
}

export interface AtoJobSummary {
  jobId: string;
  status: AtoJobStatus;
  startTime: string;
  endTime?: string;
  standardName?: string;
  error?: string;
}

/** GET /ato/jobs — list the current analyst's past report jobs, newest first */
export async function getJobHistory(): Promise<AtoJobSummary[]> {
  const res = await authFetch('/ato/jobs');
  const data = await res.json() as { jobs: AtoJobSummary[] };
  return data.jobs;
}

/** GET /ato/status/{jobId} — poll job status; includes presignedUrl when COMPLETED */
export async function getAtoStatus(jobId: string): Promise<AtoJob> {
  const res = await authFetch(`/ato/status/${encodeURIComponent(jobId)}`);
  return res.json() as Promise<AtoJob>;
}

/**
 * Fetch the JSON report from the presigned S3 URL.
 * No auth header — the URL is already signed by the trigger Lambda.
 */
export async function fetchAtoReport(presignedUrl: string): Promise<AtoReport> {
  const res = await fetch(presignedUrl);
  if (!res.ok) throw new Error(`Failed to fetch report: ${res.statusText}`);
  return res.json() as Promise<AtoReport>;
}
