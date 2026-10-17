import { jsPDF } from "jspdf";

export type PdfContext = {
  doc: jsPDF;
  margin: number;
  pageWidth: number;
  pageHeight: number;
  maxWidth: number;
  y: number;
};

export function createPdfContext(orientation: "portrait" | "landscape" = "portrait"): PdfContext {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation });
  const margin = 14;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  return {
    doc,
    margin,
    pageWidth,
    pageHeight,
    maxWidth: pageWidth - margin * 2,
    y: margin,
  };
}

export function ensureSpace(ctx: PdfContext, needed: number): void {
  if (ctx.y + needed > ctx.pageHeight - ctx.margin - 8) {
    ctx.doc.addPage();
    ctx.y = ctx.margin;
  }
}

export function addHeading(ctx: PdfContext, text: string, size = 13): void {
  ensureSpace(ctx, 12);
  ctx.doc.setFont("helvetica", "bold");
  ctx.doc.setFontSize(size);
  ctx.doc.setTextColor(20, 20, 20);
  ctx.doc.text(text, ctx.margin, ctx.y);
  ctx.y += size * 0.45 + 3;
}

export function addBody(
  ctx: PdfContext,
  text: string,
  opts?: { bold?: boolean; size?: number; color?: [number, number, number]; indent?: number },
): void {
  const size = opts?.size ?? 10;
  const indent = opts?.indent ?? 0;
  const lines = ctx.doc.splitTextToSize(text, ctx.maxWidth - indent) as string[];
  ensureSpace(ctx, lines.length * (size * 0.42) + 2);
  ctx.doc.setFont("helvetica", opts?.bold ? "bold" : "normal");
  ctx.doc.setFontSize(size);
  if (opts?.color) ctx.doc.setTextColor(...opts.color);
  else ctx.doc.setTextColor(40, 40, 40);
  ctx.doc.text(lines, ctx.margin + indent, ctx.y);
  ctx.y += lines.length * (size * 0.42) + 2;
}

export function addRule(ctx: PdfContext): void {
  ensureSpace(ctx, 6);
  ctx.doc.setDrawColor(200, 200, 200);
  ctx.doc.setLineWidth(0.25);
  ctx.doc.line(ctx.margin, ctx.y, ctx.pageWidth - ctx.margin, ctx.y);
  ctx.y += 6;
}

export function addKeyValueGrid(
  ctx: PdfContext,
  pairs: Array<{ label: string; value: string | number }>,
  columns = 2,
): void {
  const colWidth = ctx.maxWidth / columns;
  const rowHeight = 6;
  let col = 0;
  let rowStartY = ctx.y;
  ensureSpace(ctx, rowHeight * Math.ceil(pairs.length / columns) + 4);

  for (const pair of pairs) {
    const x = ctx.margin + col * colWidth;
    ctx.doc.setFont("helvetica", "normal");
    ctx.doc.setFontSize(8);
    ctx.doc.setTextColor(90, 90, 90);
    ctx.doc.text(pair.label, x, rowStartY);
    ctx.doc.setFont("helvetica", "bold");
    ctx.doc.setFontSize(10);
    ctx.doc.setTextColor(30, 30, 30);
    const val = String(pair.value);
    const valLines = ctx.doc.splitTextToSize(val, colWidth - 4) as string[];
    ctx.doc.text(valLines[0] ?? "—", x, rowStartY + 4);
    col += 1;
    if (col >= columns) {
      col = 0;
      rowStartY += rowHeight + 3;
      ctx.y = Math.max(ctx.y, rowStartY);
    }
  }
  if (col !== 0) {
    ctx.y = rowStartY + rowHeight + 4;
  } else {
    ctx.y = rowStartY + 2;
  }
}

export function addTableHeader(
  ctx: PdfContext,
  columns: Array<{ label: string; width: number }>,
): number {
  const headerH = 7;
  ensureSpace(ctx, headerH + 2);
  const startY = ctx.y;
  let x = ctx.margin;
  ctx.doc.setFillColor(240, 240, 240);
  ctx.doc.rect(ctx.margin, startY - 5, ctx.maxWidth, headerH, "F");
  ctx.doc.setFont("helvetica", "bold");
  ctx.doc.setFontSize(8);
  ctx.doc.setTextColor(50, 50, 50);
  for (const col of columns) {
    ctx.doc.text(col.label, x + 1, startY);
    x += col.width;
  }
  ctx.y = startY + 4;
  return startY;
}

export function addTableRow(
  ctx: PdfContext,
  columns: Array<{ text: string; width: number }>,
  rowIndex: number,
): void {
  const lineH = 4.2;
  const texts = columns.map((c) =>
    ctx.doc.splitTextToSize((c.text || "—").trim() || "—", c.width - 2),
  ) as string[][];
  const lines = Math.max(1, ...texts.map((t) => t.length));
  ensureSpace(ctx, lines * lineH + 2);
  if (rowIndex % 2 === 1) {
    ctx.doc.setFillColor(248, 248, 248);
    ctx.doc.rect(ctx.margin, ctx.y - 3.5, ctx.maxWidth, lines * lineH + 1, "F");
  }
  let x = ctx.margin;
  ctx.doc.setFont("helvetica", "normal");
  ctx.doc.setFontSize(7.5);
  ctx.doc.setTextColor(35, 35, 35);
  for (let i = 0; i < columns.length; i += 1) {
    const cellLines = texts[i];
    for (let ln = 0; ln < cellLines.length; ln += 1) {
      ctx.doc.text(cellLines[ln], x + 1, ctx.y + ln * lineH);
    }
    x += columns[i].width;
  }
  ctx.y += lines * lineH + 1.5;
}

export function stampFooters(ctx: PdfContext, title: string): void {
  const total = ctx.doc.getNumberOfPages();
  for (let p = 1; p <= total; p += 1) {
    ctx.doc.setPage(p);
    ctx.doc.setFont("helvetica", "normal");
    ctx.doc.setFontSize(7);
    ctx.doc.setTextColor(130, 130, 130);
    ctx.doc.text(title, ctx.margin, ctx.pageHeight - 6);
    ctx.doc.text(`Page ${p} of ${total}`, ctx.pageWidth - ctx.margin - 18, ctx.pageHeight - 6);
  }
}

export function safeFilenamePart(value: string): string {
  return value.replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").slice(0, 80);
}

export function savePdf(ctx: PdfContext, filename: string): void {
  stampFooters(ctx, "Kafi Commodities · Asia/Karachi");
  ctx.doc.save(filename);
}
