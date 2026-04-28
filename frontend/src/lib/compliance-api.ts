import { getStoredToken } from './auth';

const API_URL = import.meta.env.VITE_API_URL as string;

export interface SystemMetadata {
  pk: string;
  sk: string;
  systemName: string;
  ownerName: string;
  ownerEmail: string;
  awsAccountId: string;
  region: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface DocumentRecord {
  pk: string;
  sk: string;
  docType?: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | null;
  generationId?: string;
  generatedBy?: string;
  generationStartedAt?: string;
  updatedAt?: string;
  updatedBy?: string;
  presignedUrl?: string;
  error?: string;
  confidentiality?: string;
  integrity?: string;
  availability?: string;
  overallImpact?: string;
}

function authHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getStoredToken()}`,
  };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { ...init, headers: { ...authHeaders(), ...init?.headers } });
  const json = await res.json() as T;
  if (!res.ok) throw Object.assign(new Error((json as { error?: string }).error ?? 'Request failed'), { status: res.status });
  return json;
}

export async function getSystem(systemId: string): Promise<SystemMetadata> {
  return apiFetch<SystemMetadata>(`/systems/${systemId}`);
}

export async function updateSettings(systemId: string, fields: Partial<Omit<SystemMetadata, 'pk' | 'sk'>>): Promise<void> {
  await apiFetch(`/systems/${systemId}/settings`, { method: 'PUT', body: JSON.stringify(fields) });
}

export async function listDocuments(systemId: string): Promise<DocumentRecord[]> {
  const res = await apiFetch<{ documents: DocumentRecord[] }>(`/systems/${systemId}/documents`);
  return res.documents;
}

export async function saveFips199(
  systemId: string,
  values: { confidentiality: string; integrity: string; availability: string },
): Promise<{ overallImpact: string }> {
  return apiFetch<{ overallImpact: string }>(`/systems/${systemId}/documents/FIPS199`, {
    method: 'PUT',
    body: JSON.stringify(values),
  });
}

export async function generateDocument(systemId: string, docType: string): Promise<{ status: string; generationId: string }> {
  return apiFetch<{ status: string; generationId: string }>(
    `/systems/${systemId}/documents/${docType}/generate`,
    { method: 'POST' },
  );
}

export async function getDocument(systemId: string, docType: string): Promise<DocumentRecord> {
  return apiFetch<DocumentRecord>(`/systems/${systemId}/documents/${docType}`);
}

// Polls until COMPLETED or FAILED, with exponential backoff (2→3→5→10→30s, 15-min ceiling)
const POLL_STEPS_MS = [2000, 3000, 5000, 10000, 30000];
const POLL_CEILING_MS = 15 * 60 * 1000;

export async function pollDocument(
  systemId: string,
  docType: string,
  generationId: string,
  onUpdate: (doc: DocumentRecord) => void,
  signal?: AbortSignal,
): Promise<DocumentRecord> {
  const startedAt = Date.now();
  let step = 0;

  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (Date.now() - startedAt > POLL_CEILING_MS) throw new Error('Polling timed out');

    const delayMs = POLL_STEPS_MS[Math.min(step, POLL_STEPS_MS.length - 1)];
    step++;

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, delayMs);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); });
    });

    const doc = await getDocument(systemId, docType);

    // Stale poll — a newer generation was triggered
    if (doc.generationId && doc.generationId !== generationId) {
      throw new Error('A newer generation was started');
    }

    onUpdate(doc);
    if (doc.status === 'COMPLETED' || doc.status === 'FAILED') return doc;
  }
}
