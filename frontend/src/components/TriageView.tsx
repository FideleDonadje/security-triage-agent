import { useState } from 'react';
import TaskQueue from './TaskQueue';
import AgentDrawer from './AgentDrawer';

export default function TriageView() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  return (
    <div style={styles.root}>
      <div style={styles.toolbar}>
        <span style={styles.title}>
          Task Queue
          {pendingCount > 0 && <span style={styles.badge}>{pendingCount}</span>}
        </span>
        <button
          style={{ ...styles.agentBtn, ...(drawerOpen ? styles.agentBtnActive : {}) }}
          onClick={() => setDrawerOpen((v) => !v)}
          title="Toggle agent chat"
        >
          Agent
        </button>
      </div>

      <div style={styles.body}>
        <div style={styles.queue}>
          <TaskQueue onPendingCount={setPendingCount} />
        </div>
        <AgentDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  toolbar: {
    height: 44,
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 20px',
    flexShrink: 0,
    background: 'var(--surface)',
  },
  title: {
    fontWeight: 600,
    fontSize: 13,
    color: 'var(--text)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  badge: {
    background: 'var(--red)',
    color: '#fff',
    fontSize: 10,
    fontWeight: 700,
    borderRadius: 10,
    padding: '1px 5px',
    lineHeight: 1.4,
  },
  agentBtn: {
    background: 'transparent',
    border: '1px solid var(--border)',
    color: 'var(--muted)',
    fontSize: 12,
    fontWeight: 500,
    padding: '4px 12px',
    borderRadius: 6,
    cursor: 'pointer',
  },
  agentBtnActive: {
    background: 'rgba(139, 87, 229, 0.15)',
    border: '1px solid rgba(139, 87, 229, 0.4)',
    color: 'var(--purple)',
  },
  body: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  },
  queue: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
};
