import { jsPDF } from "jspdf";
import type { DailyKpiReport, KpiCounts } from "../api/client";

const COUNT_LABELS: { key: keyof KpiCounts; label: string }[] = [
  { key: "calls_logged", label: "Calls attempted" },
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

function safeFilenamePart(value: string): string {
  return value.replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").slice(0, 80);
}

/**
 * Build and download a PDF of the KPI report: header, AI/rules summary (if any),
 * count cards, per-user table (team), and full activity list.
 */
export function exportKpiReportPdf(input: KpiPdfInput): void {
  const { report, summary, summarySubject, scopeLabel, periodLabel } = input;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 14;
  const maxWidth = pageWidth - margin * 2;
  let y = margin;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  };

  const addHeading = (text: string, size = 14) => {
    ensureSpace(10);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(size);
    doc.setTextColor(20, 20, 20);
    doc.text(text, margin, y);
    y += size * 0.45 + 2;
  };

  const addBody = (text: string, opts?: { bold?: boolean; size?: number; color?: [number, number, number] }) => {
    const size = opts?.size ?? 10;
    const lines = doc.splitTextToSize(text, maxWidth) as string[];
    ensureSpace(lines.length * (size * 0.4) + 2);
    doc.setFont("helvetica", opts?.bold ? "bold" : "normal");
    doc.setFontSize(size);
    if (opts?.color) doc.setTextColor(...opts.color);
    else doc.setTextColor(40, 40, 40);
    doc.text(lines, margin, y);
    y += lines.length * (size * 0.4) + 2;
  };

  const addRule = () => {
    ensureSpace(4);
    doc.setDrawColor(180, 180, 180);
    doc.setLineWidth(0.2);
    doc.line(margin, y, pageWidth - margin, y);
    y += 5;
  };

  // Header
  addHeading("Kafi Commodities — KPI Report", 16);
  addBody(`${periodLabel} activity · ${formatRange(report)}`, { bold: true, size: 11 });
  addBody(`Scope: ${scopeLabel}`);
  addBody(`Timezone: ${report.timezone || "Asia/Karachi"}`);
  addBody(`Activities tracked: ${report.activity_count}`);
  addBody(`Exported: ${new Date().toLocaleString(undefined, { timeZone: "Asia/Karachi" })}`, {
    size: 8,
    color: [100, 100, 100],
  });
  addRule();

  // Summary
  if (summary?.trim()) {
    addHeading("Score card", 13);
    if (summarySubject?.trim()) {
      addBody(summarySubject.trim(), { bold: true, size: 11 });
    }
    addBody(summary.trim(), { size: 9 });
    addRule();
  } else {
    addHeading("Score card", 13);
    addBody("No score card for this period (no targets set yet, or an off day).", {
      size: 9,
      color: [120, 80, 40],
    });
    addRule();
  }

  // Counts
  addHeading("Totals", 13);
  for (const card of COUNT_LABELS) {
    addBody(`${card.label}: ${report.counts[card.key]}`, { size: 9 });
  }
  addRule();

  // Per user (team)
  if (report.scope === "team" && report.per_user.length > 0) {
    addHeading("Per user", 13);
    for (const row of report.per_user) {
      const name = row.user?.full_name || "Unknown";
      const outcomes =
        row.counts.outcomes_interested +
        (row.counts.outcomes_follow_up ?? 0) +
        row.counts.outcomes_not_interested +
        row.counts.outcomes_not_received_call;
      addBody(
        `${name} — calls ${row.counts.calls_logged}, outcomes ${outcomes}, edits ${row.counts.table_edits}, email ${(row.counts.personal_emails_sent ?? 0) + (row.counts.bulk_emails_sent ?? 0)}, WhatsApp ${(row.counts.personal_whatsapp_sent ?? 0) + (row.counts.bulk_whatsapp_sent ?? 0)}, events ${row.activity_count}`,
        { size: 9 },
      );
    }
    addRule();
  }

  // Full activity
  addHeading("Full activity", 13);
  if (report.activities.length === 0) {
    addBody("No tracked activity for this period.", { size: 9, color: [100, 100, 100] });
  } else {
    report.activities.forEach((item, index) => {
      ensureSpace(18);
      addBody(`${index + 1}. ${item.title}`, { bold: true, size: 9 });
      addBody(formatWhen(item.created_at), { size: 8, color: [110, 110, 110] });
      if (item.summary?.trim()) {
        addBody(item.summary.trim(), { size: 8 });
      }
      const who = item.full_name || item.username || `User #${item.user_id}`;
      const qty = item.quantity > 1 ? ` · qty ${item.quantity}` : "";
      addBody(`${who}${qty}`, { size: 8, color: [90, 90, 90] });
      y += 1;
    });
  }

  const rangePart = safeFilenamePart(formatRange(report).replace(/\s+/g, ""));
  const scopePart = safeFilenamePart(scopeLabel);
  const periodPart = safeFilenamePart(periodLabel.toLowerCase());
  doc.save(`kafi-kpi-${periodPart}-${rangePart}-${scopePart}.pdf`);
}
