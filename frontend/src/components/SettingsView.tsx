import { useEffect, useState } from 'react';
import type { SystemMetadata } from '../lib/compliance-api';
import { getSystem, updateSettings } from '../lib/compliance-api';

interface Props {
  systemId: string;
}

type SettingsFields = Pick<SystemMetadata, 'systemName' | 'ownerName' | 'ownerEmail' | 'awsAccountId' | 'region'>;

const FIELD_LABELS: Record<keyof SettingsFields, string> = {
  systemName:   'System Name',
  ownerName:    'Owner Name',
  ownerEmail:   'Owner Email',
  awsAccountId: 'AWS Account ID',
  region:       'AWS Region',
};

export default function SettingsView({ systemId }: Props) {
  const [fields,  setFields]  = useState<SettingsFields>({ systemName: '', ownerName: '', ownerEmail: '', awsAccountId: '', region: '' });
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [error,   setError]   = useState('');

  useEffect(() => {
    setLoading(true);
    getSystem(systemId)
      .then((sys) => {
        setFields({
          systemName:   sys.systemName   ?? '',
          ownerName:    sys.ownerName    ?? '',
          ownerEmail:   sys.ownerEmail   ?? '',
          awsAccountId: sys.awsAccountId ?? '',
          region:       sys.region       ?? '',
        });
      })
      .catch((e: unknown) => setError((e as Error).message ?? 'Failed to load'))
      .finally(() => setLoading(false));
  }, [systemId]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      await updateSettings(systemId, fields);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={styles.loading}>Loading…</div>;

  return (
    <div style={styles.root}>
      <h2 style={styles.heading}>System Settings</h2>

      <form style={styles.form} onSubmit={(e) => { void handleSave(e); }}>
        {(Object.keys(FIELD_LABELS) as (keyof SettingsFields)[]).map((key) => (
          <div key={key} style={styles.field}>
            <label style={styles.label} htmlFor={key}>{FIELD_LABELS[key]}</label>
            <input
              id={key}
              style={styles.input}
              type={key === 'ownerEmail' ? 'email' : 'text'}
              value={fields[key]}
              onChange={(e) => setFields((prev) => ({ ...prev, [key]: e.target.value }))}
            />
          </div>
        ))}

        {error && <div style={styles.errorMsg}>{error}</div>}

        <div style={styles.footer}>
          {saved && <span style={styles.savedMsg}>Saved</span>}
          <button style={{ ...styles.saveBtn, opacity: saving ? 0.5 : 1 }} type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    padding: '32px 40px',
    maxWidth: 520,
  },
  heading: {
    fontSize: 18,
    fontWeight: 700,
    color: 'var(--text)',
    margin: '0 0 24px',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  label: {
    fontSize: 12,
    color: 'var(--muted)',
    fontWeight: 500,
  },
  input: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '7px 10px',
    fontSize: 13,
    color: 'var(--text)',
    outline: 'none',
  },
  errorMsg: {
    fontSize: 12,
    color: 'var(--red)',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 8,
  },
  savedMsg: {
    fontSize: 12,
    color: 'var(--green)',
  },
  saveBtn: {
    background: 'rgba(139, 87, 229, 0.15)',
    border: '1px solid rgba(139, 87, 229, 0.4)',
    color: 'var(--purple)',
    fontSize: 13,
    fontWeight: 600,
    padding: '7px 20px',
    borderRadius: 6,
    cursor: 'pointer',
  },
  loading: {
    padding: 40,
    color: 'var(--muted)',
    fontSize: 13,
  },
};
