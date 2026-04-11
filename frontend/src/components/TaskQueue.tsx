import { useState, useEffect, useCallback } from 'react';
import { getTasks, approveTask, rejectTask, dismissTask } from '../lib/api';
import type { Task, TaskStatus } from '../lib/api';
import { exportPoam } from '../lib/export';

const POLL_MS = 30_000;

const ACTION_LABELS: Record<string, string> = {
  enable_s3_logging: 'Enable S3 Logging',
  tag_resource: 'Tag Resource',
};

const ACTIVITY_STATUSES: TaskStatus[] = ['EXECUTED', 'REJECTED', 'FAILED'];

// Shorten any ARN to a readable label: last non-empty path segment
function resourceLabel(resourceId: string): string {
  if (!resourceId.startsWith('arn:aws:')) return resourceId;
  // e.g. arn:aws:s3:::my-bucket → my-bucket
  //      arn:aws:cognito-idp:us-east-1:123:userpool/us-east-1_abc → userpool/us-east-1_abc
  const withoutPrefix = resourceId.replace(/^arn:aws:[^:]*:[^:]*:[^:]*:/, '');
  return withoutPrefix || resourceId;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function TaskQueue() {
  const [pending, setPending] = useState<Task[]>([]);
  const [activity, setActivity] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actioning, setActioning] = useState<Record<string, 'approving' | 'rejecting' | 'dismissing'>>({});
  const [exporting, setExporting] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [pendingRes, executedRes, rejectedRes, failedRes] = await Promise.all([
        getTasks('PENDING'),
        getTasks('EXECUTED'),
        getTasks('REJECTED'),
        getTasks('FAILED'),
      ]);
      setPending(pendingRes.tasks);
      // Merge activity lists, most recent first
      const merged = [...executedRes.tasks, ...rejectedRes.tasks, ...failedRes.tasks]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setActivity(merged);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void fetchAll();
    const timer = setInterval(() => void fetchAll(), POLL_MS);
    return () => clearInterval(timer);
  }, [fetchAll]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const [pendingRes, approvedRes, executedRes, rejectedRes, failedRes] = await Promise.all([
        getTasks('PENDING'),
        getTasks('APPROVED'),
        getTasks('EXECUTED'),
        getTasks('REJECTED'),
        getTasks('FAILED'),
      ]);
      const all = [
        ...pendingRes.tasks,
        ...approvedRes.tasks,
        ...executedRes.tasks,
        ...rejectedRes.tasks,
        ...failedRes.tasks,
      ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      exportPoam(all);
    } catch (err) {
      setError(`Export failed: ${(err as Error).message}`);
    } finally {
      setExporting(false);
    }
  };

  const handleApprove = async (taskId: string) => {
    setActioning((prev) => ({ ...prev, [taskId]: 'approving' }));
    try {
      await approveTask(taskId);
      await fetchAll();
    } catch (err) {
      setError(`Approve failed: ${(err as Error).message}`);
    } finally {
      setActioning(({ [taskId]: _, ...rest }) => rest);
    }
  };

  const handleReject = async (taskId: string) => {
    setActioning((prev) => ({ ...prev, [taskId]: 'rejecting' }));
    try {
      await rejectTask(taskId);
      await fetchAll();
    } catch (err) {
      setError(`Reject failed: ${(err as Error).message}`);
    } finally {
      setActioning(({ [taskId]: _, ...rest }) => rest);
    }
  };

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.panelHeader}>
        <span style={styles.panelTitle}>Task Queue</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => void handleExport()}
            disabled={exporting || loading}
            style={styles.exportBtn}
            title="Download all tasks as POAM Excel file"
          >
            {exporting ? 'Exporting…' : 'Export POAM'}
          </button>
          <button
            onClick={() => { setLoading(true); void fetchAll(); }}
            disabled={loading}
            style={styles.refreshBtn}
            title="Refresh"
          >
            {loading ? '...' : 'Refresh'}
          </button>
        </div>
      </div>

      <div style={styles.scroll}>
        {/* Error banner */}
        {error && (
          <div style={styles.errorBanner}>
            {error}
            <button onClick={() => setError(null)} style={styles.dismissBtn}>x</button>
          </div>
        )}

        {/* Pending section */}
        <SectionHeader
          title="Awaiting approval"
          count={pending.length}
          loading={loading}
        />

        {!loading && pending.length === 0 && (
          <div style={styles.emptyState}>No pending tasks</div>
        )}

        {pending.map((task) => (
          <PendingCard
            key={task.task_id}
            task={task}
            actionState={actioning[task.task_id]}
            onApprove={() => void handleApprove(task.task_id)}
            onReject={() => void handleReject(task.task_id)}
          />
        ))}

        {/* Activity section */}
        {activity.length > 0 && (
          <>
            <SectionHeader title="Recent activity" count={activity.length} />
            {activity.slice(0, 20).map((task) => (
              <ActivityRow
                key={task.task_id}
                task={task}
                dismissing={actioning[task.task_id] === 'dismissing'}
                onDismiss={() => {
                  setActioning((prev) => ({ ...prev, [task.task_id]: 'dismissing' }));
                  dismissTask(task.task_id)
                    .then(() => fetchAll())
                    .catch((err) => setError(`Dismiss failed: ${(err as Error).message}`))
                    .finally(() => setActioning(({ [task.task_id]: _, ...rest }) => rest));
                }}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ── Section header ─────────────────────────────────────────────────────────────

function SectionHeader({ title, count, loading }: { title: string; count: number; loading?: boolean }) {
  return (
    <div style={styles.sectionHeader}>
      <span style={styles.sectionTitle}>{title}</span>
      {!loading && (
        <span style={styles.sectionCount}>{count}</span>
      )}
    </div>
  );
}

// ── Pending task card ──────────────────────────────────────────────────────────

interface PendingCardProps {
  task: Task;
  actionState?: 'approving' | 'rejecting' | 'dismissing';
  onApprove: () => void;
  onReject: () => void;
}

function PendingCard({ task, actionState, onApprove, onReject }: PendingCardProps) {
  const isActioning = !!actionState;
  const [expanded, setExpanded] = useState(false);
  const label = resourceLabel(task.resource_id);
  const isArn = task.resource_id.startsWith('arn:aws:');

  return (
    <div style={styles.card}>
      <div style={styles.cardTop}>
        <span style={styles.actionBadge}>{ACTION_LABELS[task.action] ?? task.action}</span>
        <span style={styles.riskBadge}>Risk: Low</span>
      </div>

      <div
        style={{ ...styles.resource, ...(isArn ? { cursor: 'pointer' } : {}), ...(expanded ? { whiteSpace: 'normal' as const, overflow: 'visible' } : {}) }}
        title={expanded ? 'Click to collapse' : task.resource_id}
        onClick={() => isArn && setExpanded((v) => !v)}
      >
        {expanded ? task.resource_id : label}
        {isArn && !expanded && label !== task.resource_id && (
          <span style={styles.expandHint}> ↗</span>
        )}
      </div>

      <div style={styles.findingId}>Finding: {task.finding_id}</div>

      <div style={styles.rationale}>{task.rationale}</div>

      <div style={styles.actions}>
        <button
          onClick={onApprove}
          disabled={isActioning}
          style={styles.btnApprove}
        >
          {actionState === 'approving' ? 'Approving...' : 'Approve'}
        </button>
        <button
          onClick={onReject}
          disabled={isActioning}
          style={styles.btnReject}
        >
          {actionState === 'rejecting' ? 'Rejecting...' : 'Reject'}
        </button>
      </div>
    </div>
  );
}

// ── Activity row ───────────────────────────────────────────────────────────────

const STATUS_COLORS: Partial<Record<TaskStatus, string>> = {
  EXECUTED: 'var(--green)',
  REJECTED: 'var(--muted)',
  FAILED: 'var(--red)',
};

const DISMISSIBLE: TaskStatus[] = ['FAILED', 'REJECTED'];

function ActivityRow({ task, dismissing, onDismiss }: {
  task: Task;
  dismissing: boolean;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const color = STATUS_COLORS[task.status] ?? 'var(--muted)';
  const isFailed = task.status === 'FAILED';
  const canDismiss = DISMISSIBLE.includes(task.status);
  const label = resourceLabel(task.resource_id);
  const isArn = task.resource_id.startsWith('arn:aws:');
  return (
    <div style={{ ...styles.activityRow, flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={styles.activityLeft}>
          <span style={{ ...styles.activityStatus, color }}>{task.status}</span>
          <span style={styles.activityAction}>{ACTION_LABELS[task.action] ?? task.action}</span>
          <span
            style={{ ...styles.activityResource, ...(isArn ? { cursor: 'pointer' } : {}), whiteSpace: expanded ? 'normal' as const : 'nowrap' as const }}
            title={expanded ? 'Click to collapse' : task.resource_id}
            onClick={() => isArn && setExpanded((v) => !v)}
          >
            {expanded ? task.resource_id : label}
            {isArn && !expanded && label !== task.resource_id && (
              <span style={styles.expandHint}> ↗</span>
            )}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={styles.activityTime}>{formatRelative(task.created_at)}</span>
          {canDismiss && (
            <button
              onClick={onDismiss}
              disabled={dismissing}
              style={styles.dismissTaskBtn}
              title="Dismiss from activity list"
            >
              {dismissing ? '…' : '×'}
            </button>
          )}
        </div>
      </div>
      {isFailed && task.result && (
        <div style={styles.failureReason} title={task.result}>
          {formatFailureReason(task.result)}
        </div>
      )}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatFailureReason(result: string): string {
  // IAM denial: "...is not authorized to perform: cognito-idp:TagResource on resource:..."
  const match = result.match(/not authorized to perform:\s*(\S+)/);
  if (match) return `Permission denied: ${match[1]}`;
  return result;
}

function formatRelative(iso: string): string {
  try {
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch {
    return iso;
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--bg)',
    overflow: 'hidden',
  },
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--surface)',
    flexShrink: 0,
  },
  panelTitle: {
    fontWeight: 600,
    fontSize: 14,
  },
  exportBtn: {
    background: 'rgba(63,185,80,0.12)',
    border: '1px solid rgba(63,185,80,0.35)',
    color: 'var(--green)',
    fontSize: 12,
    fontWeight: 600,
    padding: '3px 10px',
    borderRadius: 5,
    cursor: 'pointer',
  },
  refreshBtn: {
    background: 'transparent',
    border: '1px solid var(--border)',
    color: 'var(--muted)',
    fontSize: 12,
    padding: '3px 10px',
    borderRadius: 5,
    cursor: 'pointer',
  },
  scroll: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px 12px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  errorBanner: {
    background: 'rgba(248, 81, 73, 0.1)',
    border: '1px solid rgba(248, 81, 73, 0.3)',
    borderRadius: 6,
    padding: '8px 12px',
    color: 'var(--red)',
    fontSize: 13,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  dismissBtn: {
    background: 'transparent',
    color: 'var(--muted)',
    fontSize: 14,
    padding: '0 4px',
    flexShrink: 0,
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 4px 4px',
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  },
  sectionCount: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--muted)',
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: '1px 6px',
  },
  emptyState: {
    textAlign: 'center',
    color: 'var(--muted)',
    padding: '20px 0',
    fontSize: 13,
  },
  card: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: 14,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  cardTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  actionBadge: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 7px',
    borderRadius: 20,
    background: 'rgba(139, 87, 229, 0.15)',
    color: 'var(--purple)',
    border: '1px solid rgba(139, 87, 229, 0.3)',
    letterSpacing: '0.04em',
  },
  riskBadge: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 7px',
    borderRadius: 20,
    background: 'rgba(210, 153, 34, 0.12)',
    color: 'var(--yellow)',
    border: '1px solid rgba(210, 153, 34, 0.3)',
    letterSpacing: '0.04em',
  },
  resource: {
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    wordBreak: 'break-all' as const,
  },
  expandHint: {
    fontSize: 10,
    color: 'var(--blue)',
    fontFamily: 'inherit',
  },
  findingId: {
    fontSize: 11,
    color: 'var(--muted)',
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  },
  rationale: {
    fontSize: 13,
    color: 'var(--text)',
    lineHeight: 1.5,
  },
  actions: {
    display: 'flex',
    gap: 8,
    marginTop: 4,
  },
  btnApprove: {
    background: 'rgba(63, 185, 80, 0.15)',
    color: 'var(--green)',
    border: '1px solid rgba(63, 185, 80, 0.4)',
    fontSize: 12,
    fontWeight: 600,
    padding: '5px 16px',
    borderRadius: 6,
  },
  btnReject: {
    background: 'rgba(248, 81, 73, 0.1)',
    color: 'var(--red)',
    border: '1px solid rgba(248, 81, 73, 0.3)',
    fontSize: 12,
    fontWeight: 600,
    padding: '5px 16px',
    borderRadius: 6,
  },
  activityRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '7px 10px',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    gap: 8,
  },
  activityLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
    overflow: 'hidden',
  },
  activityStatus: {
    fontSize: 11,
    fontWeight: 700,
    flexShrink: 0,
    letterSpacing: '0.03em',
  },
  activityAction: {
    fontSize: 12,
    color: 'var(--muted)',
    flexShrink: 0,
  },
  activityResource: {
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
    color: 'var(--text)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  activityTime: {
    fontSize: 11,
    color: 'var(--muted)',
    flexShrink: 0,
  },
  dismissTaskBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--muted)',
    fontSize: 16,
    lineHeight: 1,
    padding: '0 2px',
    cursor: 'pointer',
    opacity: 0.6,
  },
  failureReason: {
    fontSize: 11,
    color: 'var(--red)',
    marginTop: 4,
    paddingTop: 4,
    borderTop: '1px solid rgba(248, 81, 73, 0.2)',
    lineHeight: 1.4,
    wordBreak: 'break-word' as const,
  },
};

// Silence unused variable warning for destructured omit pattern
void (ACTIVITY_STATUSES);
