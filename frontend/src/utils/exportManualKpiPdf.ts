import type { ManualKpiEntry } from "../api/client";
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

export interface ManualKpiSummaryMetrics {
  waChat: number;
  waCalls: number;
  phoneCalls: number;
  callsAttended: number;
  callsConvertWa: number;
  inquiries: number;
  buyersFollowups: number;
  countriesList: string;
  waStatus: string;
  bulkEmail: string;
}

export interface ManualKpiPdfInput {
  rows: ManualKpiEntry[];
  total: number;
  summary: ManualKpiSummaryMetrics;
  periodLabel: string;
  rangeLabel: string;
  scopeLabel: string;
  timezone?: string;
  includeUserColumn: boolean;
}

export function manualKpiPeriodLabel(period: string): string {
  switch (period) {
    case "week":
      return "Weekly";
    case "month":
      return "Monthly";
    case "year":
      return "Yearly";
    case "custom":
      return "Custom range";
    default:
      return "Daily";
  }
}

/** Export manual KPI log (spreadsheet-style) as a landscape PDF. */
export function exportManualKpiReportPdf(input: ManualKpiPdfInput): void {
  const ctx = createPdfContext("landscape");
  const exportedAt = new Date().toLocaleString(undefined, { timeZone: "Asia/Karachi" });

  addHeading(ctx, "Kafi Commodities — Manual KPI Log", 15);
  addBody(ctx, "Off-system activity (Usman & Asim daily spreadsheet)", { size: 10, color: [80, 80, 80] });
  addBody(ctx, `${input.periodLabel} · ${input.rangeLabel}`, { bold: true, size: 11 });
  addBody(ctx, `Scope: ${input.scopeLabel}`);
  addBody(ctx, `Timezone: ${input.timezone || "Asia/Karachi"} · ${input.total} row(s) exported`, {
    size: 9,
  });
  addBody(ctx, `Exported: ${exportedAt}`, { size: 8, color: [110, 110, 110] });
  addRule(ctx);

  addHeading(ctx, "Summary bar (Excel metrics)", 12);
  addKeyValueGrid(ctx, [
    { label: "WA Chat", value: input.summary.waChat },
    { label: "WA Calls", value: input.summary.waCalls },
    { label: "Phone Calls", value: input.summary.phoneCalls },
    { label: "Calls Attended", value: input.summary.callsAttended },
    { label: "Calls → WA", value: input.summary.callsConvertWa },
    { label: "Inquiries", value: input.summary.inquiries },
    { label: "Buyers Follow-ups", value: input.summary.buyersFollowups },
    { label: "WA Status", value: input.summary.waStatus },
    { label: "Bulk Email", value: input.summary.bulkEmail },
    { label: "Countries", value: input.summary.countriesList },
  ], 3);
  addRule(ctx);

  addHeading(ctx, "Log entries", 12);
  if (input.rows.length === 0) {
    addBody(ctx, "No manual KPI rows for this period.", { size: 9, color: [120, 120, 120] });
  } else {
    const cols = input.includeUserColumn
      ? [
          { label: "User", width: 28 },
          { label: "Date", width: 22 },
          { label: "Person", width: 32 },
          { label: "Company", width: 40 },
          { label: "Country", width: 22 },
          { label: "Contact", width: 22 },
          { label: "Follow-up", width: 22 },
          { label: "WeChat", width: 16 },
          { label: "Remarks", width: ctx.maxWidth - 28 - 22 - 32 - 40 - 22 - 22 - 22 - 16 },
        ]
      : [
          { label: "Date", width: 24 },
          { label: "Person", width: 34 },
          { label: "Company", width: 44 },
          { label: "Country", width: 24 },
          { label: "Contact", width: 24 },
          { label: "Follow-up", width: 24 },
          { label: "WeChat", width: 18 },
          { label: "Remarks", width: ctx.maxWidth - 24 - 34 - 44 - 24 - 24 - 24 - 18 },
        ];

    addTableHeader(ctx, cols);
    input.rows.forEach((row, index) => {
      const user = row.full_name || row.username || `#${row.user_id}`;
      const cells = input.includeUserColumn
        ? [
            { text: user, width: cols[0].width },
            { text: row.activity_date, width: cols[1].width },
            { text: row.person_name || "", width: cols[2].width },
            { text: row.company || "", width: cols[3].width },
            { text: row.country || "", width: cols[4].width },
            { text: row.contact_type || "", width: cols[5].width },
            { text: row.follow_up_type || "", width: cols[6].width },
            { text: row.wechat_contacts || "", width: cols[7].width },
            { text: row.remarks || "", width: cols[8].width },
          ]
        : [
            { text: row.activity_date, width: cols[0].width },
            { text: row.person_name || "", width: cols[1].width },
            { text: row.company || "", width: cols[2].width },
            { text: row.country || "", width: cols[3].width },
            { text: row.contact_type || "", width: cols[4].width },
            { text: row.follow_up_type || "", width: cols[5].width },
            { text: row.wechat_contacts || "", width: cols[6].width },
            { text: row.remarks || "", width: cols[7].width },
          ];
      addTableRow(ctx, cells, index);
    });
  }

  const rangePart = safeFilenamePart(input.rangeLabel.replace(/\s+/g, ""));
  const scopePart = safeFilenamePart(input.scopeLabel);
  const periodPart = safeFilenamePart(input.periodLabel.toLowerCase());
  savePdf(ctx, `kafi-kpi-manual-${periodPart}-${rangePart}-${scopePart}.pdf`);
}
