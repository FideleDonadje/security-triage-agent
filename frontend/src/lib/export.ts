/**
 * export.ts — POAM Excel export using SheetJS
 *
 * Generates a two-sheet workbook:
 *   Sheet 1 "Summary"  — counts by status + generated date
 *   Sheet 2 "POAM"     — one row per task, color-coded by status
 */
import * as XLSX from 'xlsx';
import type { Task } from './api';

// ── Completion deadline logic ─────────────────────────────────────────────────

function scheduledCompletion(task: Task): string {
  const daysMap: Record<number, number> = { 1: 90, 2: 180, 3: 365 };
  const days = daysMap[task.risk_tier] ?? 180;
  const base = task.created_at ? new Date(task.created_at) : new Date();
  base.setDate(base.getDate() + days);
  return base.toISOString().slice(0, 10);
}

// ── Row fill colors (ARGB) ────────────────────────────────────────────────────

const STATUS_FILL: Record<string, string> = {
  EXECUTED: 'FFD6F5D6', // light green
  FAILED:   'FFFFD6D6', // light red
  PENDING:  'FFFFF9D6', // light yellow
  APPROVED: 'FFD6ECFF', // light blue
  REJECTED: 'FFF0F0F0', // light grey
};

// ── Main export function ──────────────────────────────────────────────────────

export function exportPoam(tasks: Task[]): void {
  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Summary ────────────────────────────────────────────────────────
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;

  const summaryRows: (string | number)[][] = [
    ['Security Triage Agent — POA&M Export'],
    ['Generated', new Date().toLocaleString()],
    ['Total Tasks', tasks.length],
    [],
    ['Status', 'Count'],
    ...Object.entries(counts).map(([status, count]) => [status, count]),
  ];

  const ws1 = XLSX.utils.aoa_to_sheet(summaryRows);
  ws1['!cols'] = [{ wch: 30 }, { wch: 20 }];

  // Bold the title and header rows
  if (ws1['A1']) ws1['A1'].s = { font: { bold: true, sz: 14 } };
  if (ws1['A5']) ws1['A5'].s = { font: { bold: true } };
  if (ws1['B5']) ws1['B5'].s = { font: { bold: true } };

  XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

  // ── Sheet 2: POAM ────────────────────────────────────────────────────────────
  const headers = [
    'POA&M ID',
    'Finding ID',
    'Weakness / Issue',
    'Affected Resource',
    'Planned Action',
    'Risk Level',
    'Status',
    'Detection Date',
    'Scheduled Completion',
    'Approved By',
    'Completion Date',
    'Notes',
  ];

  const rows = tasks.map((t) => [
    t.task_id,
    t.finding_id,
    t.rationale,
    t.resource_id,
    t.action === 'enable_s3_logging' ? 'Enable S3 access logging' : 'Apply required resource tags',
    riskLabel(t.risk_tier),
    t.status,
    t.created_at ? t.created_at.slice(0, 10) : '',
    scheduledCompletion(t),
    t.approved_by ?? '',
    t.executed_at ? t.executed_at.slice(0, 10) : '',
    t.result ?? '',
  ]);

  const ws2 = XLSX.utils.aoa_to_sheet([headers, ...rows]);

  // Column widths
  ws2['!cols'] = [
    { wch: 38 }, // POA&M ID
    { wch: 22 }, // Finding ID
    { wch: 55 }, // Weakness
    { wch: 60 }, // Resource
    { wch: 30 }, // Planned Action
    { wch: 12 }, // Risk
    { wch: 12 }, // Status
    { wch: 14 }, // Detection Date
    { wch: 20 }, // Scheduled Completion
    { wch: 28 }, // Approved By
    { wch: 16 }, // Completion Date
    { wch: 40 }, // Notes
  ];

  // Freeze + bold header row
  ws2['!freeze'] = { xSplit: 0, ySplit: 1 };
  for (let col = 0; col < headers.length; col++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c: col });
    if (ws2[addr]) {
      ws2[addr].s = {
        font: { bold: true, color: { rgb: 'FFFFFFFF' } },
        fill: { fgColor: { rgb: 'FF1F2937' } },
        alignment: { wrapText: true },
      };
    }
  }

  // Color-code data rows by status
  rows.forEach((row, rowIdx) => {
    const status = row[6] as string;
    const fill = STATUS_FILL[status];
    if (!fill) return;
    for (let col = 0; col < headers.length; col++) {
      const addr = XLSX.utils.encode_cell({ r: rowIdx + 1, c: col });
      if (!ws2[addr]) ws2[addr] = { t: 's', v: '' };
      ws2[addr].s = { fill: { fgColor: { rgb: fill } }, alignment: { wrapText: true } };
    }
  });

  XLSX.utils.book_append_sheet(wb, ws2, 'POAM');

  // ── Download ─────────────────────────────────────────────────────────────────
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  XLSX.writeFile(wb, `POAM_${date}.xlsx`, { bookSST: false, cellStyles: true });
}

function riskLabel(tier: number): string {
  return tier === 1 ? 'High' : tier === 2 ? 'Medium' : 'Low';
}
