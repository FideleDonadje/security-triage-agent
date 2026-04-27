import { useEffect, useRef, useState } from 'react';
import type { DocumentRecord, SystemMetadata } from '../lib/compliance-api';
import { generateDocument, getDocument, getSystem, listDocuments, pollDocument } from '../lib/compliance-api';
import DocumentViewer from './DocumentViewer';
import Fips199Card from './Fips199Card';

// ── RMF step definitions ───────────────────────────────────────────────────────

interface ArtifactDef {
  type: string;
  label: string;
  desc: string;
  kind: 'sync' | 'async' | 'info';
}

interface StepDef {
  number: number;
  name: string;
  tagline: string;
  nistRef: string;
  artifacts: ArtifactDef[];
  isComplete: (docs: Record<string, DocumentRecord>, sys: SystemMetadata | null) => boolean;
  isUnlocked: (docs: Record<string, DocumentRecord>, sys: SystemMetadata | null) => boolean;
  lockedMessage: string;
}

const RMF_STEPS: StepDef[] = [
  {
    number: 1, name: 'Prepare', nistRef: 'NIST SP 800-37 Rev 2 — Task P-1 to P-18',
    tagline: 'Establish context, roles, and risk management strategy for the system',
    artifacts: [{ type: 'SYSTEM_META', label: 'System Profile', desc: 'Name, owner, account, region', kind: 'info' }],
    isComplete: (_d, sys) => !!(sys?.systemName && sys?.ownerName && sys?.ownerEmail),
    isUnlocked: () => true,
    lockedMessage: '',
  },
  {
    number: 2, name: 'Categorize', nistRef: 'NIST FIPS 199 + SP 800-60',
    tagline: 'Determine the adverse impact of loss of confidentiality, integrity, and availability',
    artifacts: [{ type: 'FIPS199', label: 'FIPS 199 Impact Level', desc: 'C / I / A ratings → overall impact baseline', kind: 'sync' }],
    isComplete: (docs) => !!docs['FIPS199']?.overallImpact,
    isUnlocked: () => true,
    lockedMessage: '',
  },
  {
    number: 3, name: 'Select', nistRef: 'NIST SP 800-53 Rev 5',
    tagline: 'Choose the NIST 800-53 control baseline appropriate for the impact level',
    artifacts: [{ type: 'BASELINE', label: 'Control Baseline', desc: 'Derived from FIPS 199 — no generation required', kind: 'info' }],
    isComplete: (docs) => !!docs['FIPS199']?.overallImpact,
    isUnlocked: (docs) => !!docs['FIPS199']?.overallImpact,
    lockedMessage: 'Complete Step 2 (save FIPS 199 impact level) to select controls',
  },
  {
    number: 4, name: 'Implement', nistRef: 'NIST SP 800-53 Rev 5 + SP 800-18',
    tagline: 'Document how security controls are implemented across the system',
    artifacts: [{ type: 'SSP', label: 'System Security Plan', desc: 'Control implementation narrative for all 800-53 families', kind: 'async' }],
    isComplete: (docs) => docs['SSP']?.status === 'COMPLETED',
    isUnlocked: (docs) => !!docs['FIPS199']?.overallImpact,
    lockedMessage: 'Complete Step 2 (FIPS 199) before generating the SSP',
  },
  {
    number: 5, name: 'Assess', nistRef: 'NIST SP 800-53A Rev 5',
    tagline: 'Determine if controls are implemented correctly and producing the desired outcome',
    artifacts: [
      { type: 'SAR', label: 'Security Assessment Report', desc: 'Control effectiveness and deficiency findings', kind: 'async' },
      { type: 'RA',  label: 'Risk Assessment',            desc: 'Threat likelihood × impact scoring per finding',  kind: 'async' },
    ],
    isComplete: (docs) => docs['SAR']?.status === 'COMPLETED' && docs['RA']?.status === 'COMPLETED',
    isUnlocked: (docs) => docs['SSP']?.status === 'COMPLETED',
    lockedMessage: 'Complete Step 4 (SSP) before assessing controls',
  },
  {
    number: 6, name: 'Authorize', nistRef: 'NIST SP 800-37 Rev 2 — Task R-1 to R-5',
    tagline: 'Senior official accepts residual risk and grants authorization to operate',
    artifacts: [{ type: 'POAM', label: 'Plan of Action & Milestones', desc: 'Open findings with owners, resources, and remediation timelines', kind: 'async' }],
    isComplete: (docs) => docs['POAM']?.status === 'COMPLETED',
    isUnlocked: (docs) => docs['SAR']?.status === 'COMPLETED' || docs['RA']?.status === 'COMPLETED',
    lockedMessage: 'Complete Step 5 (SAR or RA) before building the authorization package',
  },
  {
    number: 7, name: 'Monitor', nistRef: 'NIST SP 800-137A',
    tagline: 'Continuously track control effectiveness and system/environment changes',
    artifacts: [
      { type: 'CONMON', label: 'Continuous Monitoring Plan', desc: 'Ongoing control monitoring strategy and cadence', kind: 'async' },
      { type: 'IRP',    label: 'Incident Response Plan',    desc: 'Detection, containment, and recovery procedures', kind: 'async' },
    ],
    isComplete: (docs) => docs['CONMON']?.status === 'COMPLETED' && docs['IRP']?.status === 'COMPLETED',
    isUnlocked: (docs) => docs['POAM']?.status === 'COMPLETED',
    lockedMessage: 'Complete Step 6 (POA&M) before building monitoring artifacts',
  },
];

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

const IMPACT_COLOR: Record<string, string> = { Low: 'var(--green)', Moderate: 'var(--yellow)', High: 'var(--red)' };

const BASELINE_COUNTS: Record<string, number> = { Low: 207, Moderate: 345, High: 428 };

// ── Artifact row ───────────────────────────────────────────────────────────────

function ArtifactRow({
  systemId, def, doc, system, unlocked, onDocUpdate, onView, onComplete,
}: {
  systemId: string;
  def: ArtifactDef;
  doc: DocumentRecord | null;
  system: SystemMetadata | null;
  unlocked: boolean;
  onDocUpdate: (d: DocumentRecord) => void;
  onView: (type: string, label: string, url: string) => void;
  onComplete?: (label: string) => void;
}) {
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState('');
  const [now,   setNow]   = useState(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  if (def.kind === 'info' && def.type === 'SYSTEM_META') {
    const filled = !!(system?.systemName && system?.ownerName);
    return (
      <div style={styles.artifactRow}>
        <div style={styles.artifactMeta}>
          <span style={styles.artifactLabel}>{def.label}</span>
          <span style={styles.artifactDesc}>{def.desc}</span>
        </div>
        <span style={{ ...styles.artifactStatus, color: filled ? 'var(--green)' : 'var(--muted)' }}>
          {filled ? 'Filled' : 'Incomplete'}
        </span>
      </div>
    );
  }

  if (def.kind === 'info' && def.type === 'BASELINE') {
    const impact = doc?.overallImpact;
    return (
      <div style={styles.artifactRow}>
        <div style={styles.artifactMeta}>
          <span style={styles.artifactLabel}>{def.label}</span>
          <span style={styles.artifactDesc}>{def.desc}</span>
        </div>
        {impact ? (
          <span style={{ color: IMPACT_COLOR[impact] ?? 'var(--muted)', fontSize: 12, fontWeight: 700 }}>
            {impact} ({BASELINE_COUNTS[impact]} controls)
          </span>
        ) : <span style={styles.artifactStatus}>—</span>}
      </div>
    );
  }

  if (def.kind === 'sync') {
    // FIPS 199 is rendered inline in the step — this row is just a placeholder
    return null;
  }

  // Async document
  const status = doc?.status ?? null;
  const isActive = status === 'IN_PROGRESS' || status === 'PENDING';
  const generating = busy || isActive;

  useEffect(() => {
    if (!isActive) { timerRef.current && clearInterval(timerRef.current); return; }
    timerRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => { timerRef.current && clearInterval(timerRef.current); };
  }, [isActive]);

  async function handleGenerate() {
    if (status === 'COMPLETED' && !window.confirm(`Regenerate ${def.label}?\n\nThis will overwrite the current version. The process takes several minutes.`)) return;
    setBusy(true);
    setError('');
    try {
      const res = await generateDocument(systemId, def.type);
      onDocUpdate({ ...(doc ?? { pk: `SYSTEM#${systemId}`, sk: `DOC#NIST#${def.type}` }), status: 'PENDING', generationId: res.generationId });
      const final = await pollDocument(systemId, def.type, res.generationId, onDocUpdate);
      if (final.status === 'COMPLETED') onComplete?.(def.label);
    } catch (e: unknown) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message ?? 'Generation failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleView() {
    setBusy(true);
    try {
      const fresh = await getDocument(systemId, def.type);
      onDocUpdate(fresh);
      if (fresh.presignedUrl) onView(def.type, def.label, fresh.presignedUrl);
    } catch (e: unknown) {
      setError((e as Error).message ?? 'Failed to load');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.artifactRow}>
      <div style={styles.artifactMeta}>
        <span style={styles.artifactLabel}>{def.label}</span>
        <span style={styles.artifactDesc}>{def.desc}</span>
        {doc?.updatedAt && status === 'COMPLETED' && (
          <span style={styles.artifactAge}>
            Last generated {new Date(doc.updatedAt).toLocaleString()}
            {doc.generationStartedAt && (() => {
              const ms = new Date(doc.updatedAt!).getTime() - new Date(doc.generationStartedAt!).getTime();
              if (ms <= 0) return null;
              const s = Math.floor(ms / 1000);
              const m = Math.floor(s / 60);
              return ` · ${m > 0 ? `${m}m ${s % 60}s` : `${s}s`}`;
            })()}
          </span>
        )}
        {isActive && doc?.generationStartedAt && (
          <div style={styles.artifactProgress}>
            <div style={styles.artifactProgressBar} />
            <span style={styles.artifactElapsed}>
              {(() => {
                const s = Math.floor((now - new Date(doc.generationStartedAt).getTime()) / 1000);
                const m = Math.floor(s / 60);
                return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
              })()} elapsed
            </span>
          </div>
        )}
        {(doc?.error || error) && <span style={styles.artifactError}>{doc?.error ?? error}</span>}
      </div>

      <div style={styles.artifactActions}>
        {status && <span style={{ ...styles.artifactStatus, color: STATUS_COLOR[status] ?? 'var(--muted)' }}>{STATUS_LABEL[status] ?? status}</span>}

        {status === 'COMPLETED' && (
          <button style={{ ...styles.btn, ...styles.btnSecondary }} onClick={() => { void handleView(); }} disabled={busy}>
            {busy ? '…' : 'View'}
          </button>
        )}

        {unlocked && (
          <button style={{ ...styles.btn, ...styles.btnPrimary, opacity: generating ? 0.5 : 1 }}
            onClick={() => { void handleGenerate(); }} disabled={generating}>
            {generating ? 'Generating…' : status === 'COMPLETED' ? 'Regenerate' : 'Generate'}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Progress bar ───────────────────────────────────────────────────────────────

function RmfProgress({ steps, docs, system }: { steps: StepDef[]; docs: Record<string, DocumentRecord>; system: SystemMetadata | null }) {
  const completedCount = steps.filter((s) => s.isComplete(docs, system)).length;
  const pct = Math.round((completedCount / steps.length) * 100);

  return (
    <div style={styles.progressWrapper}>
      <div style={styles.progressHeader}>
        <span style={styles.progressTitle}>NIST RMF Progress</span>
        <span style={styles.progressCount}>{completedCount}/{steps.length} steps complete</span>
      </div>
      <div style={styles.progressBar}>
        <div style={{ ...styles.progressFill, width: `${pct}%` }} />
      </div>
      <div style={styles.stepDots}>
        {steps.map((s) => {
          const complete  = s.isComplete(docs, system);
          const unlocked  = s.isUnlocked(docs, system);
          return (
            <div key={s.number} style={styles.stepDot} title={`${s.number}. ${s.name}`}>
              <div style={{
                ...styles.dot,
                background: complete ? 'var(--green)' : unlocked ? 'var(--purple)' : 'var(--surface2)',
                border: `2px solid ${complete ? 'var(--green)' : unlocked ? 'var(--purple)' : 'var(--border)'}`,
              }}>
                {complete ? '✓' : s.number}
              </div>
              <span style={{ ...styles.dotLabel, color: complete ? 'var(--green)' : unlocked ? 'var(--text)' : 'var(--muted)' }}>
                {s.name}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Step card ──────────────────────────────────────────────────────────────────

function StepCard({
  step, docs, system, systemId, onDocUpdate, onView, onComplete,
}: {
  step: StepDef;
  docs: Record<string, DocumentRecord>;
  system: SystemMetadata | null;
  systemId: string;
  onDocUpdate: (type: string, d: DocumentRecord) => void;
  onView: (type: string, label: string, url: string) => void;
  onComplete: (label: string) => void;
}) {
  const complete = step.isComplete(docs, system);
  const unlocked = step.isUnlocked(docs, system);
  const [open, setOpen] = useState(unlocked && !complete);

  // Auto-open when step becomes unlocked
  useEffect(() => {
    if (unlocked && !complete) setOpen(true);
  }, [unlocked, complete]);

  const fips199Doc = docs['FIPS199'] ?? null;

  return (
    <div style={{ ...styles.stepCard, ...(complete ? styles.stepCardComplete : !unlocked ? styles.stepCardLocked : {}) }}>
      <button style={styles.stepHeader} onClick={() => setOpen((v) => !v)}>
        <div style={stepNumberStyle(complete, unlocked)}>{complete ? '✓' : step.number}</div>
        <div style={styles.stepTitleBlock}>
          <div style={styles.stepTitle}>{step.name}</div>
          <div style={styles.stepTagline}>{step.tagline}</div>
        </div>
        <div style={styles.stepRight}>
          <span style={styles.stepRef}>{step.nistRef}</span>
          {complete && <span style={styles.completeBadge}>Complete</span>}
          {!unlocked && <span style={styles.lockedBadge}>Locked</span>}
          <span style={styles.chevron}>{open ? '▲' : '▼'}</span>
        </div>
      </button>

      {open && (
        <div style={styles.stepBody}>
          {!unlocked && (
            <div style={styles.lockedMsg}>{step.lockedMessage}</div>
          )}

          {/* FIPS 199 rendered inline in Step 2 */}
          {step.number === 2 && (
            <Fips199Card systemId={systemId} doc={fips199Doc} onUpdate={(d) => onDocUpdate('FIPS199', d)} />
          )}

          {step.artifacts
            .filter((a) => !(step.number === 2 && a.kind === 'sync'))
            .map((art) => {
              const docKey = art.type === 'BASELINE' ? 'FIPS199' : art.type;
              return (
                <ArtifactRow
                  key={art.type}
                  systemId={systemId}
                  def={art}
                  doc={docs[docKey] ?? null}
                  system={system}
                  unlocked={unlocked}
                  onDocUpdate={(d) => onDocUpdate(art.type, d)}
                  onView={onView}
                  onComplete={onComplete}
                />
              );
            })}
        </div>
      )}
    </div>
  );
}

// ── Toast ─────────────────────────────────────────────────────────────────────

interface Toast { id: number; label: string }

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div style={toastStyles.stack}>
      {toasts.map((t) => (
        <div key={t.id} style={toastStyles.toast}>
          <span style={toastStyles.icon}>✓</span>
          <span style={toastStyles.msg}><strong>{t.label}</strong> is ready</span>
          <button style={toastStyles.close} onClick={() => onDismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}

const toastStyles: Record<string, React.CSSProperties> = {
  stack: { position: 'fixed', bottom: 24, right: 24, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 9999 },
  toast: {
    display: 'flex', alignItems: 'center', gap: 10,
    background: 'var(--surface)', border: '1px solid rgba(63,185,80,0.4)',
    borderRadius: 8, padding: '10px 14px', minWidth: 260,
    boxShadow: '0 4px 16px var(--shadow)',
    animation: 'slideUp 0.2s ease',
  },
  icon:  { color: 'var(--green)', fontWeight: 700, fontSize: 14 },
  msg:   { flex: 1, fontSize: 13, color: 'var(--text)' },
  close: { background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: 16, padding: '0 2px', cursor: 'pointer', lineHeight: 1 },
};

// ── Main view ──────────────────────────────────────────────────────────────────

interface ViewerState { type: string; label: string; url: string }

export default function RmfView({ systemId }: { systemId: string }) {
  const [docs,    setDocs]    = useState<Record<string, DocumentRecord>>({});
  const [system,  setSystem]  = useState<SystemMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [viewer,  setViewer]  = useState<ViewerState | null>(null);
  const [toasts,  setToasts]  = useState<Toast[]>([]);

  function addToast(label: string) {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, label }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  }

  function dismissToast(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  function updateDoc(type: string, doc: DocumentRecord) {
    setDocs((prev) => ({ ...prev, [type]: doc }));
  }

  useEffect(() => {
    setLoading(true);
    Promise.all([listDocuments(systemId), getSystem(systemId)])
      .then(([list, sys]) => {
        const map: Record<string, DocumentRecord> = {};
        for (const d of list) map[d.sk.replace('DOC#NIST#', '')] = d;
        setDocs(map);
        setSystem(sys);

        // Auto-resume polling for any documents already in-flight (e.g. after page refresh)
        for (const d of list) {
          if (d.status !== 'IN_PROGRESS' && d.status !== 'PENDING') continue;
          const docType = d.sk.replace('DOC#NIST#', '');
          void pollDocument(systemId, docType, d.generationId ?? '', (updated) => {
            setDocs((prev) => ({ ...prev, [docType]: updated }));
            if (updated.status === 'COMPLETED') {
              const label = RMF_STEPS.flatMap((s) => s.artifacts).find((a) => a.type === docType)?.label ?? docType;
              addToast(label);
            }
          }).catch(() => {});
        }
      })
      .catch((e: unknown) => setError((e as Error).message ?? 'Failed to load'))
      .finally(() => setLoading(false));
  }, [systemId]);

  if (loading) return <div style={styles.stateMsg}>Loading…</div>;
  if (error)   return <div style={{ ...styles.stateMsg, color: 'var(--red)' }}>{error}</div>;

  if (viewer) {
    return (
      <DocumentViewer
        docType={viewer.type}
        label={viewer.label}
        presignedUrl={viewer.url}
        onClose={() => setViewer(null)}
      />
    );
  }

  return (
    <div style={styles.root}>
      <RmfProgress steps={RMF_STEPS} docs={docs} system={system} />

      <div style={styles.steps}>
        {RMF_STEPS.map((step) => (
          <StepCard
            key={step.number}
            step={step}
            docs={docs}
            system={system}
            systemId={systemId}
            onDocUpdate={updateDoc}
            onView={(type, label, url) => setViewer({ type, label, url })}
            onComplete={addToast}
          />
        ))}
      </div>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

// ── Style helpers ─────────────────────────────────────────────────────────────

function stepNumberStyle(complete: boolean, unlocked: boolean): React.CSSProperties {
  return {
    width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 12, fontWeight: 700,
    background: complete ? 'rgba(34,197,94,0.15)' : unlocked ? 'rgba(139,87,229,0.15)' : 'var(--surface2)',
    color: complete ? 'var(--green)' : unlocked ? 'var(--purple)' : 'var(--muted)',
    border: `1px solid ${complete ? 'rgba(34,197,94,0.3)' : unlocked ? 'rgba(139,87,229,0.3)' : 'var(--border)'}`,
  };
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  root:    { display: 'flex', flexDirection: 'column', gap: 12 },
  stateMsg:{ padding: 40, color: 'var(--muted)', fontSize: 13 },

  // Progress
  progressWrapper: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  progressHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  progressTitle:  { fontSize: 13, fontWeight: 700, color: 'var(--text)' },
  progressCount:  { fontSize: 12, color: 'var(--muted)' },
  progressBar: {
    height: 4,
    background: 'var(--surface2)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    background: 'var(--purple)',
    borderRadius: 2,
    transition: 'width 0.4s ease',
  },
  stepDots: { display: 'flex', justifyContent: 'space-between' },
  stepDot:  { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 },
  dot: {
    width: 24, height: 24,
    borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 10, fontWeight: 700,
    color: 'var(--text)',
  },
  dotLabel: { fontSize: 10, fontWeight: 500 },

  // Step cards
  steps: { display: 'flex', flexDirection: 'column', gap: 8 },
  stepCard: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    overflow: 'hidden',
  },
  stepCardComplete: { borderColor: 'rgba(34,197,94,0.3)' },
  stepCardLocked:   { opacity: 0.6 },
  stepHeader: {
    width: '100%', textAlign: 'left', background: 'transparent',
    border: 'none', cursor: 'pointer',
    display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px',
  },
  stepTitleBlock: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  stepTitle:   { fontSize: 14, fontWeight: 700, color: 'var(--text)' },
  stepTagline: { fontSize: 12, color: 'var(--muted)' },
  stepRight:   { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },
  stepRef:     { fontSize: 10, color: 'var(--muted)', fontStyle: 'italic', display: 'none' },
  completeBadge: { fontSize: 10, fontWeight: 700, color: 'var(--green)', padding: '2px 7px', borderRadius: 10, border: '1px solid rgba(34,197,94,0.4)', background: 'rgba(34,197,94,0.1)' },
  lockedBadge:   { fontSize: 10, fontWeight: 700, color: 'var(--muted)', padding: '2px 7px', borderRadius: 10, border: '1px solid var(--border)' },
  chevron: { fontSize: 10, color: 'var(--muted)' },
  stepBody: { padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--border)' },
  lockedMsg: { padding: '10px 0 4px', fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' },

  // Artifact rows
  artifactRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, padding: '10px 0',
    borderBottom: '1px solid var(--border)',
  },
  artifactMeta:   { display: 'flex', flexDirection: 'column', gap: 2, flex: 1 },
  artifactLabel:  { fontSize: 13, fontWeight: 600, color: 'var(--text)' },
  artifactDesc:   { fontSize: 12, color: 'var(--muted)' },
  artifactAge:    { fontSize: 11, color: 'var(--muted)' },
  artifactError:  { fontSize: 11, color: 'var(--red)' },
  artifactProgress: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 },
  artifactProgressBar: {
    flex: 1, height: 2, borderRadius: 1,
    background: 'linear-gradient(90deg, var(--purple) 0%, transparent 100%)',
    backgroundSize: '200% 100%',
    animation: 'progress-slide 1.5s linear infinite',
  },
  artifactElapsed: { fontSize: 11, color: 'var(--muted)', flexShrink: 0 },
  artifactStatus: { fontSize: 11, fontWeight: 600, flexShrink: 0 },
  artifactActions:{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },

  btn: { fontSize: 12, fontWeight: 500, padding: '4px 12px', borderRadius: 6, cursor: 'pointer', border: '1px solid' },
  btnPrimary:   { background: 'rgba(139,87,229,0.15)', borderColor: 'rgba(139,87,229,0.4)', color: 'var(--purple)' },
  btnSecondary: { background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' },
};
