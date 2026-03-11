import { useState, useEffect } from 'react';
import { handleCallback, getStoredToken, redirectToLogin, signOut, getEmail } from './lib/auth';
import Chat from './components/Chat';
import TaskQueue from './components/TaskQueue';

export default function App() {
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState('');

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
        <span style={styles.headerTitle}>Security Triage Agent</span>
        <div style={styles.headerRight}>
          <span style={styles.headerEmail}>{email}</span>
          <button onClick={signOut} style={styles.btnGhost}>Sign out</button>
        </div>
      </header>

      <div style={styles.panels}>
        <div style={styles.leftPanel}>
          <TaskQueue />
        </div>
        <div style={styles.divider} />
        <div style={styles.rightPanel}>
          <Chat />
        </div>
      </div>
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
  headerTitle: {
    fontWeight: 600,
    fontSize: 15,
    color: 'var(--text)',
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
};
