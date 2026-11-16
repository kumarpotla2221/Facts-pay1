// PDF unit tests (no DB). Writes the rendered samples to RECEIPT_OUT / STATEMENT_OUT if set, to eyeball the design.
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderReceiptPdf, rupeesInWords, type Receipt } from '../src/receipt-pdf.js';
import { renderStatementPdf } from '../src/statement-pdf.js';

const pages = (pdf: Buffer) => pdf.toString('latin1').match(/\/Type \/Page\b/g)?.length;
const school = { slug: 'no-logo-school', name: 'Metas Adventist School, Ranchi', color: '#0f4b70', address: 'Bariyatu Road, Ranchi - 9', phone: '+91 7050555223', email: 'office@example.com' };
const student = { admNo: '26/39', name: 'Navya Singh Rajput', cls: 'STD-III', section: 'A' };

describe('rupeesInWords (Indian numbering)', () => {
  it.each([
    [0, 'Rupees Zero Only'],
    [100, 'Rupees One Only'],
    [1_150, 'Rupees Eleven and Fifty Paise Only'],
    [300_000, 'Rupees Three Thousand Only'],
    [1_012_400, 'Rupees Ten Thousand One Hundred Twenty Four Only'],
    [123_456_789, 'Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Eighty Nine Paise Only'],
    [100_000_000_000, 'Rupees One Hundred Crore Only'],
  ])('%i paise', (paise, text) => expect(rupeesInWords(paise)).toBe(text));
});

describe('renderReceiptPdf', () => {
  it('renders a short one-page PDF even for a long breakdown, with a part payment', async () => {
    const months = Array.from({ length: 40 }, (_, i) => ({ label: `Month ${i + 1} tuition`, paise: 100_000 }));
    const r: Receipt = {
      school, student, receiptNo: 'FR-1234', orderId: '00000000-0000-4000-8000-000000000000', gatewayRef: 'MOCK-abcd1234', mode: 'UPI', paidAt: new Date('2026-11-10T06:30:00Z'),
      items: [
        { label: 'School fees (tuition & charges)', paise: 4_000_000, paying: 4_000_000, lines: months },
        { label: 'Transport fees', paise: 180_000, paying: 90_000, lines: [] },
      ],
      totalPaise: 4_090_000,
    };
    const pdf = await renderReceiptPdf(r);
    if (process.env.RECEIPT_OUT) writeFileSync(process.env.RECEIPT_OUT, pdf);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pages(pdf)).toBe(1);   // short receipt: one A5 page
  });
});

describe('renderStatementPdf', () => {
  it('renders the year, continuing on a new page when it is long', async () => {
    const statement = Array.from({ length: 40 }, (_, i) => ({
      date: `2026-${String((i % 12) + 1).padStart(2, '0')}-01`, ref: `JV 01-${i + 1}`,
      label: i % 4 ? `Month ${i + 1} tuition fees charged on the A/C.` : 'Tuition fees received online',
      chargedPaise: i % 4 ? 316_000 : 0, paidPaise: i % 4 ? 0 : 948_000,
    }));
    const pdf = await renderStatementPdf({
      school, adm: student.admNo, student: { name: student.name, cls: student.cls, section: student.section }, statement,
      items: [{ id: 'tuition', type: 'fees', label: 'School fees (tuition & charges)', paise: 0, minPaise: 0, lines: [] }],
    });
    if (process.env.STATEMENT_OUT) writeFileSync(process.env.STATEMENT_OUT, pdf);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pages(pdf)).toBe(2);
  });
});
