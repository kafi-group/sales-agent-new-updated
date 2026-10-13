import type { LeadTableRow } from "../api/client";

const COLUMNS = [
  { key: "company", header: "Company", width: 320 },
  { key: "score", header: "Score", width: 72 },
  { key: "marketRole", header: "Market role", width: 180 },
  { key: "producerTier", header: "Exporter tier", width: 220 },
  { key: "conversion", header: "Conversion %", width: 96 },
  { key: "country", header: "Country", width: 160 },
  { key: "callRecommended", header: "Call now?", width: 160 },
  { key: "industry", header: "Industry", width: 280 },
  { key: "contact", header: "Contact", width: 160 },
  { key: "assignedTo", header: "Assigned To", width: 120 },
  { key: "email", header: "Email", width: 260 },
  { key: "phone", header: "Phone", width: 120 },
  { key: "website", header: "Website", width: 300 },
  { key: "linkedin", header: "LinkedIn", width: 300 },
  { key: "source", header: "Source", width: 96 },
  { key: "added", header: "Added", width: 160 },
  { key: "scored", header: "Scored", width: 160 },
  { key: "reasoning", header: "Score reasoning", width: 480 },
] as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatMarketRole(role: string | null | undefined): string {
  const labels: Record<string, string> = {
    consumer: "Importer",
    producer: "Exporter",
    hybrid: "Hybrid (importer + exporter)",
    unknown: "Unknown",
  };
  return labels[role ?? "unknown"] ?? role ?? "";
}

function formatProducerTier(tier: string | null | undefined): string {
  if (tier === "strong") return "Strong exporter — direct competitor";
  if (tier === "weak") return "Weak exporter — conversion potential";
  return "";
}

function rowValues(row: LeadTableRow): Record<(typeof COLUMNS)[number]["key"], string> {
  return {
    company: row.company_name,
    score: row.latest_score ?? "Unscored",
    marketRole: formatMarketRole(row.market_role),
    producerTier: formatProducerTier(row.producer_tier),
    conversion:
      row.producer_conversion_pct != null ? String(Math.round(row.producer_conversion_pct)) : "",
    country: row.country ?? "",
    callRecommended:
      row.call_recommended === null
        ? "Unknown"
        : row.call_recommended
          ? `Yes${row.call_local_time ? ` (${row.call_local_time})` : ""}`
          : `No${row.call_local_time ? ` (${row.call_local_time})` : ""}`,
    industry: row.industry ?? "",
    contact: row.contact_name ?? "",
    assignedTo:
      !row.assigned_to || row.assigned_to === "unassigned"
        ? "Unassigned"
        : row.assigned_to,
    email: row.contact_email ?? "",
    phone: row.contact_phone ?? "",
    website: row.website_url ?? "",
    linkedin: row.linkedin_company_url ?? "",
    source: row.source ?? "",
    added: formatDate(row.created_at),
    scored: formatDate(row.scored_at),
    reasoning: row.score_reasoning ?? "",
  };
}

function buildExcelHtml(rows: LeadTableRow[]): string {
  const colgroup = COLUMNS.map(
    (col) => `   <col style="width:${col.width}px" />`,
  ).join("\n");

  const headerCells = COLUMNS.map(
    (col) => `    <th>${escapeHtml(col.header)}</th>`,
  ).join("\n");

  const bodyRows = rows
    .map((row) => {
      const values = rowValues(row);
      const cells = COLUMNS.map((col) => {
        const text = escapeHtml(values[col.key]);
        const classAttr = col.key === "reasoning" ? ' class="reasoning"' : "";
        if (col.key === "website" || col.key === "linkedin") {
          const url = values[col.key];
          if (url) {
            return `    <td${classAttr}><a href="${escapeHtml(url)}">${text}</a></td>`;
          }
        }
        if (col.key === "email") {
          const email = values[col.key];
          if (email) {
            return `    <td${classAttr}><a href="mailto:${escapeHtml(email)}">${text}</a></td>`;
          }
        }
        return `    <td${classAttr}>${text}</td>`;
      }).join("\n");
      return `   <tr>\n${cells}\n   </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:x="urn:schemas-microsoft-com:office:excel"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="UTF-8" />
<!--[if gte mso 9]>
<xml>
  <x:ExcelWorkbook>
    <x:ExcelWorksheets>
      <x:ExcelWorksheet>
        <x:Name>Leads</x:Name>
        <x:WorksheetOptions>
          <x:FreezePanes/>
          <x:FrozenNoSplit/>
          <x:SplitHorizontal>1</x:SplitHorizontal>
          <x:TopRowBottomPane>1</x:TopRowBottomPane>
          <x:ActivePane>2</x:ActivePane>
        </x:WorksheetOptions>
      </x:ExcelWorksheet>
    </x:ExcelWorksheets>
  </x:ExcelWorkbook>
</xml>
<![endif]-->
<style>
  table { border-collapse: collapse; table-layout: fixed; width: auto; }
  th, td {
    border: 1px solid #cbd5e1;
    padding: 6px 8px;
    vertical-align: top;
    text-align: left;
    font-family: Calibri, Arial, sans-serif;
    font-size: 11pt;
    white-space: nowrap;
    overflow: hidden;
  }
  th {
    background: #e2e8f0;
    font-weight: bold;
    white-space: nowrap;
  }
  td.reasoning {
    white-space: normal;
    word-wrap: break-word;
  }
  a { color: #059669; text-decoration: none; }
</style>
</head>
<body>
<table>
<colgroup>
${colgroup}
</colgroup>
<thead>
  <tr>
${headerCells}
  </tr>
</thead>
<tbody>
${bodyRows}
</tbody>
</table>
</body>
</html>`;
}

export function exportLeadsTableCsv(rows: LeadTableRow[], filename = "leads-table.xls") {
  if (rows.length === 0) return;

  const html = buildExcelHtml(rows);
  const blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".xls") ? filename : `${filename}.xls`;
  link.click();
  URL.revokeObjectURL(url);
}
