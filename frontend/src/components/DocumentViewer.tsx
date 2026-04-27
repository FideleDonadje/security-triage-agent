import { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';

interface Props {
  docType: string;
  label: string;
  presignedUrl: string;
  onClose: () => void;
}

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  'Fully Implemented':    'var(--green)',
  'Implemented':          'var(--green)',
  'Partially Implemented':'var(--yellow)',
  'Not Implemented':      'var(--red)',
  'Inherited':            'var(--muted)',
  'Planned':              'var(--yellow)',
};

function StatusBadge({ value }: { value: string }) {
  return (
    <span style={{ ...styles.badge, color: STATUS_COLORS[value] ?? 'var(--muted)', borderColor: STATUS_COLORS[value] ?? 'var(--border)' }}>
      {value}
    </span>
  );
}

// ── Sensitive data masking ─────────────────────────────────────────────────────

function maskSensitive(text: string): string {
  // Mask 12-digit AWS account IDs: show only last 4 digits
  return text.replace(/\b(\d{8})(\d{4})\b/g, '****$2');
}

// ── Field renderer ─────────────────────────────────────────────────────────────

function FieldValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    return (
      <ul style={styles.list}>
        {(value as unknown[]).map((item, i) => (
          <li key={i} style={styles.listItem}>
            {item !== null && typeof item === 'object'
              ? <ObjectBlock obj={item as Record<string, unknown>} />
              : <span>{String(item ?? '')}</span>}
          </li>
        ))}
      </ul>
    );
  }
  if (value !== null && typeof value === 'object') {
    return <ObjectBlock obj={value as Record<string, unknown>} />;
  }
  return <span style={styles.fieldText}>{maskSensitive(String(value ?? '—'))}</span>;
}

function ObjectBlock({ obj }: { obj: Record<string, unknown> }) {
  return (
    <div style={styles.objectBlock}>
      {Object.entries(obj).filter(([k]) => k !== 'generatedAt' && k !== 'systemId').map(([k, v]) => (
        <div key={k} style={styles.fieldRow}>
          <span style={styles.fieldKey}>{camelToLabel(k)}</span>
          <FieldValue value={v} />
        </div>
      ))}
    </div>
  );
}

// ── SSP control row ────────────────────────────────────────────────────────────

type ControlStatus =
  | 'implemented' | 'partially_implemented' | 'planned'
  | 'alternative_implementation' | 'not_applicable'
  | 'inherited' | 'inherited_shared';

const STATUS_LABEL: Record<string, string> = {
  implemented:               'Implemented',
  partially_implemented:     'Partially Implemented',
  planned:                   'Planned',
  alternative_implementation:'Alternative Implementation',
  not_applicable:            'Not Applicable',
  inherited:                 'Inherited',
  inherited_shared:          'Inherited (Shared)',
};

const ORIGINATION_LABEL: Record<string, string> = {
  sp_system_specific:   'SP System Specific',
  sp_hybrid:            'SP Hybrid',
  configured_by_customer: 'Configured by Customer',
  provided_by_customer: 'Provided by Customer',
  inherited:            'Inherited',
};

interface SspControl {
  controlId: string;
  title?: string;
  status?: ControlStatus | string;
  origination?: string;
  implementationStatus?: string;  // legacy field
  implementationNarrative?: string;
  responsibleEntities?: string;
  testingEvidence?: string;
}

function SspControlRow({ ctrl }: { ctrl: SspControl }) {
  const [open, setOpen] = useState(false);
  const status = ctrl.status ?? ctrl.implementationStatus;
  const displayStatus = STATUS_LABEL[status ?? ''] ?? status ?? '';
  const origLabel = ORIGINATION_LABEL[ctrl.origination ?? ''] ?? ctrl.origination ?? '';
  const isInherited = status === 'inherited' || status === 'inherited_shared';
  return (
    <div style={{ ...styles.controlCard, opacity: isInherited ? 0.75 : 1 }}>
      <button style={styles.controlHeader} onClick={() => setOpen(v => !v)}>
        <span style={styles.controlId}>{ctrl.controlId}</span>
        {ctrl.title && <span style={styles.controlTitle}>{ctrl.title}</span>}
        <div style={styles.familyRight}>
          {origLabel && <span style={styles.originBadge}>{origLabel}</span>}
          {displayStatus && <StatusBadge value={displayStatus} />}
          <span style={styles.chevron}>{open ? '▲' : '▼'}</span>
        </div>
      </button>
      {open && (
        <div style={styles.controlBody}>
          {(['implementationNarrative', 'responsibleEntities', 'testingEvidence'] as const).map((field) =>
            ctrl[field] ? (
              <div key={field} style={styles.familyField}>
                <div style={styles.familyFieldLabel}>{camelToLabel(field)}</div>
                <div style={styles.familyFieldText}>{maskSensitive(ctrl[field]!)}</div>
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

// ── SSP-specific renderer ──────────────────────────────────────────────────────

const SSP_STAT_GROUPS = [
  { keys: ['implemented'],                         label: 'Implemented',  color: 'var(--green)'  },
  { keys: ['partially_implemented', 'planned'],    label: 'Partial/Planned', color: 'var(--yellow)' },
  { keys: ['inherited', 'inherited_shared'],       label: 'Inherited',    color: 'var(--muted)'  },
  { keys: ['not_applicable'],                      label: 'N/A',          color: 'var(--border)' },
];

function SspRenderer({ data }: { data: Record<string, unknown> }) {
  const [openFamilies, setOpenFamilies] = useState<Set<string>>(new Set());
  const overview = data['overview'] as Record<string, unknown> | undefined;
  const families = data['controlFamilies'] as Record<string, unknown>[] | undefined;

  function toggle(fam: string) {
    setOpenFamilies((prev) => {
      const next = new Set(prev);
      next.has(fam) ? next.delete(fam) : next.add(fam);
      return next;
    });
  }

  // Aggregate control statuses for the summary bar
  const statCounts = new Map<string, number>();
  let totalControls = 0;
  for (const fam of families ?? []) {
    for (const ctrl of (fam['controls'] ?? []) as SspControl[]) {
      const s = (ctrl.status ?? ctrl.implementationStatus ?? 'unknown') as string;
      statCounts.set(s, (statCounts.get(s) ?? 0) + 1);
      totalControls++;
    }
  }
  const groupCounts = SSP_STAT_GROUPS.map(g => ({
    ...g,
    count: g.keys.reduce((sum, k) => sum + (statCounts.get(k) ?? 0), 0),
  }));

  return (
    <div style={styles.sections}>
      {overview && (
        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>System Overview</h3>
          <ObjectBlock obj={overview} />
        </section>
      )}

      {families && families.length > 0 && (
        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>Control Families ({families.length})</h3>

          {/* Implementation summary */}
          {totalControls > 0 && (
            <div style={styles.sspStats}>
              <div style={styles.sspStatsBar}>
                {groupCounts.filter(g => g.count > 0).map(g => (
                  <div key={g.label} title={`${g.label}: ${g.count}`}
                    style={{ ...styles.sspStatsSegment, width: `${(g.count / totalControls) * 100}%`, background: g.color }} />
                ))}
              </div>
              <div style={styles.sspStatsLegend}>
                {groupCounts.filter(g => g.count > 0).map(g => (
                  <span key={g.label} style={styles.sspStatChip}>
                    <span style={{ ...styles.sspStatDot, background: g.color }} />
                    <span style={{ color: g.color }}>{g.count}</span>
                    <span style={styles.sspStatLabel}> {g.label}</span>
                  </span>
                ))}
                <span style={styles.sspStatTotal}>{totalControls} total</span>
              </div>
            </div>
          )}
          <div style={styles.familyList}>
            {families.map((fam) => {
              const key = String(fam['family'] ?? fam['familyName'] ?? '?');
              const open = openFamilies.has(key);
              const status = String(fam['familyImplementationStatus'] ?? fam['implementationStatus'] ?? '');
              const controls = (fam['controls'] ?? []) as SspControl[];
              return (
                <div key={key} style={styles.familyCard}>
                  <button style={styles.familyHeader} onClick={() => toggle(key)}>
                    <div style={styles.familyTitle}>
                      <span style={styles.familyCode}>{fam['family'] as string}</span>
                      <span style={styles.familyName}>{fam['familyName'] as string}</span>
                    </div>
                    <div style={styles.familyRight}>
                      <span style={styles.controlCount}>{controls.length} controls</span>
                      {status && <StatusBadge value={status} />}
                      <span style={styles.chevron}>{open ? '▲' : '▼'}</span>
                    </div>
                  </button>

                  {open && (
                    <div style={styles.familyBody}>
                      {!!fam['inheritedControls'] && (
                        <div style={styles.familyField}>
                          <div style={styles.familyFieldLabel}>Inherited Controls</div>
                          <div style={styles.familyFieldText}>{String(fam['inheritedControls'])}</div>
                        </div>
                      )}
                      {controls.length > 0 && (
                        <div style={styles.controlList}>
                          {controls.map((ctrl) => (
                            <SspControlRow key={ctrl.controlId} ctrl={ctrl} />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

// ── POAM-specific renderer ─────────────────────────────────────────────────────

function PoamRenderer({ data }: { data: Record<string, unknown> }) {
  const entries = (data['poamEntries'] ?? data['entries'] ?? []) as Record<string, unknown>[];
  const summary = (data['executiveSummary'] ?? data['summary']) as string | undefined;

  return (
    <div style={styles.sections}>
      {!!summary && (
        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>Executive Summary</h3>
          <p style={styles.prose}>{summary}</p>
        </section>
      )}
      {entries.length > 0 && (
        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>POA&M Entries ({entries.length})</h3>
          <div style={styles.familyList}>
            {entries.map((e, i) => (
              <div key={i} style={styles.familyCard}>
                <div style={styles.familyHeader}>
                  <span style={styles.familyCode}>#{i + 1}</span>
                  <span style={styles.familyName}>{String(e['weakness'] ?? e['title'] ?? `Finding ${i + 1}`)}</span>
                  {!!e['severity'] && <StatusBadge value={String(e['severity'])} />}
                </div>
                <div style={styles.familyBody}>
                  {Object.entries(e).filter(([k]) => !['weakness', 'title'].includes(k)).map(([k, v]) => (
                    <div key={k} style={styles.familyField}>
                      <div style={styles.familyFieldLabel}>{camelToLabel(k)}</div>
                      <div style={styles.familyFieldText}>{Array.isArray(v) ? v.join('; ') : String(v ?? '—')}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ── SAR renderer ──────────────────────────────────────────────────────────────

const RISK_COLOR: Record<string, string> = {
  Low:      'var(--green)',
  Moderate: 'var(--yellow)',
  High:     'var(--red)',
  Critical: '#ff4444',
};

function SarRenderer({ data }: { data: Record<string, unknown> }) {
  const [openFamilies, setOpenFamilies] = useState<Set<string>>(new Set());
  const families = (data['familyAssessments'] ?? []) as Record<string, unknown>[];
  const riskPosture = String(data['overallRiskPosture'] ?? '');

  function toggle(key: string) {
    setOpenFamilies(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  return (
    <div style={styles.sections}>
      {/* Summary card */}
      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>Summary</h3>
        <div style={styles.sarSummaryCard}>
          {(['assessmentScope', 'assessmentMethodology'] as const).map(k =>
            data[k] ? (
              <div key={k} style={styles.sarSummaryRow}>
                <span style={styles.sarSummaryLabel}>{camelToLabel(k).toUpperCase()}</span>
                <p style={styles.prose}>{String(data[k])}</p>
              </div>
            ) : null
          )}
          {riskPosture && (
            <div style={styles.sarSummaryRow}>
              <span style={styles.sarSummaryLabel}>OVERALL RISK POSTURE</span>
              <span style={{ fontWeight: 700, color: RISK_COLOR[riskPosture] ?? 'var(--text)' }}>
                {riskPosture}
              </span>
            </div>
          )}
          {!!data['executiveSummary'] && (
            <div style={styles.sarSummaryRow}>
              <span style={styles.sarSummaryLabel}>EXECUTIVE SUMMARY</span>
              <p style={styles.prose}>{String(data['executiveSummary'])}</p>
            </div>
          )}
        </div>
      </section>

      {/* Family assessments */}
      {families.length > 0 && (
        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>Family Assessments</h3>
          <div style={styles.familyList}>
            {families.map((fam, i) => {
              const key = String(fam['family'] ?? i);
              const open = openFamilies.has(key);
              return (
                <div key={key} style={styles.familyCard}>
                  <button style={styles.familyHeader} onClick={() => toggle(key)}>
                    <div style={styles.familyTitle}>
                      <span style={styles.familyCode}>{String(fam['family'] ?? '')}</span>
                      <span style={styles.familyName}>{String(fam['familyName'] ?? '')}</span>
                    </div>
                    <span style={styles.chevron}>{open ? '▲' : '▼'}</span>
                  </button>
                  {open && (
                    <div style={styles.familyBody}>
                      {(['findingsSummary', 'riskExposure', 'recommendations'] as const).map(k =>
                        fam[k] ? (
                          <div key={k} style={styles.familyField}>
                            <div style={styles.familyFieldLabel}>{camelToLabel(k)}</div>
                            <div style={styles.familyFieldText}>{String(fam[k])}</div>
                          </div>
                        ) : null
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

// ── Generic renderer ──────────────────────────────────────────────────────────

function GenericRenderer({ data }: { data: Record<string, unknown> }) {
  const filtered = Object.entries(data).filter(([k]) => !['generatedAt', 'systemId'].includes(k));
  return (
    <div style={styles.sections}>
      {filtered.map(([key, value]) => (
        <section key={key} style={styles.section}>
          <h3 style={styles.sectionTitle}>{camelToLabel(key)}</h3>
          <FieldValue value={value} />
        </section>
      ))}
    </div>
  );
}

// ── Excel export ──────────────────────────────────────────────────────────────

function exportToExcel(docType: string, label: string, data: Record<string, unknown>) {
  const wb = XLSX.utils.book_new();

  if (docType === 'SSP') {
    const overview = data['overview'] as Record<string, unknown> | undefined;
    if (overview) {
      const overviewRows = Object.entries(overview).map(([k, v]) => ({ Field: camelToLabel(k), Value: String(v ?? '') }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(overviewRows), 'Overview');
    }
    const families = (data['controlFamilies'] ?? []) as Record<string, unknown>[];
    const controlRows: Record<string, string>[] = [];
    for (const fam of families) {
      const controls = (fam['controls'] ?? []) as SspControl[];
      for (const ctrl of controls) {
        const status = ctrl.status ?? ctrl.implementationStatus ?? '';
        controlRows.push({
          Family:                     String(fam['family'] ?? ''),
          'Family Name':              String(fam['familyName'] ?? ''),
          'Control ID':               ctrl.controlId,
          Title:                      ctrl.title ?? '',
          'Status':                   STATUS_LABEL[status] ?? status,
          'Origination':              ORIGINATION_LABEL[ctrl.origination ?? ''] ?? ctrl.origination ?? '',
          'Responsible Entities':     ctrl.responsibleEntities ?? '',
          'Implementation Narrative': ctrl.implementationNarrative ?? '',
          'Testing Evidence':         ctrl.testingEvidence ?? '',
        });
      }
    }
    if (controlRows.length > 0) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(controlRows), 'Controls');
    }
  } else if (docType === 'POAM') {
    // Data shape: flat poamEntries array (matches PoamRenderer)
    const raw = (data['poamEntries'] ?? data['entries'] ?? []) as Record<string, unknown>[];
    const entries: Record<string, string>[] = raw.map((e) => ({
      'POA&M ID':              String(e['poamId'] ?? ''),
      'Weakness / Finding':    String(e['weakness'] ?? e['title'] ?? e['description'] ?? ''),
      'Affected Control':      String(e['affectedControl'] ?? ''),
      'Risk Rating':           String(e['severity'] ?? e['riskRating'] ?? ''),
      'Status':                String(e['status'] ?? ''),
      'Date Identified':       String(e['dateIdentified'] ?? ''),
      'Scheduled Completion':  String(e['scheduledCompletionDate'] ?? ''),
      'Responsible Party':     String(e['responsibleParty'] ?? e['owner'] ?? ''),
      'Remediation Plan':      String(e['remediationPlan'] ?? ''),
      'Resources Required':    String(e['resourcesRequired'] ?? ''),
      'Milestones':            Array.isArray(e['milestones']) ? (e['milestones'] as string[]).join('; ') : String(e['milestones'] ?? ''),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(entries.length > 0 ? entries : [{ Note: 'No POA&M entries' }]), 'POA&M Entries');
  } else {
    const rows = flattenForExcel(data);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), docType);
  }

  XLSX.writeFile(wb, `${label.replace(/\s+/g, '_')}.xlsx`);
}

function flattenForExcel(obj: Record<string, unknown>, prefix = ''): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'generatedAt' || k === 'systemId') continue;
    const label = prefix ? `${prefix} > ${camelToLabel(k)}` : camelToLabel(k);
    if (Array.isArray(v)) {
      rows.push({ Field: label, Value: v.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('; ') });
    } else if (v !== null && typeof v === 'object') {
      rows.push(...flattenForExcel(v as Record<string, unknown>, label));
    } else {
      rows.push({ Field: label, Value: String(v ?? '') });
    }
  }
  return rows;
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function DocumentViewer({ docType, label, presignedUrl, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [data,    setData]    = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(presignedUrl)
      .then((r) => r.json() as Promise<Record<string, unknown>>)
      .then(setData)
      .catch((e: unknown) => setError((e as Error).message ?? 'Failed to load'))
      .finally(() => setLoading(false));
  }, [presignedUrl]);

  function renderContent() {
    if (!data) return null;
    if (docType === 'SSP')  return <SspRenderer  data={data} />;
    if (docType === 'POAM') return <PoamRenderer data={data} />;
    if (docType === 'SAR')  return <SarRenderer  data={data} />;
    return <GenericRenderer data={data} />;
  }

  return (
    <div style={styles.root}>
      <div style={styles.toolbar}>
        <button style={styles.backBtn} onClick={onClose}>← Back</button>
        <span style={styles.docLabel}>{label}</span>
        {data && (
          <button style={styles.downloadBtn} onClick={() => exportToExcel(docType, label, data)}>
            Download Excel
          </button>
        )}
      </div>

      <div style={styles.body}>
        {loading && <div style={styles.stateMsg}>Loading document…</div>}
        {error   && <div style={{ ...styles.stateMsg, color: 'var(--red)' }}>{error}</div>}
        {!loading && !error && data && renderContent()}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function camelToLabel(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
}

const styles: Record<string, React.CSSProperties> = {
  root:    { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  toolbar: {
    height: 48,
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '0 24px',
    flexShrink: 0,
    background: 'var(--surface)',
  },
  backBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--purple)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    padding: 0,
  },
  docLabel: { flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--text)' },
  downloadBtn: {
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    fontSize: 12,
    fontWeight: 500,
    padding: '4px 12px',
    borderRadius: 6,
    cursor: 'pointer',
  },
  body:       { flex: 1, overflow: 'auto', padding: '24px 32px', maxWidth: 860 },
  stateMsg:   { padding: 40, color: 'var(--muted)', fontSize: 13 },
  sections:   { display: 'flex', flexDirection: 'column', gap: 24 },
  section:    { display: 'flex', flexDirection: 'column', gap: 12 },
  sectionTitle: { fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: 0, paddingBottom: 8, borderBottom: '1px solid var(--border)' },
  prose:      { fontSize: 13, color: 'var(--text)', lineHeight: 1.7, margin: 0 },
  list:       { margin: '4px 0 0 16px', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  listItem:   { fontSize: 13, color: 'var(--text)', lineHeight: 1.6 },
  objectBlock:{ display: 'flex', flexDirection: 'column', gap: 8 },
  fieldRow:   { display: 'flex', flexDirection: 'column', gap: 2 },
  fieldKey:   { fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' },
  fieldText:  { fontSize: 13, color: 'var(--text)', lineHeight: 1.6 },
  badge: {
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 7px',
    borderRadius: 10,
    border: '1px solid',
    flexShrink: 0,
  },
  controlCount: { fontSize: 11, color: 'var(--muted)', marginRight: 4 },
  controlList: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 },
  sarSummaryCard: { display: 'flex', flexDirection: 'column', gap: 16, background: 'var(--surface2)', borderRadius: 8, padding: '16px 20px' },
  sarSummaryRow: { display: 'flex', flexDirection: 'column', gap: 6 },
  sarSummaryLabel: { fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--muted)' },
  controlCard: { border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' },
  controlHeader: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
    background: 'var(--bg)', cursor: 'pointer', border: 'none', width: '100%', textAlign: 'left',
  },
  controlId:    { fontSize: 11, fontWeight: 700, color: 'var(--purple)', minWidth: 44, flexShrink: 0 },
  controlTitle: { flex: 1, fontSize: 12, color: 'var(--text)' },
  originBadge:  { fontSize: 10, color: 'var(--muted)', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 5px', flexShrink: 0 },
  controlBody:  { padding: '10px 12px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 },
  familyList: { display: 'flex', flexDirection: 'column', gap: 6 },
  familyCard: { border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' },
  familyHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px',
    background: 'var(--surface)',
    cursor: 'pointer',
    border: 'none',
    width: '100%',
    textAlign: 'left',
    gap: 10,
  },
  familyTitle: { display: 'flex', alignItems: 'center', gap: 10, flex: 1 },
  familyCode:  { fontSize: 11, fontWeight: 700, color: 'var(--purple)', minWidth: 28 },
  familyName:  { fontSize: 13, fontWeight: 600, color: 'var(--text)' },
  familyRight: { display: 'flex', alignItems: 'center', gap: 10 },
  chevron:     { fontSize: 10, color: 'var(--muted)' },
  familyBody:  { padding: '12px 14px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--bg)' },
  familyField: { display: 'flex', flexDirection: 'column', gap: 4 },
  familyFieldLabel: { fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' },
  familyFieldText:  { fontSize: 13, color: 'var(--text)', lineHeight: 1.7 },
  sspStats:         { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 14px', background: 'var(--surface2)', borderRadius: 6, border: '1px solid var(--border)' },
  sspStatsBar:      { height: 6, borderRadius: 3, overflow: 'hidden', display: 'flex', background: 'var(--border)' },
  sspStatsSegment:  { height: '100%', transition: 'width 0.4s ease' },
  sspStatsLegend:   { display: 'flex', flexWrap: 'wrap', gap: '6px 14px', alignItems: 'center' },
  sspStatChip:      { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 },
  sspStatDot:       { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  sspStatLabel:     { color: 'var(--muted)' },
  sspStatTotal:     { marginLeft: 'auto', fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' },
};
