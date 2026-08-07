import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { Report } from '../engine/reports';

export type ExportFormat = 'json' | 'csv' | 'xlsx' | 'pdf';

export const CONTENT_TYPE: Record<Exclude<ExportFormat, 'json'>, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

/** RFC 4180 CSV escaping. */
function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV: header row from columns, then data rows, then a blank line + summary. */
export function toCsv(report: Report): string {
  const lines: string[] = [];
  lines.push(report.columns.map((c) => csvCell(c.label)).join(','));
  for (const row of report.rows) {
    lines.push(report.columns.map((c) => csvCell(row[c.key] ?? '')).join(','));
  }
  lines.push('');
  for (const [k, v] of Object.entries(report.summary)) lines.push(`${csvCell(k)},${csvCell(v)}`);
  return lines.join('\n');
}

export async function toXlsx(report: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date(report.generatedAt);
  const ws = wb.addWorksheet(report.title.slice(0, 31)); // sheet name max 31 chars

  ws.addRow([report.title]);
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.addRow([`Range: ${report.range.from} → ${report.range.to}`]);
  ws.addRow([]);

  const header = ws.addRow(report.columns.map((c) => c.label));
  header.font = { bold: true };
  for (const row of report.rows) ws.addRow(report.columns.map((c) => row[c.key] ?? ''));

  ws.addRow([]);
  ws.addRow(['Summary']).font = { bold: true };
  for (const [k, v] of Object.entries(report.summary)) ws.addRow([k, v]);

  ws.columns.forEach((col) => {
    let max = 10;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      max = Math.max(max, String(cell.value ?? '').length + 2);
    });
    col.width = Math.min(max, 40);
  });

  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

export function toPdf(report: Report): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c as Buffer));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text(report.title);
    doc.fontSize(9).fillColor('#666').text(`Range: ${report.range.from} → ${report.range.to}`);
    doc.text(`Generated: ${report.generatedAt}`);
    doc.moveDown().fillColor('#000');

    const left = doc.page.margins.left;
    const usable = doc.page.width - left - doc.page.margins.right;
    const colW = usable / report.columns.length;
    const drawRow = (cells: (string | number)[], bold: boolean) => {
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      cells.forEach((c, i) => doc.text(String(c), left + i * colW, y, { width: colW - 4, ellipsis: true }));
      doc.moveDown(0.5);
    };

    drawRow(report.columns.map((c) => c.label), true);
    doc.moveTo(left, doc.y).lineTo(left + usable, doc.y).stroke('#ccc');
    for (const row of report.rows) {
      if (doc.y > doc.page.height - 80) doc.addPage();
      drawRow(report.columns.map((c) => row[c.key] ?? ''), false);
    }

    doc.moveDown().font('Helvetica-Bold').fontSize(11).text('Summary');
    doc.font('Helvetica').fontSize(9);
    for (const [k, v] of Object.entries(report.summary)) doc.text(`${k}: ${v}`);

    doc.end();
  });
}

export async function exportReport(report: Report, format: Exclude<ExportFormat, 'json'>): Promise<Buffer | string> {
  if (format === 'csv') return toCsv(report);
  if (format === 'xlsx') return toXlsx(report);
  return toPdf(report);
}
