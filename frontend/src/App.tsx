import { useEffect, useRef, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { getEmail, getStoredToken, handleCallback, redirectToLogin, signOut } from './lib/auth';
import AtoAssist from './components/AtoAssist';
import ComplianceWorkspace, { DocumentsView } from './components/ComplianceWorkspace';
import SettingsView from './components/SettingsView';
import TriageView from './components/TriageView';

// ── Initials helper ───────────────────────────────────────────────────────────
function getInitials(email: string): string {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._\-]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase() || '??';
}

// ── Avatar dropdown ───────────────────────────────────────────────────────────
function AvatarMenu({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} style={styles.avatarWrapper}>
      <button style={styles.avatar} onClick={() => setOpen((v) => !v)} title={email} aria-label="User menu">
        {getInitials(email)}
      </button>
      {open && (
        <div style={styles.dropdown}>
          <div style={styles.dropdownEmail}>{email}</div>
          <div style={styles.dropdownDivider} />
          <button style={styles.dropdownSignOut} onClick={() => { setOpen(false); signOut(); }}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

// ── Nav tab helper ────────────────────────────────────────────────────────────
function NavTab({ to, children, badge }: { to: string; children: React.ReactNode; badge?: number }) {
  return (
    <NavLink
      to={to}
      style={({ isActive }) => ({
        ...styles.tab,
        ...(isActive ? styles.tabActive : {}),
      })}
    >
      {children}
      {badge != null && badge > 0 && <span style={styles.pendingBadge}>{badge}</span>}
    </NavLink>
  );
}

// ── Theme toggle ──────────────────────────────────────────────────────────────
function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState<string>(() => localStorage.getItem('theme') ?? 'dark');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  return [theme, toggle];
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState('');
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    async function init() {
      const handled = await handleCallback();
      if (handled || getStoredToken()) {
        setEmail(getEmail() ?? '');
        setReady(true);
      } else {
        await redirectToLogin();
      }
    }
    void init();
  }, []);

  if (!ready) {
    return <div style={styles.loading}>Loading...</div>;
  }

  return (
    <BrowserRouter>
      <div style={styles.shell}>
        <header style={styles.header}>
          <div style={styles.headerLeft}>
            <span style={styles.headerTitle}>Security Triage Agent</span>
            <nav style={styles.tabBar}>
              <NavTab to="/triage">Triage</NavTab>
              <NavTab to="/systems/default/documents">Compliance</NavTab>
            </nav>
          </div>
          <div style={styles.headerRight}>
            <button
              style={styles.themeBtn}
              onClick={toggleTheme}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
            <AvatarMenu email={email} />
          </div>
        </header>

        <main style={styles.main}>
          <Routes>
            <Route index element={<Navigate to="/triage" replace />} />
            <Route path="/triage" element={<TriageView />} />
            <Route path="/systems/:systemId" element={<ComplianceWorkspace />}>
              <Route index element={<Navigate to="documents" replace />} />
              <Route path="documents" element={<DocumentsView />} />
              <Route path="ato"       element={<div style={styles.fullPanel}><AtoAssist /></div>} />
              <Route path="settings"  element={<SettingsViewWrapper />} />
            </Route>

            <Route path="*" element={<Navigate to="/triage" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

function SettingsViewWrapper() {
  const { systemId = 'default' } = useParams<{ systemId: string }>();
  return <SettingsView systemId={systemId} />;
}

const styles: Record<string, React.CSSProperties> = {
  loading: {
    height: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--muted)',
    fontSize: 13,
    background: 'var(--bg)',
  },
  shell: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: 'var(--bg)',
  },
  header: {
    height: 48,
    minHeight: 48,
    background: 'var(--surface)',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 20px',
    flexShrink: 0,
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 20 },
  headerTitle: { fontWeight: 600, fontSize: 15, color: 'var(--text)' },
  tabBar: { display: 'flex', gap: 2 },
  tab: {
    background: 'transparent',
    border: '1px solid transparent',
    color: 'var(--muted)',
    fontSize: 12,
    fontWeight: 500,
    padding: '4px 12px',
    borderRadius: 6,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    textDecoration: 'none',
  },
  tabActive: {
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    fontWeight: 600,
  },
  pendingBadge: {
    background: 'var(--red)',
    color: '#fff',
    fontSize: 10,
    fontWeight: 700,
    borderRadius: 10,
    padding: '1px 5px',
    lineHeight: 1.4,
  },
  headerRight: { display: 'flex', alignItems: 'center', gap: 8 },
  themeBtn: {
    background: 'transparent',
    border: '1px solid var(--border)',
    color: 'var(--muted)',
    fontSize: 11,
    fontWeight: 600,
    height: 28,
    borderRadius: 6,
    padding: '0 10px',
    cursor: 'pointer',
    letterSpacing: '0.04em',
  },
  avatarWrapper: { position: 'relative' },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    background: 'rgba(139, 87, 229, 0.2)',
    border: '1px solid rgba(139, 87, 229, 0.4)',
    color: 'var(--purple)',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    letterSpacing: '0.03em',
    userSelect: 'none',
  },
  dropdown: {
    position: 'absolute',
    top: 38,
    right: 0,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    boxShadow: '0 4px 16px var(--shadow)',
    minWidth: 200,
    zIndex: 100,
    overflow: 'hidden',
  },
  dropdownEmail: { padding: '10px 14px', fontSize: 12, color: 'var(--muted)', wordBreak: 'break-all' },
  dropdownDivider: { height: 1, background: 'var(--border)' },
  dropdownSignOut: {
    width: '100%',
    textAlign: 'left',
    padding: '10px 14px',
    background: 'transparent',
    border: 'none',
    color: 'var(--text)',
    fontSize: 13,
    cursor: 'pointer',
  },
  main: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  },
  fullPanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
};
