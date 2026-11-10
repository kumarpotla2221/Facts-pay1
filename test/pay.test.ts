// Integration tests against the Ranchi database in schools.json (the demo copy on Heroku).
// WARNING: the payment test really pays one student's dues there, then marks them approved so the dues come back.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SendMailOptions } from 'nodemailer';
import sql from 'mssql';
import { buildApp } from '../src/app.js';
import { config, schools } from '../src/config.js';
import { getDues, type Entry } from '../src/school-db.js';
import type { Payable as Due } from '../src/payments.js';

const school = schools.find(s => s.slug === 'ranchi')!;
const connect = (login: { user: string; passwordEnv: string }) => new sql.ConnectionPool({
  server: school.db.host, port: school.db.port, database: school.db.name, user: login.user, password: process.env[login.passwordEnv],
  options: { encrypt: true, trustServerCertificate: config.DB_TRUST_CERT === '1' },
}).connect();

let app: FastifyInstance;
let payDb: sql.ConnectionPool;                             // the web login, exactly as the API connects
let adminDb: sql.ConnectionPool;                           // the owner: test setup only (the web login cannot read any table)
let adm: string;                                           // a student who still owes something
const mails: SendMailOptions[] = [];

beforeAll(async () => {
  app = await buildApp({ logger: false, mailTransport: { sendMail: async (m: SendMailOptions) => { mails.push(m); return {}; } } as never });
  payDb = await connect(school.db);
  adminDb = await connect(school.db.admin ?? school.db);
  const { recordset } = await adminDb.query<{ student_id: string }>`SELECT TOP 40 student_id FROM students ORDER BY student_id DESC`;
  for (const { student_id } of recordset) {
    if ((await getDues(payDb, student_id))?.items.length) { adm = student_id; break; }
  }
  if (!adm) throw new Error('No student with dues left in the Ranchi database');
}, 60_000);
afterAll(async () => { await Promise.all([app.close(), payDb.close(), adminDb.close()]); });

const get = async (url: string) => { const r = await app.inject({ method: 'GET', url }); return { code: r.statusCode, body: r.json() }; };
const post = async (url: string, payload: unknown) => { const r = await app.inject({ method: 'POST', url, payload: payload as object }); return { code: r.statusCode, body: r.json() }; };
const dues = (a: string) => post('/api/ranchi/dues', { adm: a });
const order = (pays: { id: string; paise: number }[], extra: object = {}) => post('/api/ranchi/orders', { adm, pays, ...extra });
const pay = (orderId: string, outcome = 'success') => post(`/api/ranchi/orders/${orderId}/pay`, { outcome, mode: 'UPI' });
const paidThisYear = (statement: Entry[]) => statement.reduce((a, e) => a + e.paidPaise, 0);
const inFull = (items: Due[]) => items.map(i => ({ id: i.id, paise: i.paise }));

describe('lookup', () => {
  it('returns student, dues (with the school\'s part-payment minimum) and the year\'s statement, in integer paise', async () => {
    const { code, body } = await dues(adm);
    expect(code).toBe(200);
    expect(body.student.name).toBeTruthy();
    expect(body.student.cls).toBeTruthy();
    expect(body.items.length).toBeGreaterThan(0);
    for (const i of body.items as Due[]) {
      expect(Number.isInteger(i.paise)).toBe(true);
      expect(i.minPaise).toBeGreaterThanOrEqual(1);
      expect(i.minPaise).toBeLessThanOrEqual(i.paise);
      if (i.lines.length) expect(i.lines.reduce((a, l) => a + l.paise, 0)).toBe(i.paise);
    }
    expect(body.statement.length).toBeGreaterThan(0);
    for (const e of body.statement as Entry[]) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isInteger(e.chargedPaise) && Number.isInteger(e.paidPaise)).toBe(true);
    }
  });
  it('serves the statement as a PDF', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/ranchi/statement', payload: { adm } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });
  it('rejects unknown / malformed input', async () => {
    expect((await dues('NO-SUCH-ADM')).code).toBe(404);
    expect((await dues("1';DROP TABLE x--")).code).toBe(400);
    expect((await get('/api/nosuchschool/info')).code).toBe(404);
    expect((await get(`/api/ranchi/dues/${encodeURIComponent(adm)}`)).code).toBe(404);   // lookups are POST only: no admission number in URLs
  });
});

describe('payment flow', () => {
  it('part payment by the school rule, then the rest; rejects tampering, expiry and replay; emails a PDF receipt', async () => {
    const { body: d } = await dues(adm);
    const first: Due = d.items[0];
    const erpReceipts = async () => (await adminDb.query<{ n: number }>`SELECT COUNT(*) AS n FROM fee_receipt_doc fd JOIN students s ON s.sub_acct_code IN
      (SELECT sub_acct_code FROM fee_receipt_tran t WHERE t.doc_type_code = fd.doc_type_code AND t.doc_no = fd.doc_no AND t.finance_year = fd.finance_year) WHERE s.student_id = ${adm}`).recordset[0]!.n;
    const erpBefore = await erpReceipts();

    expect((await order([{ id: 'nosuchdue', paise: 100 }])).code).toBe(409);                       // not this student's due
    expect((await order([{ id: 'x;DROP', paise: 1 }])).code).toBe(400);
    expect((await order([{ id: first.id, paise: 0 }])).code).toBe(400);
    expect((await order([{ id: first.id, paise: first.minPaise - 1 }])).code).toBe(400);            // below the school's minimum
    expect((await order([{ id: first.id, paise: first.paise + 1 }])).body.error).toMatch(/pay between/);   // more than owed
    expect((await order([{ id: first.id, paise: first.paise }, { id: first.id, paise: first.paise }])).code).toBe(400);   // same due twice
    expect((await pay(randomUUID())).code).toBe(404);                                               // no such order

    // A part payment: the least the school allows on the first due. Nothing is written into the ERP; the payment sits
    // in pay_order, and until the school approves it the pay page takes it off the dues and shows it on the statement.
    const { body: part } = await order([{ id: first.id, paise: first.minPaise }], { email: 'parent@example.com' });
    expect(part.paise).toBe(first.minPaise);
    const { body: partPaid } = await pay(part.orderId);
    expect(partPaid.receiptNo).toMatch(/^OL-\d+$/);
    expect(await erpReceipts()).toBe(erpBefore);                                                  // the ERP is untouched
    const { body: after } = await dues(adm);
    const firstAfter = after.items.find((i: Due) => i.id === first.id);
    expect(firstAfter?.paise ?? 0).toBe(first.paise - first.minPaise);
    if (firstAfter?.lines.length) expect(firstAfter.lines.reduce((a: number, l: { paise: number }) => a + l.paise, 0)).toBe(firstAfter.paise);
    expect(paidThisYear(after.statement)).toBe(paidThisYear(d.statement) + first.minPaise);
    expect(after.statement.at(-1)).toMatchObject({ ref: partPaid.receiptNo, label: 'Paid online (UPI)', paidPaise: first.minPaise });

    // The rest, in full.
    const pays = inFull(after.items);
    const { body: failed } = await order(pays);
    expect(failed.paise).toBe(after.items.reduce((a: number, i: Due) => a + i.paise, 0));        // amount from the school DB
    expect((await pay(failed.orderId, 'fail')).code).toBe(402);
    expect((await pay(failed.orderId)).code).toBe(409);                                             // a failed order is dead

    const { body: expired } = await order(pays);
    await adminDb.query`UPDATE pay_order SET expires_at = DATEADD(minute, -1, SYSUTCDATETIME()) WHERE order_id = ${expired.orderId}`;
    expect((await pay(expired.orderId)).body.error).toMatch(/expired/);

    // Race: a double click on one order. Exactly one payment may win. A second order made beforehand in another
    // tab (b, typed in another letter case) is cancelled here; once a is paid, nothing is owed any more.
    const { body: a } = await order(pays, { email: 'parent@example.com' });
    const { body: b } = await post('/api/ranchi/orders', { adm: adm.toLowerCase(), pays, email: 'parent@example.com' });
    const results = await Promise.all([pay(a.orderId), pay(a.orderId)]);
    expect(results.map(r => r.code).sort()).toEqual([200, 409]);
    const paid = results.find(r => r.code === 200)!.body;
    expect(paid.emailed).toBe(true);
    const winner = a, loser = b;
    expect((await pay(winner.orderId)).body.error).toMatch(/already paid/);
    expect((await pay(winner.orderId, 'fail')).body.error).toMatch(/already paid/);                 // never "nothing was charged" for a paid order
    expect((await pay(loser.orderId, 'fail')).code).toBe(402);
    expect((await dues(adm)).body.items).toHaveLength(0);
    expect((await order(pays)).code).toBe(409);                                                     // nothing left to pay
    expect(await erpReceipts()).toBe(erpBefore);

    // Only the orders THIS test made (the student may carry older online payments in a reused dev database).
    const { recordset: rows } = await adminDb.query<{ order_id: string; status: string; receipt_no: string | null; class: string; section: string; payment_mode: string | null }>`
      SELECT order_id, status, receipt_no, class, section, payment_mode FROM pay_order WHERE adm_no = ${adm}`;
    const byStatus = (status: string) => rows.filter(r => r.status === status).map(r => r.order_id).sort();
    expect(byStatus('PAID')).toEqual(expect.arrayContaining([part.orderId, winner.orderId]));        // the part payment + the winner
    expect(byStatus('PAID')).not.toContain(loser.orderId);
    expect(byStatus('FAILED')).toEqual(expect.arrayContaining([failed.orderId, loser.orderId]));     // the cancelled order + the loser
    expect(rows.find(r => r.order_id === winner.orderId)).toMatchObject({ receipt_no: paid.receiptNo, class: d.student.cls, section: d.student.section, payment_mode: 'UPI' });

    // Once the school approves a payment and creates its own records, Facts Pay trusts those records again (the ERP in this
    // test was never updated, so the dues reappear as they were).
    await adminDb.query`UPDATE pay_order SET approved_at = SYSUTCDATETIME(), erp_receipt_no = 'FR-test' WHERE order_id IN (${part.orderId}, ${winner.orderId})`;
    expect((await dues(adm)).body.items.map((i: Due) => [i.id, i.paise])).toEqual(d.items.map((i: Due) => [i.id, i.paise]));

    await vi.waitFor(() => expect(mails).toHaveLength(2));                                          // one receipt email per payment, with the PDF
    const mail = mails.find(m => String(m.subject).includes(paid.receiptNo))!;
    expect(mail.to).toBe('parent@example.com');
    expect(mail.subject).toContain('Fee receipt');
    const [pdf] = mail.attachments!;
    expect(pdf!.filename).toBe(`Receipt-${paid.receiptNo}.pdf`);
    expect((pdf!.content as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  }, 90_000);
});

describe('embedding', () => {
  it('pay page may only be framed by its own school site (and the demo site, which is this origin)', async () => {
    const res = await app.inject({ method: 'GET', url: '/pay/ranchi' });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self' https://ranchischool.metasofsda.in");
    const demo = await app.inject({ method: 'GET', url: '/view/ranchi' });
    expect(demo.statusCode).toBe(200);
    expect(demo.body).toContain('src="/pay/ranchi"');
    expect((await app.inject({ method: 'GET', url: '/view/nosuchschool' })).statusCode).toBe(404);
  });
});

// Only where the web login is separate from the owner. The demo copy on Heroku has one login for both (no db.admin).
describe.skipIf(!school.db.admin)('least privilege', () => {
  it('the web login can run the pay procedures but cannot touch a table or write a receipt directly', async () => {
    const denied = (query: string) => expect(payDb.request().query(query)).rejects.toThrow(/permission/i);
    await denied('SELECT TOP 1 * FROM students');
    await denied('UPDATE document SET next_no = 1');
    await denied('SELECT TOP 1 * FROM pay_order');
    await denied(`UPDATE pay_order SET status = 'PAID'`);
    await denied(`INSERT fee_receipt_doc (school_code) VALUES ('01')`);                                     // never into the ERP
    expect(await getDues(payDb, 'NO-SUCH-ADM')).toBeNull();
  });
});
