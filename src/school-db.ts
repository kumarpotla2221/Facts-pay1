import sql from 'mssql';
import { HttpError } from './errors.js';

/**
 * Everything the API ever does in a school's database (contract: schools-sql/README.md): the school's own
 * pay_get_dues (read only) and the common pay_* procedures around the pay_order table (common.sql).
 * The web login can run these and nothing else: no table access, and nothing is ever written into the school's
 * own records. Values are always bound as typed parameters.
 */
export type Db = sql.ConnectionPool;

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

/** The student, their unpaid dues and their statement as the school's records have them, or null for an unknown admission number. */
export async function getDues(db: Db, adm: string): Promise<Dues | null> {
  const r = await db.request().input('adm_no', sql.VarChar(20), adm).execute('pay_get_dues');
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
  const r = await db.request().input('adm_no', sql.VarChar(20), adm)
    .execute<{ receipt_no: string; paid_at: Date; payment_mode: string; due_ids: string; amount_paise: number }>('pay_get_unapproved');
  return r.recordset.map(o => ({
    receiptNo: o.receipt_no, paidAt: o.paid_at, mode: o.payment_mode, paise: o.amount_paise,
    pays: o.due_ids.split(',').map(pair => { const [id, paise] = pair.split('='); return { id: id!, paise: Number(paise) }; }),
  }));
}

export async function createOrder(db: Db, o: {
  orderId: string; adm: string; student: Student; pays: { id: string; paise: number }[]; paise: number; email?: string; phone?: string;
  snapshot: Snapshot;    // printed on the receipt later
  ttlMinutes: number;
}): Promise<void> {
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
    .execute('pay_create_order');
}

export interface PaidOrder { receiptNo: string; admNo: string; paise: number; payerEmail: string | null; snapshot: Snapshot }

/** The payment succeeded at the gateway: the order becomes PAID with a receipt number, once. Only one caller can ever win. */
export async function settleOrder(db: Db, orderId: string, gatewayRef: string, mode: string): Promise<PaidOrder> {
  const r = await refusalsAsHttpErrors(() => db.request()
    .input('order_id', sql.VarChar(36), orderId)
    .input('gateway_ref', sql.VarChar(64), gatewayRef)
    .input('payment_mode', sql.VarChar(20), mode)
    .execute<{ receipt_no: string; adm_no: string; amount_paise: number; payer_email: string | null; snapshot: string }>('pay_settle'));
  const row = r.recordset[0]!;
  return { receiptNo: row.receipt_no, admNo: row.adm_no, paise: row.amount_paise, payerEmail: row.payer_email, snapshot: JSON.parse(row.snapshot) as Snapshot };
}

/** The payment failed or was cancelled at the gateway. A CREATED order becomes FAILED. Refused (409) if it is already PAID. */
export async function failOrder(db: Db, orderId: string): Promise<void> {
  await refusalsAsHttpErrors(() => db.request().input('order_id', sql.VarChar(36), orderId).execute('pay_fail_order'));
}

/** The procedures refuse with THROW <number>. These are expected outcomes with a message that is safe to show. */
const REFUSALS: Record<number, [status: number, message: string]> = {
  50010: [404, 'Order not found'],                      // ORDER_NOT_FOUND
  50011: [409, 'This order was already paid'],          // ORDER_ALREADY_PAID
  50012: [409, 'Order expired or not payable'],         // ORDER_NOT_PAYABLE
};
async function refusalsAsHttpErrors<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (err) {
    const refusal = REFUSALS[(err as { number?: number }).number ?? 0];
    if (refusal) throw new HttpError(...refusal);
    throw err;
  }
}
