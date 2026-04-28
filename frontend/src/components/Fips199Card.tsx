import { useState } from 'react';
import type { DocumentRecord } from '../lib/compliance-api';
import { saveFips199 } from '../lib/compliance-api';

interface Props {
  systemId: string;
  doc: DocumentRecord | null;
  onUpdate: (doc: DocumentRecord) => void;
}

type Level = 'Low' | 'Moderate' | 'High';
const LEVELS: Level[] = ['Low', 'Moderate', 'High'];

const LEVEL_COLOR: Record<Level, string> = {
  Low:      'var(--green)',
  Moderate: 'var(--yellow)',
  High:     'var(--red)',
};

// NIST 800-53 Rev 5 control family counts by baseline.
// Counts sourced from official NIST SP 800-53B (cumulative, non-withdrawn controls).
// PM (37) and PT (21) apply at all baselines: PM = org-wide, PT = privacy baseline.
const NIST_BASELINES: Record<Level, { families: string[]; controlCount: number }> = {
  Low:      { controlCount: 207, families: ['AC', 'AT', 'AU', 'CA', 'CM', 'CP', 'IA', 'IR', 'MA', 'MP', 'PE', 'PL', 'PM', 'PS', 'PT', 'RA', 'SA', 'SC', 'SI', 'SR'] },
  Moderate: { controlCount: 345, families: ['AC', 'AT', 'AU', 'CA', 'CM', 'CP', 'IA', 'IR', 'MA', 'MP', 'PE', 'PL', 'PM', 'PS', 'PT', 'RA', 'SA', 'SC', 'SI', 'SR'] },
  High:     { controlCount: 428, families: ['AC', 'AT', 'AU', 'CA', 'CM', 'CP', 'IA', 'IR', 'MA', 'MP', 'PE', 'PL', 'PM', 'PS', 'PT', 'RA', 'SA', 'SC', 'SI', 'SR'] },
};

const FAMILY_NAMES: Record<string, string> = {
  AC: 'Access Control', AT: 'Awareness & Training', AU: 'Audit & Accountability',
  CA: 'Assessment & Authorization', CM: 'Configuration Mgmt', CP: 'Contingency Planning',
  IA: 'Identification & Authentication', IR: 'Incident Response', MA: 'Maintenance',
  MP: 'Media Protection', PE: 'Physical & Environmental', PL: 'Planning',
  PM: 'Program Management', PS: 'Personnel Security', PT: 'PII Processing & Transparency',
  RA: 'Risk Assessment', SA: 'System & Services Acquisition',
  SC: 'System & Comms Protection', SI: 'System & Info Integrity', SR: 'Supply Chain Risk',
};

// Which families are most sensitive to each C/I/A dimension
const CIA_FAMILIES: Record<string, string[]> = {
  confidentiality: ['AC', 'AU', 'IA', 'SC', 'MP'],
  integrity:       ['CM', 'SA', 'SI', 'SR'],
  availability:    ['CP', 'IR', 'PE', 'MA'],
};

export default function Fips199Card({ systemId, doc, onUpdate }: Props) {
  const [confidentiality, setConfidentiality] = useState<Level>((doc?.confidentiality as Level) ?? 'Low');
  const [integrity,       setIntegrity]       = useState<Level>((doc?.integrity       as Level) ?? 'Low');
  const [availability,    setAvailability]    = useState<Level>((doc?.availability    as Level) ?? 'Low');
  const [saving,   setSaving]  = useState(false);
  const [saved,    setSaved]   = useState(false);
  const [error,    setError]   = useState('');
  const [showNist, setShowNist] = useState(false);

  const overall = LEVELS[Math.max(
    LEVELS.indexOf(confidentiality),
    LEVELS.indexOf(integrity),
    LEVELS.indexOf(availability),
  )] as Level;

  const savedOverall = doc?.overallImpact as Level | undefined;
  const baseline = savedOverall ? NIST_BASELINES[savedOverall] : null;

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const res = await saveFips199(systemId, { confidentiality, integrity, availability });
      onUpdate({
        ...(doc ?? { pk: `SYSTEM#${systemId}`, sk: 'DOC#NIST#FIPS199' }),
        status: null,
        confidentiality,
        integrity,
        availability,
        overallImpact: res.overallImpact,
      });
      setSaved(true);
      setShowNist(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: unknown) {
      const msg = (e as Error).message ?? 'Save failed';
      setError(msg.includes('fetch') ? 'Network error — check API Gateway CORS and redeploy compliance stack' : msg);
    } finally {
      setSaving(false);
    }
  }

  function LevelSelect({ value, onChange }: { value: Level; onChange: (v: Level) => void }) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value as Level)}
        style={{ ...styles.select, color: LEVEL_COLOR[value] }}>
        {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
      </select>
    );
  }

  return (
    <div style={styles.card}>
      <div style={styles.heading}>
        <span style={styles.title}>FIPS 199 Impact Level</span>
        {savedOverall && (
          <span style={{ ...styles.overall, color: LEVEL_COLOR[savedOverall] }}>
            Saved: {savedOverall}
          </span>
        )}
      </div>

      <div style={styles.rows}>
        {([['Confidentiality', confidentiality, setConfidentiality],
           ['Integrity',       integrity,       setIntegrity],
           ['Availability',    availability,    setAvailability]] as [string, Level, (v: Level) => void][])
          .map(([label, value, setter]) => (
            <div key={label} style={styles.row}>
              <span style={styles.rowLabel}>{label}</span>
              <LevelSelect value={value} onChange={setter} />
            </div>
          ))}
      </div>

      <div style={styles.footer}>
        <span style={styles.computed}>
          Computed overall: <strong style={{ color: LEVEL_COLOR[overall] }}>{overall}</strong>
        </span>
        <div style={styles.footerRight}>
          {error && <span style={styles.errorMsg}>{error}</span>}
          {saved && <span style={styles.savedMsg}>Saved</span>}
          <button style={{ ...styles.saveBtn, opacity: saving ? 0.5 : 1 }} onClick={() => { void handleSave(); }} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/* NIST 800-53 impact panel */}
      {baseline && (
        <div style={styles.nistPanel}>
          <button style={styles.nistToggle} onClick={() => setShowNist((v) => !v)}>
            NIST 800-53 Rev 5 impact ({baseline.controlCount} controls at {savedOverall} baseline)
            <span style={styles.chevron}>{showNist ? '▲' : '▼'}</span>
          </button>

          {showNist && (
            <div style={styles.nistBody}>
              <div style={styles.nistNote}>
                A <strong style={{ color: LEVEL_COLOR[savedOverall!] }}>{savedOverall}</strong> impact system
                is subject to {baseline.controlCount} NIST 800-53 Rev 5 controls across {baseline.families.length} families.
                The control families most affected by your C/I/A ratings are highlighted below.
              </div>

              {/* All 20 families, CIA-highlighted ones shown in accent colour */}
              <div style={styles.famGrid}>
                {baseline.families.map((fam) => {
                  const dim = (['confidentiality', 'integrity', 'availability'] as const)
                    .find((d) => CIA_FAMILIES[d].includes(fam));
                  const dimLevel = dim ? ({ confidentiality, integrity, availability }[dim] as Level) : null;
                  return (
                    <div key={fam} style={{ ...styles.famRow, ...(dimLevel ? styles.famRowHighlighted : {}) }}>
                      <span style={{ ...styles.famCode, color: dimLevel ? LEVEL_COLOR[dimLevel] : 'var(--muted)' }}>{fam}</span>
                      <span style={styles.famName}>{FAMILY_NAMES[fam]}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
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
    gap: 12,
  },
  heading: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  title:   { fontWeight: 600, fontSize: 13, color: 'var(--text)' },
  overall: { fontSize: 12, fontWeight: 600 },
  rows:    { display: 'flex', flexDirection: 'column', gap: 8 },
  row:     { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  rowLabel:{ fontSize: 13, color: 'var(--text)' },
  select: {
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '3px 8px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    outline: 'none',
  },
  footer:      { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  footerRight: { display: 'flex', alignItems: 'center', gap: 8 },
  computed:    { fontSize: 12, color: 'var(--muted)' },
  errorMsg:    { fontSize: 11, color: 'var(--red)' },
  savedMsg:    { fontSize: 11, color: 'var(--green)' },
  saveBtn: {
    background: 'rgba(139, 87, 229, 0.15)',
    border: '1px solid rgba(139, 87, 229, 0.4)',
    color: 'var(--purple)',
    fontSize: 12,
    fontWeight: 500,
    padding: '4px 12px',
    borderRadius: 6,
    cursor: 'pointer',
  },
  nistPanel: {
    borderTop: '1px solid var(--border)',
    paddingTop: 10,
  },
  nistToggle: {
    width: '100%',
    background: 'transparent',
    border: 'none',
    color: 'var(--muted)',
    fontSize: 12,
    cursor: 'pointer',
    textAlign: 'left',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 0,
  },
  chevron: { fontSize: 10 },
  nistBody: { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 },
  nistNote: { fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 },
  famGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px 12px' },
  famRow:  { display: 'flex', gap: 6, alignItems: 'baseline', padding: '2px 4px', borderRadius: 4 },
  famRowHighlighted: { background: 'rgba(139,87,229,0.08)' },
  famCode: { fontSize: 11, fontWeight: 700, minWidth: 26 },
  famName: { fontSize: 11, color: 'var(--muted)' },
};
