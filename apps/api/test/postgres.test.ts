import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDb } from '../src/postgres-db.js';
import type { NewOrder, Snapshot } from '../src/school-db.js';

// Explicit opt-in only. Synthetic data lives in a unique schema; no school's records are touched.
const uri = process.env.SUPABASE_TEST_URL;
describe.skipIf(!uri)('PostgreSQL school adapter', () => {
  const schema = 'facts_pay_test_' + randomUUID().replaceAll('-', '');
  let admin: pg.Client;
  let db: PostgresDb;
  let second: PostgresDb;
  let created = false;
  const student = { name: 'Synthetic student', cls: 'Test class', section: 'A' };
  const snapshot: Snapshot = { student, items: [] };
  const order = (): NewOrder => ({ orderId: randomUUID(), adm: 'TEST-1', student,
    pays: [{ id: 'tuition', paise: 10000 }], paise: 10000, snapshot, ttlMinutes: 15 });

  beforeAll(async () => {
    const url = new URL(uri!);
    for (const key of ['ssl','sslmode','sslcert','sslkey','sslrootcert']) url.searchParams.delete(key);
    admin = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: true,
      ca: readFileSync(new URL('../certs/supabase-ca.crt', import.meta.url), 'utf8') } });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
    await admin.query(`
      CREATE TABLE "${schema}".pay_order (
        order_id text PRIMARY KEY, adm_no text NOT NULL, student_name text, class text, section text, due_ids text,
        amount_paise int, payer_email text, payer_phone text, snapshot text, status text NOT NULL DEFAULT 'CREATED',
        receipt_no text UNIQUE, gateway_ref text, payment_mode text, created_at timestamptz DEFAULT clock_timestamp(),
        expires_at timestamptz, paid_at timestamptz, approved_at timestamptz, erp_receipt_no text);
      CREATE SEQUENCE "${schema}".pay_receipt_seq START 1001;
      CREATE TABLE "${schema}".fiscal_year(fiscal_year int, from_date timestamp);
      INSERT INTO "${schema}".fiscal_year VALUES (2026,'2000-01-01');
      CREATE TABLE "${schema}".acct(acct_code int, is_studentacct int);
      INSERT INTO "${schema}".acct VALUES(12,1);
      CREATE TABLE "${schema}".fee_charge_acct(fee_type_code text,dr_acct_code text);
      INSERT INTO "${schema}".fee_charge_acct VALUES('BUS','485');
      CREATE TABLE "${schema}".transport_routes(fee_code text);
      INSERT INTO "${schema}".transport_routes VALUES('BUS');
      CREATE TABLE "${schema}".students(student_code int, student_id text, student_name text, sub_acct_code text);
      INSERT INTO "${schema}".students VALUES(1,'TEST-1','Synthetic student','SYNTHETIC');
      CREATE TABLE "${schema}".student_curr_data(student_code int,class_code int,section_code text,academic_year int);
      INSERT INTO "${schema}".student_curr_data VALUES(1,1,'A',2026);
      CREATE TABLE "${schema}".classes(class_code int,class_name text);
      INSERT INTO "${schema}".classes VALUES(1,'Test class');
      CREATE TABLE "${schema}".sections(section_code text,section_name text);
      INSERT INTO "${schema}".sections VALUES('A','A');
      CREATE TABLE "${schema}".journal_doc(finance_year int,doc_type_code text,doc_no int,doc_date timestamp,jv_no text);
      INSERT INTO "${schema}".journal_doc VALUES(2026,'GJV_OB',1,'2026-04-01','OB-1'),(2026,'JV',2,'2026-04-02','JV-2'),
        (2026,'JV',3,'2026-07-01','JV-3'),(2026,'BR',4,'2026-07-02','BR-4');
      CREATE TABLE "${schema}".journal_tran(school_code text,finance_year int,doc_type_code text,doc_no int,
        sub_acct_code text,acct_code text,cr_dr text,amount numeric(18,2),narration text);
      INSERT INTO "${schema}".journal_tran VALUES('01',2026,'GJV_OB',1,'SYNTHETIC','12','Dr',1000,'Opening'),
        ('01',2026,'JV',2,'SYNTHETIC','12','Dr',2000,'ANNUAL charges'),
        ('01',2026,'JV',3,'SYNTHETIC','12','Dr',3000,'Monthly fee'),
        ('01',2026,'JV',3,'SYNTHETIC','12','Cr',100,'Concession'),
        ('01',2026,'JV',3,'SYNTHETIC','485','Dr',500,'Bus fare'),
        ('01',2026,'BR',4,'SYNTHETIC','12','Cr',1000,'Receipt');
      CREATE TABLE "${schema}".fee_receipt_doc(school_code text,finance_year int,doc_type_code text,doc_no int,
        doc_date timestamp,approved_by text,cr_no int);
      INSERT INTO "${schema}".fee_receipt_doc VALUES('01',2026,'FR',5,'2026-07-03','Accountant',0),
        ('01',2026,'FR',6,'2026-07-03','_Cancel',0);
      CREATE TABLE "${schema}".fee_receipt_tran(school_code text,finance_year text,doc_type_code text,doc_no int,
        sub_acct_code text,acct_code text,amount numeric(18,2),narration text);
      INSERT INTO "${schema}".fee_receipt_tran VALUES('01','2026','FR',5,'SYNTHETIC','12',250,'Unposted receipt'),
        ('01','2026','FR',6,'SYNTHETIC','12',999,'Cancelled receipt');`);
    db = new PostgresDb(uri!, schema, () => {});
    second = new PostgresDb(uri!, schema, () => {});
  }, 60_000);

  afterAll(async () => {
    await Promise.all([db?.close(), second?.close()]);
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  it('matches the ledger rules, paise, receipt subtraction, and oldest-first payment allocation', async () => {
    const result = await db.getDues('test-1');
    expect(result?.student).toEqual(student);
    expect(result?.items.map(i => [i.id,i.paise])).toEqual([['tuition',465000],['transport',50000]]);
    expect(result?.items[0]?.lines).toEqual([
      { label: 'Annual charges 2026-27 (balance)', paise: 175000 },
      { label: 'Jul 2026 tuition', paise: 290000 },
    ]);
    expect(result?.statement.reduce((s,e)=>s+e.chargedPaise-e.paidPaise,0)).toBe(515000);
    expect(await db.getDues("TEST-1' OR 1=1 --")).toBeNull();
    expect(await db.getDues('UNKNOWN')).toBeNull();
  });

  it('settles exactly once across independent pools and refuses replay, cancellation after payment, and expiry', async () => {
    const o = order(); await db.createOrder(o);
    const race = await Promise.allSettled([db.settleOrder(o.orderId,'synthetic','UPI'),second.settleOrder(o.orderId,'synthetic','UPI')]);
    expect(race.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const rejected = race.find(r=>r.status==='rejected') as PromiseRejectedResult;
    expect(rejected.reason.status).toBe(409);
    const paid = (race.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<unknown>).value;
    expect(paid).toMatchObject({ admNo: o.adm, paise: o.paise, snapshot });
    expect(await db.getUnapproved('test-1')).toMatchObject([{ paise: o.paise, pays: o.pays }]);
    await expect(db.failOrder(o.orderId)).rejects.toMatchObject({status:409});
    const expired=order(); expired.ttlMinutes=-1; await db.createOrder(expired);
    await expect(db.settleOrder(expired.orderId,'synthetic','UPI')).rejects.toMatchObject({status:409});
    await expect(db.settleOrder(randomUUID(),'synthetic','UPI')).rejects.toMatchObject({status:404});
  });

  it('keeps failed orders terminal and cancellation idempotent', async () => {
    const o=order(); await db.createOrder(o); await db.failOrder(o.orderId); await db.failOrder(o.orderId);
    await expect(db.settleOrder(o.orderId,'synthetic','UPI')).rejects.toMatchObject({status:409});
  });
});
