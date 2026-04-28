import { useCallback, useEffect, useRef, useState } from 'react';
import Chat from './Chat';

interface Props {
  open: boolean;
  onClose: () => void;
  systemId?: string;
}

const MIN_WIDTH = 320;
const MAX_WIDTH = 800;
const DEFAULT_WIDTH = 420;

export default function AgentDrawer({ open, onClose, systemId: _systemId }: Props) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(DEFAULT_WIDTH);

  const onMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return;
    const delta = startX.current - e.clientX;
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta)));
  }, []);

  const onMouseUp = useCallback(() => { dragging.current = false; }, []);

  useEffect(() => {
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  if (!open) return null;

  return (
    <div style={{ ...styles.drawer, width }} role="complementary" aria-label="Agent chat">
      {/* Resize handle */}
      <div
        style={styles.resizeHandle}
        onMouseDown={(e) => {
          dragging.current = true;
          startX.current = e.clientX;
          startWidth.current = width;
          e.preventDefault();
        }}
        title="Drag to resize"
      />

      <div style={styles.header}>
        <span style={styles.title}>Agent</span>
        <button style={styles.closeBtn} onClick={onClose} aria-label="Close agent drawer">✕</button>
      </div>

      <div style={styles.body}>
        <Chat />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  drawer: {
    display: 'flex',
    flexDirection: 'column',
    borderLeft: '1px solid var(--border)',
    background: 'var(--surface)',
    flexShrink: 0,
    position: 'relative',
    overflow: 'hidden',
  },
  resizeHandle: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
    cursor: 'ew-resize',
    zIndex: 10,
    background: 'transparent',
  },
  header: {
    height: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 16px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  title: {
    fontWeight: 600,
    fontSize: 13,
    color: 'var(--text)',
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--muted)',
    fontSize: 14,
    cursor: 'pointer',
    padding: 4,
    lineHeight: 1,
  },
  body: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
};
