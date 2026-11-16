import { existsSync, readFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { publicDir, type School } from './config.js';

export type Doc = InstanceType<typeof PDFDocument>;
export type SchoolInfo = Pick<School, 'slug' | 'name' | 'color' | 'address' | 'phone' | 'email'>;

/** Everything printed on a fee receipt. Amounts are integer paise. receiptNo = the school ERP's number (e.g. FR-123). */
export interface Receipt {
  school: SchoolInfo;
  receiptNo: string;
  orderId: string;
  gatewayRef: string;
  mode: string;                                  // how it was paid, as the gateway reports it: UPI, Card, ...
  paidAt: Date;
  student: { admNo: string; name: string; cls: string; section: string };
  /** Every due as the parent saw it; `paying` = the part of it paid with this receipt (0 = not this time). */
  items: { label: string; paise: number; paying: number; lines: { label: string; paise: number }[] }[];
  totalPaise: number;
}

// Built-in Helvetica has no ₹ glyph, so amounts use "Rs." (standard on Indian receipts).
export const inr = (paise: number) =>
  (paise < 0 ? '-Rs. ' : 'Rs. ') + (Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const formatIst = (d: Date) =>
  d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
/** "XI Comm - A" */
export const classOf = (s: { cls: string; section: string }) => [s.cls, s.section].filter(Boolean).join(' - ');

export const dateIst = (d: Date) => d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });

const A5 = { w: 419.53, h: 595.28 };
export const M = 30;                           // page margin
// money colours, the same as on the pay page: what is owed (red), what was paid (green)
export const INK = '#1d2433', MUTED = '#6b7280', RULE = '#e5e7eb', CHARGED = '#b91c1c', PAID = '#15803d', WHITE = '#ffffff';

/** Top left of a page: logo (or initials) + school name + contacts. Returns the y where it ends. Shared by both PDFs. */
export function schoolHeader(doc: Doc, school: SchoolInfo): number {
  const logoPath = `${publicDir}schools/${school.slug}/logo.png`;
  const logo = existsSync(logoPath) ? readFileSync(logoPath) : null;
  const contacts = [school.address, school.phone, school.email].filter(Boolean).join('\n');
  if (logo && logo.readUInt32BE(16) / logo.readUInt32BE(20) >= 2.5) {   // PNG header: width @16, height @20
    // Wordmark logo (emblem + school name, e.g. Ranchi): it IS the heading, contacts go underneath.
    doc.image(logo, M, 24, { fit: [220, 30], valign: 'center' });
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(contacts, M, 60, { width: 220, lineGap: 1 });
  } else {
    // Square logo (or initials when there is none) beside the school name.
    if (logo) doc.image(logo, M, 24, { fit: [46, 46], align: 'center', valign: 'center' });
    else {
      doc.roundedRect(M, 24, 46, 46, 8).fill(school.color);
      doc.font('Helvetica-Bold').fontSize(16).fillColor(WHITE).text(initials(school.name), M, 40, { width: 46, align: 'center' });
    }
    const sx = M + 56, sw = 190;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(school.name, sx, 26, { width: sw });
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(contacts, sx, doc.y + 3, { width: sw, lineGap: 1 });
  }
  return Math.max(doc.y, 72);
}

/** Short one-page A5 fee receipt (continues on a new page only for unusually long fee lists). */
export function renderReceiptPdf(r: Receipt): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A5', margin: 0, info: { Title: `Fee receipt ${r.receiptNo}`, Author: r.school.name } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

  const brand = r.school.color, right = A5.w - M, innerW = A5.w - 2 * M;
  const room = (y: number, need: number) => (y + need > A5.h - 60 ? (doc.addPage(), M) : y);
  doc.rect(0, 0, A5.w, 5).fill(brand);                                 // thin brand strip on top

  // ---- header: logo + school (left) | RECEIPT no/date/PAID (right) ----
  const headerEnd = schoolHeader(doc, r.school);
  const rw = 120, rx = right - rw;
  doc.font('Helvetica-Bold').fontSize(18).fillColor(brand).text('RECEIPT', rx, 24, { width: rw, align: 'right', characterSpacing: 1 });
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
    .text(`No.  ${r.receiptNo}`, rx, 48, { width: rw, align: 'right' })
    .text(`Date  ${dateIst(r.paidAt)}`, rx, 59, { width: rw, align: 'right' });
  doc.roundedRect(right - 44, 72, 44, 15, 7.5).fill(PAID);
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(WHITE).text('PAID', right - 44, 76, { width: 44, align: 'center', characterSpacing: 1 });

  // ---- received from | payment ----
  let y = Math.max(headerEnd, 87) + 14;
  doc.moveTo(M, y).lineTo(right, y).lineWidth(0.75).strokeColor(RULE).stroke();
  y += 10;
  const colW = innerW / 2 - 8;
  const block = (title: string, rows: string[], x: number) => {
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(MUTED).text(title, x, y, { width: colW, characterSpacing: 0.8 });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(rows[0]!, x, y + 11, { width: colW, lineBreak: false, ellipsis: true });
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(rows.slice(1).join('\n'), x, y + 24, { width: colW, lineGap: 1 });
  };
  block('RECEIVED FROM', [r.student.name, `Admission no. ${r.student.admNo}`, `Class ${classOf(r.student)}`], M);
  block('PAYMENT', [`Online (${r.mode})`, `Ref ${r.gatewayRef}`, `Paid ${formatIst(r.paidAt)}`], M + innerW / 2 + 8);
  y += 62;

  // ---- items: the dues paid with this receipt ----
  const amtW = 90, descX = M + 26, descW = innerW - 26 - amtW - 16;
  doc.rect(M, y, innerW, 18).fill(brand);
  doc.font('Helvetica-Bold').fontSize(7).fillColor(WHITE)
    .text('#', M + 8, y + 6).text('DESCRIPTION', descX, y + 6, { characterSpacing: 0.6 })
    .text('AMOUNT', right - 8 - amtW, y + 6, { width: amtW, align: 'right', characterSpacing: 0.6 });
  y += 18;
  r.items.filter(item => item.paying > 0).forEach((item, i) => {
    y = room(y, 34) + 8;
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(String(i + 1), M + 8, y);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(item.label, descX, y, { width: descW });
    doc.text(inr(item.paying), right - 8 - amtW, y, { width: amtW, align: 'right' });
    // under it: what the due covers when paid in full, or how much of it this part payment is
    const note = item.paying < item.paise
      ? `Part payment of ${inr(item.paise)} due, ${inr(item.paise - item.paying)} remains`
      : item.lines.map(l => `${l.label} ${inr(l.paise)}`.replace(/ (?=[\d,.]+$)/, ' ')).join('  ·  ');   // e.g. "Oct 2026 tuition Rs. 3,000.00  ·  Nov 2026 tuition …"
    if (note) doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(note, descX, doc.y + 2, { width: descW, lineGap: 1 });
    y = doc.y + 8;
    doc.moveTo(M, y).lineTo(right, y).lineWidth(0.5).strokeColor(RULE).stroke();
  });

  // ---- totals ----
  y = room(y, 80) + 10;
  const balance = r.items.reduce((sum, i) => sum + i.paise - i.paying, 0);   // what the student still owes after this payment
  const tx = right - 170, tw = 170;
  const total = (label: string, value: string, opts: { bold?: boolean; color?: string } = {}) => {
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.bold ? 9.5 : 8).fillColor(opts.color ?? INK)
      .text(label, tx, y, { width: tw - amtW }).text(value, right - amtW - 8, y, { width: amtW, align: 'right' });
    y += opts.bold ? 16 : 13;
  };
  total('Amount paid', inr(r.totalPaise), { bold: true, color: PAID });
  doc.moveTo(tx, y - 3).lineTo(right, y - 3).lineWidth(0.75).strokeColor(INK).stroke();
  y += 3;
  total('Balance due', inr(balance), { color: balance > 0 ? CHARGED : PAID });
  doc.font('Helvetica-Oblique').fontSize(7).fillColor(MUTED).text(rupeesInWords(r.totalPaise), M, y + 4, { width: innerW });

  // ---- footer ----
  const fy = A5.h - 42;
  doc.moveTo(M, fy).lineTo(right, fy).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.font('Helvetica').fontSize(6.5).fillColor(MUTED)
    .text('Computer-generated receipt, no signature required.  Thank you for your payment.', M, fy + 9, { width: innerW, align: 'center' })
    .text(`Order ${r.orderId}  ·  Paid online via Facts Pay`, M, fy + 19, { width: innerW, align: 'center' });

  doc.end();
  return done;
}

/** "Metas Adventist School, Ranchi" -> "MA" (logo fallback). */
const initials = (name: string) => name.split(/[\s,]+/).filter(w => /^[A-Z]/.test(w)).slice(0, 2).map(w => w[0]).join('');

// ---- amount in words, Indian numbering (lakh, crore) ----
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const UNITS: [number, string][] = [[1e7, 'Crore'], [1e5, 'Lakh'], [1e3, 'Thousand'], [100, 'Hundred']];

function words(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) return [TENS[Math.floor(n / 10)], ONES[n % 10]].filter(Boolean).join(' ');
  const [size, unit] = UNITS.find(([s]) => n >= s)!;
  return [words(Math.floor(n / size)), unit, n % size ? words(n % size) : ''].filter(Boolean).join(' ');
}

export function rupeesInWords(paise: number): string {
  const rupees = Math.floor(paise / 100), p = paise % 100;
  return `Rupees ${rupees ? words(rupees) : 'Zero'}${p ? ` and ${words(p)} Paise` : ''} Only`;
}
