import { useState, useEffect } from 'react';
import type { DocumentRecord } from '../lib/compliance-api';
import { generateDocument, getDocument, pollDocument } from '../lib/compliance-api';

interface Props {
  systemId: string;
  docType: string;
  label: string;
  description: string;
  doc: DocumentRecord | null;
  onUpdate: (doc: DocumentRecord) => void;
  lockedReason?: string; // set when prerequisites are incomplete
  order: number;        // 1-based display order
}

const STATUS_COLOR: Record<string, string> = {
  COMPLETED:   'var(--green)',
  IN_PROGRESS: 'var(--yellow)',
  PENDING:     'var(--yellow)',
  FAILED:      'var(--red)',
};

const STATUS_LABEL: Record<string, string> = {
  COMPLETED:   'Ready',
  IN_PROGRESS: 'Generating…',
  PENDING:     'Queued…',
  FAILED:      'Failed',
};

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export default function DocumentCard({ systemId, docType, label, description, doc, onUpdate, lockedReason, order }: Props) {
  const [generating, setGenerating] = useState(false);
  const [fetchingUrl, setFetchingUrl] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  const status = doc?.status ?? null;
  const isActive = status === 'IN_PROGRESS' || status === 'PENDING';

  useEffect(() => {
    if (!isActive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isActive]);

  const busy = generating || isActive;
  const locked = !!lockedReason;

  async function handleGenerate() {
    if (status === 'COMPLETED' && !window.confirm(`Regenerate ${label}?\n\nThis will overwrite the current version. The process takes several minutes.`)) return;
    setGenerating(true);
    setError('');
    try {
      const res = await generateDocument(systemId, docType);
      onUpdate({ ...(doc ?? { pk: `SYSTEM#${systemId}`, sk: `DOC#NIST#${docType}` }), status: 'PENDING', generationId: res.generationId });
      await pollDocument(systemId, docType, res.generationId, onUpdate);
    } catch (e: unknown) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message ?? 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }

  async function handleView() {
    setFetchingUrl(true);
    setError('');
    try {
      const fresh = await getDocument(systemId, docType);
      onUpdate(fresh);
      if (fresh.presignedUrl) {
        window.open(fresh.presignedUrl, '_blank', 'noopener');
      }
    } catch (e: unknown) {
      setError((e as Error).message ?? 'Could not fetch download link');
    } finally {
      setFetchingUrl(false);
    }
  }

  return (
    <div style={{ ...styles.card, ...(locked ? styles.cardLocked : {}) }}>
      <div style={styles.top}>
        <div style={styles.meta}>
          <div style={styles.labelRow}>
            <span style={styles.orderBadge}>{order}</span>
            <span style={styles.label}>{label}</span>
          </div>
          <span style={styles.desc}>{description}</span>
        </div>

        {status && !locked && (
          <span style={{ ...styles.badge, color: STATUS_COLOR[status] ?? 'var(--muted)' }}>
            {STATUS_LABEL[status] ?? status}
          </span>
        )}
        {locked && <span style={styles.lockIcon} title={lockedReason}>🔒</span>}
      </div>

      {doc?.status === 'COMPLETED' && doc.updatedAt && !locked && (
        <div style={styles.meta2}>
          Last generated {new Date(doc.updatedAt).toLocaleDateString()} by {doc.generatedBy ?? '—'}
          {doc.generationStartedAt && (() => {
            const ms = new Date(doc.updatedAt!).getTime() - new Date(doc.generationStartedAt!).getTime();
            return ms > 0 ? <span style={styles.genTime}> · Generated in {formatDuration(ms)}</span> : null;
          })()}
        </div>
      )}

      {isActive && doc?.generationStartedAt && !locked && (
        <div style={styles.progressWrap}>
          <div style={styles.progressBar} />
          <span style={styles.elapsedText}>
            {formatDuration(now - new Date(doc.generationStartedAt).getTime())} elapsed
          </span>
        </div>
      )}

      {(doc?.error || error) && !locked && (
        <div style={styles.errorMsg}>{doc?.error ?? error}</div>
      )}

      {locked && (
        <div style={styles.lockedMsg}>{lockedReason}</div>
      )}

      {!locked && (
        <div style={styles.actions}>
          {doc?.status === 'COMPLETED' && (
            <button
              style={{ ...styles.viewBtn, opacity: fetchingUrl ? 0.5 : 1 }}
              onClick={() => { void handleView(); }}
              disabled={fetchingUrl}
            >
              {fetchingUrl ? 'Loading…' : 'View / Download'}
            </button>
          )}
          <button
            style={{ ...styles.genBtn, opacity: (busy || locked) ? 0.5 : 1 }}
            onClick={() => { void handleGenerate(); }}
            disabled={busy || locked}
          >
            {busy ? 'Generating…' : status === 'COMPLETED' ? 'Regenerate' : 'Generate'}
          </button>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  cardLocked: {
    opacity: 0.6,
  },
  top: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  meta: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    flex: 1,
  },
  labelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  orderBadge: {
    width: 20,
    height: 20,
    borderRadius: '50%',
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--muted)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  label: {
    fontWeight: 600,
    fontSize: 13,
    color: 'var(--text)',
  },
  desc: {
    fontSize: 12,
    color: 'var(--muted)',
    paddingLeft: 28,
  },
  badge: {
    fontSize: 11,
    fontWeight: 600,
    flexShrink: 0,
  },
  lockIcon: {
    fontSize: 13,
    flexShrink: 0,
  },
  meta2: {
    fontSize: 11,
    color: 'var(--muted)',
  },
  genTime: {
    color: 'var(--muted)',
  },
  progressWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  progressBar: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    background: 'linear-gradient(90deg, var(--purple) 0%, transparent 100%)',
    backgroundSize: '200% 100%',
    animation: 'progress-slide 1.5s linear infinite',
  },
  elapsedText: {
    fontSize: 11,
    color: 'var(--muted)',
    flexShrink: 0,
  },
  errorMsg: {
    fontSize: 11,
    color: 'var(--red)',
  },
  lockedMsg: {
    fontSize: 11,
    color: 'var(--muted)',
    fontStyle: 'italic',
  },
  actions: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  viewBtn: {
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    fontSize: 12,
    fontWeight: 500,
    padding: '4px 12px',
    borderRadius: 6,
    cursor: 'pointer',
  },
  genBtn: {
    background: 'rgba(139, 87, 229, 0.15)',
    border: '1px solid rgba(139, 87, 229, 0.4)',
    color: 'var(--purple)',
    fontSize: 12,
    fontWeight: 500,
    padding: '4px 12px',
    borderRadius: 6,
    cursor: 'pointer',
  },
};
