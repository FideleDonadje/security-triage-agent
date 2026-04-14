import { useState, useEffect, useRef } from 'react';
import { handleCallback, getStoredToken, redirectToLogin, signOut, getEmail } from './lib/auth';
import Chat from './components/Chat';
import TaskQueue from './components/TaskQueue';
import AtoAssist from './components/AtoAssist';

type Tab = 'triage' | 'ato';

// ── Initials helper ───────────────────────────────────────────────────────────
function getInitials(email: string): string {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._\-]/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase() || '??';
}

// ── Avatar dropdown ───────────────────────────────────────────────────────────
function AvatarMenu({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const initials = getInitials(email);

  return (
    <div ref={ref} style={styles.avatarWrapper}>
      <button
        style={styles.avatar}
        onClick={() => setOpen((v) => !v)}
        title={email}
        aria-label="User menu"
      >
        {initials}
      </button>

      {open && (
        <div style={styles.dropdown}>
          <div style={styles.dropdownEmail}>{email}</div>
          <div style={styles.dropdownDivider} />
          <button
            style={styles.dropdownSignOut}
            onClick={() => { setOpen(false); signOut(); }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [ready,        setReady]        = useState(false);
  const [email,        setEmail]        = useState('');
  const [activeTab,    setActiveTab]    = useState<Tab>('triage');
  const [pendingCount, setPendingCount] = useState(0);

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
    <>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.headerTitle}>Security Triage Agent</span>
          <nav style={styles.tabBar}>
            <button
              style={{ ...styles.tab, ...(activeTab === 'triage' ? styles.tabActive : {}) }}
              onClick={() => setActiveTab('triage')}
            >
              Triage
              {pendingCount > 0 && (
                <span style={styles.pendingBadge}>{pendingCount}</span>
              )}
            </button>
            <button
              style={{ ...styles.tab, ...(activeTab === 'ato' ? styles.tabActive : {}) }}
              onClick={() => setActiveTab('ato')}
            >
              ATO Assist
            </button>
          </nav>
        </div>
        <div style={styles.headerRight}>
          <AvatarMenu email={email} />
        </div>
      </header>

      {activeTab === 'triage' ? (
        <div style={styles.panels}>
          <div style={styles.leftPanel}>
            <TaskQueue onPendingCount={setPendingCount} />
          </div>
          <div style={styles.divider} />
          <div style={styles.rightPanel}>
            <Chat />
          </div>
        </div>
      ) : (
        <div style={styles.fullPanel}>
          <AtoAssist />
        </div>
      )}
    </>
  );
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
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 20,
  },
  headerTitle: {
    fontWeight: 600,
    fontSize: 15,
    color: 'var(--text)',
  },
  tabBar: {
    display: 'flex',
    gap: 2,
  },
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
  headerRight: {
    display: 'flex',
    alignItems: 'center',
  },
  // ── Avatar ─────────────────────────────────────────────────────────────────
  avatarWrapper: {
    position: 'relative',
  },
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
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    minWidth: 200,
    zIndex: 100,
    overflow: 'hidden',
  },
  dropdownEmail: {
    padding: '10px 14px',
    fontSize: 12,
    color: 'var(--muted)',
    wordBreak: 'break-all',
  },
  dropdownDivider: {
    height: 1,
    background: 'var(--border)',
  },
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
  // ── Layout ─────────────────────────────────────────────────────────────────
  panels: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  leftPanel: {
    width: '40%',
    minWidth: 360,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  divider: {
    width: 1,
    background: 'var(--border)',
    flexShrink: 0,
  },
  rightPanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  fullPanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
};
