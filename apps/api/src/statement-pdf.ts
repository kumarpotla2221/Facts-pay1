import PDFDocument from 'pdfkit';
import type { Lookup } from './payments.js';
import { CHARGED, classOf, dateIst, INK, inr, M, MUTED, PAID, RULE, schoolHeader, WHITE, type SchoolInfo } from './receipt-pdf.js';

/** The student's account for the academic year: every charge and payment, and what is still owed. */
export type Statement = Lookup & { school: SchoolInfo; adm: string };

const A4 = { w: 595.28, h: 841.89 };

/** A4 fee statement, as many pages as the year needs. The same data the pay page shows under "View statement". */
export function renderStatementPdf(s: Statement): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Fee statement ${s.adm}`, Author: s.school.name } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

  const brand = s.school.color, right = A4.w - M, innerW = A4.w - 2 * M;
  const charged = s.statement.reduce((sum, e) => sum + e.chargedPaise, 0);
  const paid = s.statement.reduce((sum, e) => sum + e.paidPaise, 0);
  doc.rect(0, 0, A4.w, 5).fill(brand);

  // ---- header: logo + school (left) | STATEMENT, date (right) ----
  const headerEnd = schoolHeader(doc, s.school);
  const rw = 160, rx = right - rw;
  doc.font('Helvetica-Bold').fontSize(18).fillColor(brand).text('STATEMENT', rx, 24, { width: rw, align: 'right', characterSpacing: 1 });
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(`As on  ${dateIst(new Date())}`, rx, 48, { width: rw, align: 'right' });

  // ---- student | this year in short ----
  let y = Math.max(headerEnd, 72) + 14;
  doc.moveTo(M, y).lineTo(right, y).lineWidth(0.75).strokeColor(RULE).stroke();
  y += 10;
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(MUTED).text('STUDENT', M, y, { characterSpacing: 0.8 });
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(s.student.name, M, y + 11, { width: innerW / 2, lineBreak: false, ellipsis: true });
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(`Admission no. ${s.adm}\nClass ${classOf(s.student)}`, M, y + 24, { lineGap: 1 });
  const sx = right - 200;
  const owing = charged > paid ? CHARGED : PAID;                               // red while something is owed
  const line = (label: string, value: string, color: string, dy: number, bold = false) =>
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 9 : 8).fillColor(bold ? INK : MUTED)
      .text(label, sx, y + dy, { width: 110 }).fillColor(color).text(value, sx + 110, y + dy, { width: 90, align: 'right' });
  line('Charged this year', inr(charged), CHARGED, 0);
  line('Paid this year', inr(paid), PAID, 13);
  line('Balance due', inr(charged - paid), owing, 28, true);
  y += 62;

  // ---- the entries: DATE | REF | PARTICULARS | CHARGED | PAID ----
  const amtW = 80, col = { date: M + 8, ref: M + 72, label: M + 146, charged: right - 8 - 2 * amtW - 10, paid: right - 8 - amtW };
  const labelW = col.charged - col.label - 12;
  const head = () => {
    doc.rect(M, y, innerW, 18).fill(brand);
    doc.font('Helvetica-Bold').fontSize(7).fillColor(WHITE)
      .text('DATE', col.date, y + 6).text('REF', col.ref, y + 6).text('PARTICULARS', col.label, y + 6, { characterSpacing: 0.6 })
      .text('CHARGED', col.charged, y + 6, { width: amtW, align: 'right', characterSpacing: 0.6 })
      .text('PAID', col.paid, y + 6, { width: amtW, align: 'right', characterSpacing: 0.6 });
    y += 18;
  };
  const room = (need: number) => { if (y + need > A4.h - 60) { doc.addPage(); y = M; head(); } };
  head();
  if (!s.statement.length) {
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED).text('No transactions this academic year.', col.date, y + 8);
    y += 26;
  }
  for (const e of s.statement) {
    room(30);
    y += 7;
    doc.font('Helvetica').fontSize(8.5).fillColor(INK)
      .text(dateIst(new Date(e.date)), col.date, y, { width: 60 })
      .text(e.ref, col.ref, y, { width: 70, lineBreak: false, ellipsis: true })
      .text(e.label || '-', col.label, y, { width: labelW });
    const bottom = doc.y;
    // red = a charge, green = a payment or a concession (a negative charge)
    doc.fillColor(e.chargedPaise < 0 ? PAID : CHARGED).text(e.chargedPaise ? inr(e.chargedPaise) : '', col.charged, y, { width: amtW, align: 'right' })
      .fillColor(PAID).text(e.paidPaise ? inr(e.paidPaise) : '', col.paid, y, { width: amtW, align: 'right' });
    y = Math.max(bottom, doc.y) + 7;
    doc.moveTo(M, y).lineTo(right, y).lineWidth(0.5).strokeColor(RULE).stroke();
  }
  room(36);                                                                  // the two total lines
  y += 8;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text('Total', col.label, y, { width: labelW })
    .fillColor(CHARGED).text(inr(charged), col.charged, y, { width: amtW, align: 'right' })
    .fillColor(PAID).text(inr(paid), col.paid, y, { width: amtW, align: 'right' });
  y += 16;
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text('Balance due', col.label, y, { width: labelW })
    .fillColor(owing).text(inr(charged - paid), col.paid, y, { width: amtW, align: 'right' });

  // ---- footer ----
  const fy = A4.h - 42;
  doc.moveTo(M, fy).lineTo(right, fy).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.font('Helvetica').fontSize(6.5).fillColor(MUTED)
    .text("Computer-generated statement of the student's fee account, as per the school's records on the date shown.", M, fy + 9, { width: innerW, align: 'center' })
    .text('Facts Pay', M, fy + 19, { width: innerW, align: 'center' });

  doc.end();
  return done;
}
