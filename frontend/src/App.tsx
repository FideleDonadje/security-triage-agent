import { useState, useEffect } from 'react';
import { handleCallback, getStoredToken, redirectToLogin, signOut, getEmail } from './lib/auth';
import Chat from './components/Chat';
import TaskQueue from './components/TaskQueue';
import AtoAssist from './components/AtoAssist';

type Tab = 'triage' | 'ato';

export default function App() {
  const [ready,      setReady]      = useState(false);
  const [email,      setEmail]      = useState('');
  const [activeTab,  setActiveTab]  = useState<Tab>('triage');

  useEffect(() => {
    async function init() {
      // Handle the ?code=... redirect from Cognito (PKCE exchange)
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
          <span style={styles.headerEmail}>{email}</span>
          <button onClick={signOut} style={styles.btnGhost}>Sign out</button>
        </div>
      </header>

      {activeTab === 'triage' ? (
        <div style={styles.panels}>
          <div style={styles.leftPanel}>
            <TaskQueue />
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
  },
  tabActive: {
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    fontWeight: 600,
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  headerEmail: {
    color: 'var(--muted)',
    fontSize: 13,
  },
  btnGhost: {
    background: 'transparent',
    border: '1px solid var(--border)',
    color: 'var(--muted)',
    fontSize: 12,
    padding: '4px 10px',
  },
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
