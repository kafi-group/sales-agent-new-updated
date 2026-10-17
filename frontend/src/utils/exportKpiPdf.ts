import type { DailyKpiReport, KpiCounts } from "../api/client";
import {
  addBody,
  addHeading,
  addKeyValueGrid,
  addRule,
  addTableHeader,
  addTableRow,
  createPdfContext,
  safeFilenamePart,
  savePdf,
} from "./kpiPdfLayout";

const COUNT_LABELS: { key: keyof KpiCounts; label: string }[] = [
  { key: "calls_logged", label: "Calls attempted" },
  { key: "calls_manual", label: "Manual calls (dial pad)" },
  { key: "calls_follow_up_clients", label: "Follow up clients calls" },
  { key: "companies_called", label: "Companies called" },
  { key: "outcomes_follow_up", label: "Calls picked up" },
  { key: "outcomes_interested", label: "Client interested" },
  { key: "outcomes_not_interested", label: "Not interested" },
  { key: "outcomes_not_received_call", label: "No answer" },
  { key: "call_remarks", label: "Call remarks" },
  { key: "leads_imported", label: "Leads imported" },
  { key: "table_edits", label: "Table edits" },
  { key: "email_templates_created", label: "Templates created" },
  { key: "personal_emails_sent", label: "Personal emails sent" },
  { key: "bulk_emails_sent", label: "Bulk emails sent" },
  { key: "personal_whatsapp_sent", label: "Personal WhatsApp sent" },
  { key: "bulk_whatsapp_sent", label: "Bulk WhatsApp sent" },
  { key: "inbox_replies", label: "Inbox replies" },
  { key: "brand_assistant_sessions", label: "AI Research & Update" },
];

export interface KpiPdfInput {
  report: DailyKpiReport;
  summary?: string | null;
  summarySubject?: string | null;
  scopeLabel: string;
  periodLabel: string;
}

function formatRange(report: DailyKpiReport): string {
  const start = report.date_start || report.date;
  const end = report.date_end || report.date;
  if (report.period === "day" || start === end) return start;
  return `${start} to ${end}`;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Automatic KPI only — system-tracked activity, scorecard, and work log. */
export function exportKpiReportPdf(input: KpiPdfInput): void {
  const { report, summary, summarySubject, scopeLabel, periodLabel } = input;
  const ctx = createPdfContext("portrait");
  const exportedAt = new Date().toLocaleString(undefined, { timeZone: "Asia/Karachi" });

  addHeading(ctx, "Kafi Commodities — Automatic KPI Report", 15);
  addBody(ctx, "System-tracked calls, email, WhatsApp, and table activity", {
    size: 10,
    color: [80, 80, 80],
  });
  addBody(ctx, `${periodLabel} · ${formatRange(report)}`, { bold: true, size: 11 });
  addBody(ctx, `Scope: ${scopeLabel}`);
  addBody(ctx, `Timezone: ${report.timezone || "Asia/Karachi"} · ${report.activity_count} activities`, {
    size: 9,
  });
  addBody(ctx, `Exported: ${exportedAt}`, { size: 8, color: [110, 110, 110] });
  addRule(ctx);

  addHeading(ctx, "Score card", 12);
  if (summary?.trim()) {
    if (summarySubject?.trim()) {
      addBody(ctx, summarySubject.trim(), { bold: true, size: 10 });
    }
    addBody(ctx, summary.trim(), { size: 9 });
  } else {
    addBody(ctx, "No score card for this period (no targets set yet, or an off day).", {
      size: 9,
      color: [120, 80, 40],
    });
  }
  addRule(ctx);

  addHeading(ctx, "Metric totals", 12);
  const countPairs = COUNT_LABELS.map((card) => ({
    label: card.label,
    value: report.counts[card.key] ?? 0,
  }));
  addKeyValueGrid(ctx, countPairs, 2);
  addRule(ctx);

  if (report.scope === "team" && report.per_user.length > 0) {
    addHeading(ctx, "Per user breakdown", 12);
    const cols = [
      { label: "User", width: 42 },
      { label: "Calls", width: 16 },
      { label: "Outcomes", width: 20 },
      { label: "Edits", width: 16 },
      { label: "Email", width: 16 },
      { label: "WhatsApp", width: 20 },
      { label: "Events", width: ctx.maxWidth - 42 - 16 - 20 - 16 - 16 - 20 },
    ];
    addTableHeader(ctx, cols);
    report.per_user.forEach((row, index) => {
      const name = row.user?.full_name || "Unknown";
      const outcomes =
        row.counts.outcomes_interested +
        (row.counts.outcomes_follow_up ?? 0) +
        row.counts.outcomes_not_interested +
        row.counts.outcomes_not_received_call;
      const email = (row.counts.personal_emails_sent ?? 0) + (row.counts.bulk_emails_sent ?? 0);
      const wa =
        (row.counts.personal_whatsapp_sent ?? 0) + (row.counts.bulk_whatsapp_sent ?? 0);
      addTableRow(
        ctx,
        [
          { text: name, width: cols[0].width },
          { text: String(row.counts.calls_logged), width: cols[1].width },
          { text: String(outcomes), width: cols[2].width },
          { text: String(row.counts.table_edits), width: cols[3].width },
          { text: String(email), width: cols[4].width },
          { text: String(wa), width: cols[5].width },
          { text: String(row.activity_count), width: cols[6].width },
        ],
        index,
      );
    });
    addRule(ctx);
  }

  addHeading(ctx, "Full activity log", 12);
  if (report.activities.length === 0) {
    addBody(ctx, "No tracked activity for this period.", { size: 9, color: [100, 100, 100] });
  } else {
    report.activities.forEach((item, index) => {
      addBody(ctx, `${index + 1}. ${item.title}`, { bold: true, size: 9 });
      addBody(ctx, formatWhen(item.created_at), { size: 8, color: [110, 110, 110], indent: 2 });
      if (item.summary?.trim()) {
        addBody(ctx, item.summary.trim(), { size: 8, indent: 2 });
      }
      const who = item.full_name || item.username || `User #${item.user_id}`;
      const qty = item.quantity > 1 ? ` · qty ${item.quantity}` : "";
      addBody(ctx, `${who}${qty}`, { size: 8, color: [90, 90, 90], indent: 2 });
      ctx.y += 1;
    });
  }

  const rangePart = safeFilenamePart(formatRange(report).replace(/\s+/g, ""));
  const scopePart = safeFilenamePart(scopeLabel);
  const periodPart = safeFilenamePart(periodLabel.toLowerCase());
  savePdf(ctx, `kafi-kpi-automatic-${periodPart}-${rangePart}-${scopePart}.pdf`);
}
