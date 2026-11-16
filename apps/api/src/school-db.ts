import sql from 'mssql';
import { PostgresDb } from './postgres-db.js';
import { HttpError } from './errors.js';

/**
 * Everything the API ever does in a school's database: the school's own dues query (schools-sql/<slug>.sql, read only)
 * and a few statements on our pay_order table (schools-sql/setup.sql). Nothing else is ever installed there, and the
 * login can write nothing but pay_order: nothing is ever written into the school's own records. Values are always
 * bound as typed parameters.
 */
export type Db = sql.ConnectionPool | PostgresDb;

export interface Student { name: string; cls: string; section: string }
/** One thing to pay, as the school's records have it. Integer paise, never floats. `lines` = display-only breakdown, sums to `paise`. */
export interface Due { id: string; type: 'fees' | 'transport'; label: string; paise: number; lines: { label: string; paise: number }[] }
/** One line of the student's statement for this academic year. A concession shows as a negative charge. */
export interface Entry { date: string; ref: string; label: string; chargedPaise: number; paidPaise: number }
export interface Dues { student: Student; items: Due[]; statement: Entry[] }
/** What the parent saw and agreed to: every due with the school's minimum, and `paying` = how much of it they pay now (0 = not now). */
export interface Snapshot { student: Student; items: (Due & { minPaise: number; paying: number })[] }

/** Due ids come from the school DB and travel in a comma list: letters, digits, _ and - only. */
export const ID_RE = /^[A-Za-z0-9_-]{1,20}$/;

/**
 * The student, their unpaid dues and their statement as the school's records have them, or null for an unknown
 * admission number. `duesSql` is the school's query, sent as is with @adm_no bound (contract: schools-sql/README.md).
 */
export async function getDues(db: Db, duesSql: string, adm: string): Promise<Dues | null> {
  if (db instanceof PostgresDb) return db.getDues(adm);
  const r = await db.request().input('adm_no', sql.VarChar(20), adm).query(duesSql);
  const [students, dues, lines, entries] = r.recordsets as unknown as [
    Student[],
    { due_id: string; type: Due['type']; label: string; amount_paise: number }[],
    { due_id: string; label: string; amount_paise: number }[],
    { date: Date; ref: string | null; label: string | null; charged_paise: number; paid_paise: number }[],
  ];
  const student = students[0];
  if (!student) return null;
  return {
    student: { name: student.name, cls: student.cls, section: student.section ?? '' },
    items: dues.map(d => ({
      id: d.due_id, type: d.type, label: d.label, paise: d.amount_paise,
      lines: lines.filter(l => l.due_id === d.due_id).map(l => ({ label: l.label, paise: l.amount_paise })),
    })),
    statement: entries.map(e => ({
      date: e.date.toISOString().slice(0, 10), ref: e.ref ?? '', label: e.label ?? '', chargedPaise: e.charged_paise, paidPaise: e.paid_paise,
    })),
  };
}

/** An online payment the school has not approved yet, so its own records still count the amount as owed. */
export interface Unapproved { receiptNo: string; paidAt: Date; mode: string; paise: number; pays: { id: string; paise: number }[] }
export async function getUnapproved(db: Db, adm: string): Promise<Unapproved[]> {
  if (db instanceof PostgresDb) return db.getUnapproved(adm);
  const r = await db.request().input('adm_no', sql.VarChar(20), adm)
    .query<{ receipt_no: string; paid_at: Date; payment_mode: string; due_ids: string; amount_paise: number }>(
      `SELECT receipt_no, paid_at, payment_mode, due_ids, amount_paise FROM pay_order
        WHERE adm_no = @adm_no AND status = 'PAID' AND approved_at IS NULL ORDER BY paid_at`);
  return r.recordset.map(o => ({
    receiptNo: o.receipt_no, paidAt: o.paid_at, mode: o.payment_mode, paise: o.amount_paise,
    pays: o.due_ids.split(',').map(pair => { const [id, paise] = pair.split('='); return { id: id!, paise: Number(paise) }; }),
  }));
}

export interface NewOrder {
  orderId: string; adm: string; student: Student; pays: { id: string; paise: number }[]; paise: number; email?: string; phone?: string;
  snapshot: Snapshot;    // printed on the receipt later
  ttlMinutes: number;
}
export async function createOrder(db: Db, o: NewOrder): Promise<void> {
  if (db instanceof PostgresDb) return db.createOrder(o);
  await db.request()
    .input('order_id', sql.VarChar(36), o.orderId)
    .input('adm_no', sql.VarChar(20), o.adm)
    .input('student_name', sql.NVarChar(100), o.student.name)
    .input('class', sql.VarChar(60), o.student.cls)
    .input('section', sql.VarChar(60), o.student.section)
    .input('due_ids', sql.VarChar(1000), o.pays.map(p => `${p.id}=${p.paise}`).join(','))   // 'tuition=150000,transport=90000'
    .input('amount_paise', sql.Int, o.paise)
    .input('payer_email', sql.VarChar(120), o.email ?? null)
    .input('payer_phone', sql.VarChar(15), o.phone ?? null)
    .input('snapshot', sql.NVarChar(sql.MAX), JSON.stringify(o.snapshot))
    .input('ttl_minutes', sql.Int, o.ttlMinutes)
    .query(`INSERT pay_order (order_id, adm_no, student_name, class, section, due_ids, amount_paise, payer_email, payer_phone, snapshot, expires_at)
            VALUES (@order_id, @adm_no, @student_name, @class, @section, @due_ids, @amount_paise, @payer_email, @payer_phone, @snapshot,
                    DATEADD(minute, @ttl_minutes, SYSUTCDATETIME()))`);
}

export interface PaidOrder { receiptNo: string; admNo: string; paise: number; payerEmail: string | null; snapshot: Snapshot }

/**
 * The payment succeeded at the gateway: the order becomes PAID with the next receipt number, once. One UPDATE does it,
 * so only one caller can ever win: a double click, a replay, an expired or a failed order matches no row and is refused.
 */
export async function settleOrder(db: Db, orderId: string, gatewayRef: string, mode: string): Promise<PaidOrder> {
  if (db instanceof PostgresDb) return db.settleOrder(orderId, gatewayRef, mode);
  const r = await db.request()
    .input('order_id', sql.VarChar(36), orderId)
    .input('gateway_ref', sql.VarChar(64), gatewayRef)
    .input('payment_mode', sql.VarChar(20), mode)
    .query<{ receipt_no: string | null; adm_no: string; amount_paise: number; payer_email: string | null; snapshot: string; status: string }>(`
      DECLARE @paid TABLE (receipt_no varchar(40), adm_no varchar(20), amount_paise int, payer_email varchar(120), snapshot nvarchar(max));
      UPDATE pay_order
         SET status = 'PAID', receipt_no = 'OL-' + CAST(NEXT VALUE FOR pay_receipt_seq AS varchar(12)),
             gateway_ref = @gateway_ref, payment_mode = @payment_mode, paid_at = SYSUTCDATETIME()
      OUTPUT inserted.receipt_no, inserted.adm_no, inserted.amount_paise, inserted.payer_email, inserted.snapshot INTO @paid
       WHERE order_id = @order_id AND status = 'CREATED' AND expires_at > SYSUTCDATETIME();
      -- One row: what was just paid (receipt_no set), or why not (receipt_no NULL, status says). No row: no such order.
      SELECT p.receipt_no, p.adm_no, p.amount_paise, p.payer_email, p.snapshot, o.status
        FROM pay_order o LEFT JOIN @paid p ON 1 = 1 WHERE o.order_id = @order_id`);
  const row = r.recordset[0];
  if (!row?.receipt_no) throw refusal(row?.status);
  return { receiptNo: row.receipt_no, admNo: row.adm_no, paise: row.amount_paise, payerEmail: row.payer_email, snapshot: JSON.parse(row.snapshot) as Snapshot };
}

/** The payment failed or was cancelled at the gateway. A CREATED order becomes FAILED. Refused (409) if it is already PAID. */
export async function failOrder(db: Db, orderId: string): Promise<void> {
  if (db instanceof PostgresDb) return db.failOrder(orderId);
  const r = await db.request().input('order_id', sql.VarChar(36), orderId).query<{ status: string }>(`
    UPDATE pay_order SET status = 'FAILED' WHERE order_id = @order_id AND status = 'CREATED';
    SELECT status FROM pay_order WHERE order_id = @order_id`);
  const status = r.recordset[0]?.status;
  if (status !== 'FAILED') throw refusal(status);   // a late "failed" must never be answered with "nothing was charged" for a PAID order
}

/** Why an order could not be settled or failed: expected outcomes with a message that is safe to show. */
const refusal = (status: string | undefined) =>
  status === undefined ? new HttpError(404, 'Order not found')
  : status === 'PAID' ? new HttpError(409, 'This order was already paid')
  : new HttpError(409, 'Order expired or not payable');
