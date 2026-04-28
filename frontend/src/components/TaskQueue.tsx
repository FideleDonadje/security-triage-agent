import { useState, useEffect, useCallback } from 'react';
import { getTasks, approveTask, rejectTask, dismissTask } from '../lib/api';
import type { Task, TaskStatus } from '../lib/api';

const POLL_MS = 30_000;

const ACTION_LABELS: Record<string, string> = {
  enable_s3_logging: 'Enable S3 Logging',
  tag_resource: 'Tag Resource',
};

// Shorten any ARN to a readable label: last non-empty path segment
function resourceLabel(resourceId: string): string {
  if (!resourceId.startsWith('arn:aws:')) return resourceId;
  const withoutPrefix = resourceId.replace(/^arn:aws:[^:]*:[^:]*:[^:]*:/, '');
  return withoutPrefix || resourceId;
}

// Replace 12-digit AWS account IDs with ****XXXX (last 4 visible for identification)
function maskId(text: string, reveal: boolean): string {
  if (reveal) return text;
  return text.replace(/\b(\d{8})(\d{4})\b/g, '****$2');
}

// ── Filter tabs ───────────────────────────────────────────────────────────────

type FilterTab = 'all' | 'pending' | 'executed' | 'failed' | 'rejected';

const FILTER_LABELS: Record<FilterTab, string> = {
  all:      'All',
  pending:  'Pending',
  executed: 'Executed',
  failed:   'Failed',
  rejected: 'Rejected',
};

// ── Component ──────────────────────────────────────────────────────────────────

interface TaskQueueProps {
  onPendingCount?: (count: number) => void;
}

export default function TaskQueue({ onPendingCount }: TaskQueueProps) {
  const [pending,   setPending]   = useState<Task[]>([]);
  const [activity,  setActivity]  = useState<Task[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [actioning, setActioning] = useState<Record<string, 'approving' | 'rejecting' | 'dismissing'>>({});
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [showIds,   setShowIds]   = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [pendingRes, executedRes, rejectedRes, failedRes] = await Promise.all([
        getTasks('PENDING'),
        getTasks('EXECUTED'),
        getTasks('REJECTED'),
        getTasks('FAILED'),
      ]);
      const pendingTasks = pendingRes.tasks;
      setPending(pendingTasks);
      onPendingCount?.(pendingTasks.length);

      const merged = [...executedRes.tasks, ...rejectedRes.tasks, ...failedRes.tasks]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setActivity(merged);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [onPendingCount]);

  useEffect(() => {
    setLoading(true);
    void fetchAll();
    const timer = setInterval(() => void fetchAll(), POLL_MS);
    return () => clearInterval(timer);
  }, [fetchAll]);

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

  // ── Counts per tab ─────────────────────────────────────────────────────────
  const counts: Record<FilterTab, number> = {
    all:      pending.length + activity.length,
    pending:  pending.length,
    executed: activity.filter((t) => t.status === 'EXECUTED').length,
    failed:   activity.filter((t) => t.status === 'FAILED').length,
    rejected: activity.filter((t) => t.status === 'REJECTED').length,
  };

  // ── Filtered views ─────────────────────────────────────────────────────────
  const showPending  = filterTab === 'all' || filterTab === 'pending';
  const showActivity = filterTab === 'all' || filterTab === 'executed' || filterTab === 'failed' || filterTab === 'rejected';

  const visibleActivity = filterTab === 'all'
    ? activity
    : activity.filter((t) => t.status.toLowerCase() === filterTab);

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.panelHeader}>
        <span style={styles.panelTitle}>Task Queue</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => setShowIds((v) => !v)}
            style={styles.refreshBtn}
            title={showIds ? 'Mask account IDs' : 'Reveal account IDs'}
          >
            {showIds ? 'Hide IDs' : 'Show IDs'}
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

      {/* Filter tabs */}
      <div style={styles.filterBar}>
        {(Object.keys(FILTER_LABELS) as FilterTab[]).map((tab) => (
          <button
            key={tab}
            style={{ ...styles.filterTab, ...(filterTab === tab ? styles.filterTabActive : {}) }}
            onClick={() => setFilterTab(tab)}
          >
            {FILTER_LABELS[tab]}
            {!loading && counts[tab] > 0 && (
              <span style={{
                ...styles.filterCount,
                ...(tab === 'pending' && counts.pending > 0 ? styles.filterCountPending : {}),
                ...(tab === 'failed'  && counts.failed  > 0 ? styles.filterCountFailed  : {}),
              }}>
                {counts[tab]}
              </span>
            )}
          </button>
        ))}
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
        {showPending && (
          <>
            <SectionHeader title="Awaiting approval" count={pending.length} loading={loading} />
            {!loading && pending.length === 0 && (
              <div style={styles.emptyState}>No pending tasks</div>
            )}
            {pending.map((task) => (
              <PendingCard
                key={task.task_id}
                task={task}
                actionState={actioning[task.task_id]}
                showIds={showIds}
                onApprove={() => void handleApprove(task.task_id)}
                onReject={() => void handleReject(task.task_id)}
              />
            ))}
          </>
        )}

        {/* Activity section */}
        {showActivity && visibleActivity.length > 0 && (
          <>
            <SectionHeader title="Recent activity" count={visibleActivity.length} />
            {visibleActivity.slice(0, 20).map((task) => (
              <ActivityRow
                key={task.task_id}
                task={task}
                showIds={showIds}
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

        {/* Empty state when filtered */}
        {!loading && filterTab !== 'all' && counts[filterTab] === 0 && (
          <div style={styles.emptyState}>No {FILTER_LABELS[filterTab].toLowerCase()} tasks</div>
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
  showIds: boolean;
  onApprove: () => void;
  onReject: () => void;
}

function PendingCard({ task, actionState, showIds, onApprove, onReject }: PendingCardProps) {
  const isActioning = !!actionState;
  const [expanded, setExpanded] = useState(false);
  const label = maskId(resourceLabel(task.resource_id), showIds);
  const fullId = maskId(task.resource_id, showIds);
  const isArn = task.resource_id.startsWith('arn:aws:');

  return (
    <div style={styles.card}>
      <div style={styles.cardTop}>
        <span style={styles.actionBadge}>{ACTION_LABELS[task.action] ?? task.action}</span>
        <span style={styles.riskBadge}>Risk: Low</span>
      </div>

      <div
        style={{ ...styles.resource, ...(isArn ? { cursor: 'pointer' } : {}), ...(expanded ? { whiteSpace: 'normal' as const, overflow: 'visible' } : {}) }}
        title={expanded ? 'Click to collapse' : fullId}
        onClick={() => isArn && setExpanded((v) => !v)}
      >
        {expanded ? fullId : label}
        {isArn && !expanded && label !== fullId && (
          <span style={styles.expandHint}> ↗</span>
        )}
      </div>

      <div style={styles.findingId}>Finding: {task.finding_id}</div>
      <div style={styles.rationale}>{maskId(task.rationale, showIds)}</div>

      <div style={styles.actions}>
        <button onClick={onApprove} disabled={isActioning} style={styles.btnApprove}>
          {actionState === 'approving' ? 'Approving...' : 'Approve'}
        </button>
        <button onClick={onReject} disabled={isActioning} style={styles.btnReject}>
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
  FAILED:   'var(--red)',
};

const DISMISSIBLE: TaskStatus[] = ['FAILED', 'REJECTED'];

function ActivityRow({ task, showIds, dismissing, onDismiss }: {
  task: Task;
  showIds: boolean;
  dismissing: boolean;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const color = STATUS_COLORS[task.status] ?? 'var(--muted)';
  const isFailed = task.status === 'FAILED';
  const canDismiss = DISMISSIBLE.includes(task.status);
  const label = maskId(resourceLabel(task.resource_id), showIds);
  const fullId = maskId(task.resource_id, showIds);
  const isArn = task.resource_id.startsWith('arn:aws:');

  return (
    <div style={{ ...styles.activityRow, flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={styles.activityLeft}>
          <span style={{ ...styles.activityStatus, color }}>{task.status}</span>
          <span style={styles.activityAction}>{ACTION_LABELS[task.action] ?? task.action}</span>
          <span
            style={{ ...styles.activityResource, ...(isArn ? { cursor: 'pointer' } : {}), whiteSpace: expanded ? 'normal' as const : 'nowrap' as const }}
            title={expanded ? 'Click to collapse' : fullId}
            onClick={() => isArn && setExpanded((v) => !v)}
          >
            {expanded ? fullId : label}
            {isArn && !expanded && label !== fullId && (
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
  refreshBtn: {
    background: 'transparent',
    border: '1px solid var(--border)',
    color: 'var(--muted)',
    fontSize: 12,
    padding: '3px 10px',
    borderRadius: 5,
    cursor: 'pointer',
  },
  // ── Filter tabs ─────────────────────────────────────────────────────────────
  filterBar: {
    display: 'flex',
    gap: 0,
    padding: '8px 12px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--surface)',
    flexShrink: 0,
    overflowX: 'auto',
  },
  filterTab: {
    background: 'transparent',
    border: '1px solid transparent',
    color: 'var(--muted)',
    fontSize: 12,
    fontWeight: 500,
    padding: '4px 10px',
    borderRadius: 5,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  },
  filterTabActive: {
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    fontWeight: 600,
  },
  filterCount: {
    fontSize: 10,
    fontWeight: 700,
    borderRadius: 10,
    padding: '1px 5px',
    background: 'var(--surface2)',
    color: 'var(--muted)',
    border: '1px solid var(--border)',
    lineHeight: 1.4,
  },
  filterCountPending: {
    background: 'rgba(210, 153, 34, 0.15)',
    color: 'var(--yellow)',
    border: '1px solid rgba(210, 153, 34, 0.3)',
  },
  filterCountFailed: {
    background: 'rgba(248, 81, 73, 0.1)',
    color: 'var(--red)',
    border: '1px solid rgba(248, 81, 73, 0.3)',
  },
  // ── Scroll area ──────────────────────────────────────────────────────────────
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
