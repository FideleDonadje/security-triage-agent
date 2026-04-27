import { useState } from 'react';
import { NavLink, Outlet, useParams } from 'react-router-dom';
import AgentDrawer from './AgentDrawer';
import RmfView from './RmfView';

export function DocumentsView() {
  const { systemId = 'default' } = useParams<{ systemId: string }>();
  return <RmfView systemId={systemId} />;
}

export default function ComplianceWorkspace() {
  const { systemId = 'default' } = useParams<{ systemId: string }>();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div style={styles.root}>
      <nav style={styles.sidebar}>
        <div style={styles.sidebarSection}>Compliance</div>
        <NavLink to={`/systems/${systemId}/documents`} style={navStyle} end>RMF Workspace</NavLink>
        <NavLink to={`/systems/${systemId}/ato`}       style={navStyle}>ATO Assist</NavLink>
        <NavLink to={`/systems/${systemId}/settings`}  style={navStyle}>Settings</NavLink>

        <div style={styles.sidebarSpacer} />
        <button
          style={{ ...styles.agentBtn, ...(drawerOpen ? styles.agentBtnActive : {}) }}
          onClick={() => setDrawerOpen((v) => !v)}
        >
          Agent
        </button>
      </nav>

      <div style={styles.main}>
        <div style={styles.content}>
          <Outlet />
        </div>
        <AgentDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} systemId={systemId} />
      </div>
    </div>
  );
}

function navStyle({ isActive }: { isActive: boolean }): React.CSSProperties {
  return {
    display: 'block',
    padding: '7px 12px',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: isActive ? 600 : 400,
    color: isActive ? 'var(--text)' : 'var(--muted)',
    background: isActive ? 'var(--surface2)' : 'transparent',
    textDecoration: 'none',
    cursor: 'pointer',
  };
}

const styles: Record<string, React.CSSProperties> = {
  root:    { flex: 1, display: 'flex', overflow: 'hidden' },
  sidebar: {
    width: 180, borderRight: '1px solid var(--border)',
    background: 'var(--surface)', display: 'flex', flexDirection: 'column',
    padding: '16px 10px', gap: 2, flexShrink: 0,
  },
  sidebarSection: {
    fontSize: 11, fontWeight: 700, color: 'var(--muted)',
    textTransform: 'uppercase', letterSpacing: '0.08em', padding: '0 4px 10px',
  },
  sidebarSpacer: { flex: 1 },
  agentBtn: {
    background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)',
    fontSize: 12, fontWeight: 500, padding: '6px 10px', borderRadius: 6,
    cursor: 'pointer', textAlign: 'center',
  },
  agentBtnActive: {
    background: 'rgba(139, 87, 229, 0.15)',
    border: '1px solid rgba(139, 87, 229, 0.4)',
    color: 'var(--purple)',
  },
  main:    { flex: 1, display: 'flex', overflow: 'hidden' },
  content: { flex: 1, overflow: 'auto', padding: '24px 32px' },
};
