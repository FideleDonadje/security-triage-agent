/**
 * AtoAssist.tsx — ATO Report Generator panel
 *
 * Layout:
 *   Header: title | standards dropdown | Generate button
 *   Left sidebar: job history (last 20 jobs, clickable to reload a report)
 *   Main area: progress / empty state / rendered report
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  generateAtoReport, getAtoStatus, fetchAtoReport, getEnabledStandards, getJobHistory,
  type AtoJob, type AtoReport, type ControlFamily, type PoamEntry,
  type SecurityStandard, type AtoJobSummary,
} from '../lib/api';

const POLL_MS     = 3_000;
const RISK_COLORS: Record<string, string> = {
  High:   'var(--red)',
  Medium: 'var(--yellow)',
  Low:    'var(--green)',
};
const STATUS_COLOR: Record<string, string> = {
  COMPLETED:   'var(--green)',
  FAILED:      'var(--red)',
  IN_PROGRESS: 'var(--blue)',
  PENDING:     'var(--muted)',
};

// ── Main component ─────────────────────────────────────────────────────────────

export default function AtoAssist() {
  // Standards
  const [standards,        setStandards]        = useState<SecurityStandard[]>([]);
  const [standardsLoading, setStandardsLoading] = useState(true);
  const [selectedArn,      setSelectedArn]       = useState<string>('');

  // History
  const [history,        setHistory]        = useState<AtoJobSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  // Current job
  const [jobId,      setJobId]      = useState<string | null>(null);
  const [job,        setJob]        = useState<AtoJob | null>(null);
  const [report,     setReport]     = useState<AtoReport | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load standards + history on mount ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const { standards: list } = await getEnabledStandards();
        if (cancelled) return;
        setStandards(list);
        const first = list.find((s) => s.atoSuitable && s.status === 'READY');
        if (first) setSelectedArn(first.standardsArn);
      } catch (e) {
        console.warn('Failed to load standards:', (e as Error).message);
      } finally {
        if (!cancelled) setStandardsLoading(false);
      }
    })();

    void (async () => {
      try {
        const jobs = await getJobHistory();
        if (!cancelled) setHistory(jobs);
      } catch (e) {
        console.warn('Failed to load job history:', (e as Error).message);
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const pollStatus = useCallback(async (id: string) => {
    try {
      const status = await getAtoStatus(id);
      setJob(status);

      if (status.status === 'COMPLETED' && status.presignedUrl) {
        stopPolling();
        // Refresh history so the new job appears
        getJobHistory().then(setHistory).catch(() => null);
        try {
          const fetched = await fetchAtoReport(status.presignedUrl);
          setReport(fetched);
        } catch (e) {
          setError(`Report ready but could not be fetched: ${(e as Error).message}`);
        }
      } else if (status.status === 'FAILED') {
        stopPolling();
        getJobHistory().then(setHistory).catch(() => null);
        setError(status.error ?? 'Report generation failed.');
      }
    } catch (e) {
      console.warn('Poll error:', (e as Error).message);
    }
  }, [stopPolling]);

  // ── Generate new report ───────────────────────────────────────────────────────
  const handleGenerate = async () => {
    const selected = standards.find((s) => s.standardsArn === selectedArn);
    if (!selected) return;

    setGenerating(true);
    setError(null);
    setReport(null);
    setJob(null);
    setJobId(null);
    stopPolling();

    try {
      const { jobId: newJobId } = await generateAtoReport(selected.standardsArn, selected.name);
      setJobId(newJobId);
      void pollStatus(newJobId);
      pollRef.current = setInterval(() => void pollStatus(newJobId), POLL_MS);
    } catch (e) {
      setError(`Failed to start report: ${(e as Error).message}`);
    } finally {
      setGenerating(false);
    }
  };

  // ── Load a historical report ──────────────────────────────────────────────────
  const handleLoadHistory = async (summary: AtoJobSummary) => {
    if (summary.status !== 'COMPLETED') return;
    stopPolling();
    setError(null);
    setReport(null);
    setJob(null);
    setJobId(summary.jobId);

    try {
      const status = await getAtoStatus(summary.jobId);
      setJob(status);
      if (status.presignedUrl) {
        const fetched = await fetchAtoReport(status.presignedUrl);
        setReport(fetched);
      }
    } catch (e) {
      setError(`Failed to load report: ${(e as Error).message}`);
    }
  };

  const isPolling   = !!pollRef.current;
  const selectedStd = standards.find((s) => s.standardsArn === selectedArn);
  const canGenerate = !generating && !isPolling && !!selectedStd?.atoSuitable;

  const statusLabel = job
    ? ({ PENDING: 'Queued…', IN_PROGRESS: 'Generating…', COMPLETED: 'Complete', FAILED: 'Failed' }[job.status] ?? job.status)
    : null;

  return (
    <div style={styles.container}>
      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <div style={styles.header}>
        <span style={styles.headerTitle}>ATO Report Generator</span>

        <div style={styles.headerControls}>
          {standardsLoading ? (
            <span style={styles.mutedText}>Loading standards…</span>
          ) : standards.length === 0 ? (
            <span style={styles.warnText}>No standards enabled</span>
          ) : (
            <select
              value={selectedArn}
              onChange={(e) => setSelectedArn(e.target.value)}
              disabled={generating || isPolling}
              style={styles.select}
            >
              {standards.map((s) => (
                <option
                  key={s.standardsArn}
                  value={s.standardsArn}
                  disabled={!s.atoSuitable || s.status !== 'READY'}
                >
                  {s.name}{!s.atoSuitable ? ' (not ATO-suitable)' : s.status !== 'READY' ? ` (${s.status})` : ''}
                </option>
              ))}
            </select>
          )}

          <button
            onClick={() => void handleGenerate()}
            disabled={!canGenerate}
            style={{ ...styles.generateBtn, opacity: canGenerate ? 1 : 0.5, cursor: canGenerate ? 'pointer' : 'not-allowed' }}
            title={!selectedStd?.atoSuitable ? selectedStd?.notSuitableReason : undefined}
          >
            {generating ? 'Starting…' : isPolling ? 'Generating…' : 'Generate Report'}
          </button>
        </div>
      </div>

      {/* Non-suitable warning */}
      {selectedStd && !selectedStd.atoSuitable && (
        <div style={styles.warnBanner}>{selectedStd.notSuitableReason}</div>
      )}

      {/* ── Body: sidebar + main ──────────────────────────────────────────────── */}
      <div style={styles.body}>
        {/* History sidebar */}
        <div style={styles.sidebar}>
          <div style={styles.sidebarTitle}>Report History</div>

          {historyLoading ? (
            <div style={styles.sidebarEmpty}>Loading…</div>
          ) : history.length === 0 ? (
            <div style={styles.sidebarEmpty}>No reports yet</div>
          ) : (
            history.map((h) => {
              const isActive = h.jobId === jobId;
              return (
                <button
                  key={h.jobId}
                  onClick={() => void handleLoadHistory(h)}
                  disabled={h.status !== 'COMPLETED'}
                  style={{
                    ...styles.historyItem,
                    ...(isActive ? styles.historyItemActive : {}),
                    cursor: h.status === 'COMPLETED' ? 'pointer' : 'default',
                    opacity: h.status === 'FAILED' ? 0.6 : 1,
                  }}
                  title={h.status !== 'COMPLETED' ? (h.error ?? h.status) : undefined}
                >
                  <div style={styles.historyTop}>
                    <span style={{ ...styles.historyStatus, color: STATUS_COLOR[h.status] ?? 'var(--muted)' }}>
                      {h.status === 'COMPLETED' ? '✓' : h.status === 'FAILED' ? '✗' : '●'}
                    </span>
                    <span style={styles.historyStd}>{h.standardName ?? 'NIST 800-53'}</span>
                  </div>
                  <div style={styles.historyDate}>
                    {new Date(h.startTime).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Main content */}
        <div style={styles.main}>
          {error && (
            <div style={styles.errorBanner}>
              <span>{error}</span>
              <button onClick={() => setError(null)} style={styles.dismissBtn}>×</button>
            </div>
          )}

          {isPolling && job && (
            <div style={styles.progressCard}>
              <div style={styles.progressDot} />
              <div>
                <div style={styles.progressLabel}>{statusLabel}</div>
                <div style={styles.progressSub}>Job {jobId ?? ''}</div>
              </div>
            </div>
          )}

          {!report && !isPolling && !error && (
            <div style={styles.emptyState}>
              <div style={styles.emptyIcon}>📋</div>
              <div style={styles.emptyTitle}>No report loaded</div>
              <div style={styles.emptyBody}>
                {standards.length === 0 && !standardsLoading
                  ? 'Enable NIST 800-53 Rev 5 in Security Hub, then generate a report.'
                  : history.length > 0
                    ? 'Select a past report from the history panel, or generate a new one.'
                    : 'Select a standard and click Generate Report.'}
              </div>
            </div>
          )}

          {report && (
            <>
              <SummaryCard report={report} standardName={selectedStd?.name} />
              {report.controlFamilies.length === 0 ? (
                <div style={styles.emptyState}>
                  <div style={styles.emptyTitle}>No NIST 800-53 findings found</div>
                  <div style={styles.emptyBody}>
                    Security Hub returned no findings mapped to NIST 800-53 control families.
                    It can take 24-48 hours after enabling the standard for findings to populate.
                  </div>
                </div>
              ) : (
                <FamilyTabs families={report.controlFamilies} reportKey={report.generatedAt} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Summary card ───────────────────────────────────────────────────────────────

function SummaryCard({ report, standardName }: { report: AtoReport; standardName?: string }) {
  const { totalFindings, totalFailed, familiesEvaluated } = report.summary;
  const totalPassed = totalFindings - totalFailed;
  const passRate = totalFindings > 0
    ? Math.round((totalPassed / totalFindings) * 100)
    : 100;
  return (
    <div style={styles.summaryCard}>
      <div style={styles.summaryRow}>
        <Stat label="Findings"  value={totalFindings} />
        <Stat label="Passed"    value={totalPassed}   color="var(--green)" />
        <Stat label="Failed"    value={totalFailed}   color="var(--red)" />
        <Stat label="Pass Rate" value={`${passRate}%`} color={passRate >= 80 ? 'var(--green)' : 'var(--yellow)'} />
        <Stat label="Families"  value={familiesEvaluated} />
      </div>
      <div style={styles.summaryFooter}>
        {standardName && <span style={{ marginRight: 12 }}>{standardName}</span>}
        Generated {new Date(report.generatedAt).toLocaleString()}
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={styles.stat}>
      <div style={{ ...styles.statValue, ...(color ? { color } : {}) }}>{value}</div>
      <div style={styles.statLabel}>{label}</div>
    </div>
  );
}

// ── Family tabs ───────────────────────────────────────────────────────────────

function FamilyTabs({ families, reportKey }: { families: ControlFamily[]; reportKey: string }) {
  const [activeIdx, setActiveIdx] = useState(0);
  // Reset to first tab when report changes
  useEffect(() => { setActiveIdx(0); }, [reportKey]);

  const active = families[activeIdx];

  return (
    <div style={styles.tabContainer}>
      {/* Tab strip */}
      <div style={styles.tabStrip}>
        {families.map((cf, i) => {
          const isActive = i === activeIdx;
          const accent   = cf.failCount > 0 ? 'var(--red)' : 'var(--green)';
          return (
            <button
              key={cf.family}
              onClick={() => setActiveIdx(i)}
              style={{
                ...styles.tab,
                borderBottom: isActive ? `2px solid ${accent}` : '2px solid transparent',
                color: isActive ? 'var(--text)' : 'var(--muted)',
                background: isActive ? 'var(--surface2)' : 'transparent',
              }}
            >
              <span style={{
                ...styles.tabCode,
                color: accent,
                background: cf.failCount > 0 ? 'rgba(248,81,73,0.1)' : 'rgba(63,185,80,0.08)',
                borderColor: cf.failCount > 0 ? 'rgba(248,81,73,0.35)' : 'rgba(63,185,80,0.25)',
              }}>
                {cf.family}
              </span>
              {cf.failCount > 0 && (
                <span style={styles.tabBadge}>{cf.failCount}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Active family detail */}
      {active && <FamilyDetail family={active} />}
    </div>
  );
}

// ── Family detail panel ────────────────────────────────────────────────────────

function FamilyDetail({ family }: { family: ControlFamily }) {
  const passRate = family.findingCount > 0
    ? Math.round((family.passCount / family.findingCount) * 100)
    : 100;
  const accent = family.failCount > 0 ? 'var(--red)' : 'var(--green)';

  return (
    <div style={styles.familyDetail}>
      {/* Family header bar */}
      <div style={styles.familyDetailHeader}>
        <div style={styles.familyDetailLeft}>
          <span style={{
            ...styles.familyCode,
            color: accent,
            background: family.failCount > 0 ? 'rgba(248,81,73,0.1)' : 'rgba(63,185,80,0.08)',
            borderColor: family.failCount > 0 ? 'rgba(248,81,73,0.35)' : 'rgba(63,185,80,0.25)',
            fontSize: 14, padding: '3px 10px',
          }}>
            {family.family}
          </span>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>{family.familyName}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              {family.findingCount} findings · {passRate}% pass rate
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span style={{ ...styles.badge, color: 'var(--green)', background: 'rgba(63,185,80,0.1)', borderColor: 'rgba(63,185,80,0.3)', fontSize: 12, padding: '3px 10px' }}>
            {family.passCount} pass
          </span>
          {family.failCount > 0 && (
            <span style={{ ...styles.badge, color: 'var(--red)', background: 'rgba(248,81,73,0.1)', borderColor: 'rgba(248,81,73,0.3)', fontSize: 12, padding: '3px 10px' }}>
              {family.failCount} fail
            </span>
          )}
        </div>
      </div>

      {/* Narratives */}
      <div style={styles.narrativeGrid}>
        <div style={styles.narrativeCard}>
          <div style={styles.narrativeLabel}>Risk Assessment</div>
          <div style={styles.narrativeText}>{family.riskAssessment}</div>
        </div>
        <div style={styles.narrativeCard}>
          <div style={styles.narrativeLabel}>Implementation Statement</div>
          <div style={styles.narrativeText}>{family.implementationStatement}</div>
        </div>
      </div>

      {/* POA&M */}
      {family.failCount === 0 ? (
        <div style={styles.allPassBanner}>
          All {family.passCount} controls in this family are passing. No POA&amp;M entries required.
        </div>
      ) : (
        <div style={styles.poamSection}>
          <div style={styles.narrativeLabel}>POA&amp;M Entries ({family.poamEntries.length})</div>
          <PoamTable entries={family.poamEntries} />
        </div>
      )}
    </div>
  );
}

// ── POA&M table ────────────────────────────────────────────────────────────────

function PoamTable({ entries }: { entries: PoamEntry[] }) {
  return (
    <div style={styles.tableWrapper}>
      <table style={styles.table}>
        <thead>
          <tr>
            {['POA&M ID', 'Control', 'Risk', 'Status', 'Due', 'Description', 'Remediation Plan'].map((h) => (
              <th key={h} style={styles.th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.poamId} style={styles.tr}>
              <td style={{ ...styles.td, ...styles.mono }}>{e.poamId}</td>
              <td style={{ ...styles.td, ...styles.mono }}>{e.affectedControl}</td>
              <td style={styles.td}>
                <span style={{ color: RISK_COLORS[e.riskRating] ?? 'var(--muted)', fontWeight: 600, fontSize: 11 }}>
                  {e.riskRating}
                </span>
              </td>
              <td style={styles.td}>{e.status}</td>
              <td style={{ ...styles.td, ...styles.mono, whiteSpace: 'nowrap' }}>{e.scheduledCompletionDate}</td>
              <td style={styles.td}>{e.description}</td>
              <td style={styles.td}>{e.remediationPlan}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container:    { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)', overflow: 'hidden' },
  header:       { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0, gap: 12 },
  headerTitle:  { fontWeight: 600, fontSize: 14, flexShrink: 0 },
  headerControls: { display: 'flex', alignItems: 'center', gap: 8 },
  select: {
    background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)',
    borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer', maxWidth: 280,
  },
  generateBtn:  { background: 'var(--blue)', color: '#fff', fontSize: 12, fontWeight: 600, padding: '5px 14px', borderRadius: 6, flexShrink: 0 },
  mutedText:    { fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' },
  warnText:     { fontSize: 12, color: 'var(--yellow)' },
  warnBanner:   { background: 'rgba(210,153,34,0.1)', border: '1px solid rgba(210,153,34,0.3)', padding: '7px 16px', color: 'var(--yellow)', fontSize: 12, flexShrink: 0 },

  body:    { display: 'flex', flex: 1, overflow: 'hidden' },

  // Sidebar
  sidebar:      { width: 200, flexShrink: 0, borderRight: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  sidebarTitle: { padding: '10px 12px 6px', fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase' as const, letterSpacing: '0.06em', flexShrink: 0 },
  sidebarEmpty: { padding: '12px', fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' },
  historyItem:  {
    display: 'block', width: '100%', textAlign: 'left' as const, padding: '8px 12px',
    background: 'transparent', borderBottom: '1px solid var(--border)', borderRadius: 0,
    transition: 'background 0.1s',
  },
  historyItemActive: { background: 'var(--surface2)' },
  historyTop:   { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 },
  historyStatus: { fontSize: 12, fontWeight: 700, flexShrink: 0 },
  historyStd:   { fontSize: 11, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  historyDate:  { fontSize: 10, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace' },

  // Main
  main:         { flex: 1, overflow: 'hidden', padding: '12px 12px 12px', display: 'flex', flexDirection: 'column', gap: 10 },
  errorBanner:  { background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.3)', borderRadius: 6, padding: '8px 12px', color: 'var(--red)', fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  dismissBtn:   { background: 'transparent', color: 'var(--muted)', fontSize: 16, padding: '0 4px', flexShrink: 0 },
  progressCard: { display: 'flex', alignItems: 'center', gap: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px' },
  progressDot:  { width: 10, height: 10, borderRadius: '50%', background: 'var(--blue)', flexShrink: 0 },
  progressLabel: { fontSize: 13, fontWeight: 600, color: 'var(--text)' },
  progressSub:  { fontSize: 11, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace', marginTop: 2 },
  emptyState:   { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 24px', gap: 12, flex: 1 },
  emptyIcon:    { fontSize: 32 },
  emptyTitle:   { fontSize: 14, fontWeight: 600, color: 'var(--text)' },
  emptyBody:    { fontSize: 13, color: 'var(--muted)', textAlign: 'center', maxWidth: 380, lineHeight: 1.6 },
  summaryCard:  { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 },
  summaryRow:   { display: 'flex', gap: 24, flexWrap: 'wrap' as const },
  summaryFooter: { marginTop: 10, fontSize: 11, color: 'var(--muted)' },
  stat:         { display: 'flex', flexDirection: 'column', gap: 2 },
  statValue:    { fontSize: 22, fontWeight: 700, color: 'var(--text)' },
  statLabel:    { fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  // Tabs
  tabContainer:  { display: 'flex', flexDirection: 'column' as const, flex: 1, overflow: 'hidden', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 },
  tabStrip:      { display: 'flex', overflowX: 'auto' as const, borderBottom: '1px solid var(--border)', background: 'var(--bg)', flexShrink: 0, scrollbarWidth: 'none' as const },
  tab:           { display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', cursor: 'pointer', fontWeight: 500, fontSize: 12, flexShrink: 0, transition: 'background 0.1s', whiteSpace: 'nowrap' as const },
  tabCode:       { fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 11, fontWeight: 700, border: '1px solid', borderRadius: 4, padding: '1px 5px', letterSpacing: '0.05em' },
  tabBadge:      { fontSize: 10, fontWeight: 700, color: 'var(--red)', background: 'rgba(248,81,73,0.12)', border: '1px solid rgba(248,81,73,0.3)', borderRadius: 10, padding: '0px 5px', minWidth: 16, textAlign: 'center' as const },
  familyDetail:  { flex: 1, overflowY: 'auto' as const, padding: 20, display: 'flex', flexDirection: 'column' as const, gap: 16 },
  familyDetailHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' as const },
  familyDetailLeft:   { display: 'flex', alignItems: 'center', gap: 12 },
  familyCode:    { fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 13, fontWeight: 700, border: '1px solid', borderRadius: 5, padding: '3px 8px', flexShrink: 0, letterSpacing: '0.05em' },
  narrativeGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  narrativeCard: { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '12px 14px', display: 'flex', flexDirection: 'column' as const, gap: 6 },
  badge:         { fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20, border: '1px solid', letterSpacing: '0.03em' },
  allPassBanner: { fontSize: 13, color: 'var(--green)', background: 'rgba(63,185,80,0.08)', border: '1px solid rgba(63,185,80,0.2)', borderRadius: 6, padding: '10px 14px' },
  narrativeSection: { display: 'flex', flexDirection: 'column', gap: 4 },
  narrativeLabel: { fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  narrativeText: { fontSize: 13, color: 'var(--text)', lineHeight: 1.6 },
  poamSection:  { display: 'flex', flexDirection: 'column', gap: 8 },
  tableWrapper: { overflowX: 'auto' },
  table:        { width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 },
  th:           { padding: '6px 10px', textAlign: 'left' as const, fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase' as const, letterSpacing: '0.04em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' as const, background: 'var(--surface2)' },
  tr:           { borderBottom: '1px solid var(--border)' },
  td:           { padding: '7px 10px', color: 'var(--text)', verticalAlign: 'top' as const, lineHeight: 1.5 },
  mono:         { fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 11 },
};
