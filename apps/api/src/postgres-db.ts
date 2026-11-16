import { readFileSync } from 'node:fs';
import pg from 'pg';
import { HttpError } from './errors.js';
import type { Dues, NewOrder, PaidOrder, Snapshot, Unapproved } from './school-db.js';

const duesQuery = readFileSync(new URL('../schools-sql/ranchi.postgres.sql', import.meta.url), 'utf8');
const ca = readFileSync(new URL('../certs/supabase-ca.crt', import.meta.url), 'utf8');

/** A private PostgreSQL schema, accessed only by the backend. No session state or named prepared statements. */
export class PostgresDb {
  readonly pool: pg.Pool;
  readonly schema: string;

  constructor(connectionString: string, schema: string, onError: (err: Error) => void) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid PostgreSQL school schema');
    this.schema = `"${schema}"`;
    let uri: URL;
    try { uri = new URL(connectionString); } catch { throw new Error('Invalid school PostgreSQL connection URI'); }
    if (!['postgres:', 'postgresql:'].includes(uri.protocol)) throw new Error('School database must use a PostgreSQL URI');
    // pg's URI SSL options override the explicit TLS object. Always verify both CA and hostname.
    for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert']) uri.searchParams.delete(key);
    this.pool = new pg.Pool({ connectionString: uri.toString(), ssl: { ca, rejectUnauthorized: true },
      max: 1, connectionTimeoutMillis: 15_000, idleTimeoutMillis: 20_000, statement_timeout: 30_000,
      application_name: 'FactsPay' });
    this.pool.on('error', onError);
  }

  async getDues(adm: string): Promise<Dues | null> {
    const r = await this.pool.query<{ dues: Dues | null }>(duesQuery.replaceAll('{{schema}}', this.schema), [adm]);
    return r.rows[0]?.dues ?? null;
  }

  async getUnapproved(adm: string): Promise<Unapproved[]> {
    const r = await this.pool.query(`SELECT receipt_no, paid_at, payment_mode, amount_paise, due_ids
      FROM ${this.schema}.pay_order WHERE lower(btrim(adm_no)) = lower(btrim($1))
      AND status = 'PAID' AND approved_at IS NULL ORDER BY paid_at`, [adm]);
    return r.rows.map(o => ({ receiptNo: o.receipt_no, paidAt: o.paid_at, mode: o.payment_mode, paise: o.amount_paise,
      pays: o.due_ids.split(',').map((pair: string) => { const [id, paise] = pair.split('='); return { id: id!, paise: Number(paise) }; }) }));
  }

  async createOrder(o: NewOrder): Promise<void> {
    await this.pool.query(`INSERT INTO ${this.schema}.pay_order
      (order_id, adm_no, student_name, class, section, due_ids, amount_paise, payer_email, payer_phone, snapshot, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp() + $11 * interval '1 minute')`,
    [o.orderId, o.adm, o.student.name, o.student.cls, o.student.section, o.pays.map(p=>`${p.id}=${p.paise}`).join(','),
      o.paise, o.email ?? null, o.phone ?? null, JSON.stringify(o.snapshot), o.ttlMinutes]);
  }

  async settleOrder(orderId: string, gatewayRef: string, mode: string): Promise<PaidOrder> {
    // A guarded row UPDATE takes a lock. Concurrent retries recheck status and cannot issue another receipt.
    const r = await this.pool.query(`UPDATE ${this.schema}.pay_order SET status = 'PAID',
      receipt_no = 'OL-' || nextval('${this.schema}.pay_receipt_seq'), gateway_ref = $2,
      payment_mode = $3, paid_at = clock_timestamp()
      WHERE order_id = $1 AND status = 'CREATED' AND expires_at > clock_timestamp()
      RETURNING receipt_no, adm_no, amount_paise, payer_email, snapshot`, [orderId, gatewayRef, mode]);
    const row = r.rows[0];
    if (!row) throw await this.refusal(orderId);
    return { receiptNo: row.receipt_no, admNo: row.adm_no, paise: row.amount_paise, payerEmail: row.payer_email,
      snapshot: JSON.parse(row.snapshot) as Snapshot };
  }

  async failOrder(orderId: string): Promise<void> {
    const r = await this.pool.query(`UPDATE ${this.schema}.pay_order SET status = 'FAILED'
      WHERE order_id = $1 AND status = 'CREATED' RETURNING status`, [orderId]);
    if (r.rowCount) return;
    const status = await this.status(orderId);
    if (status !== 'FAILED') throw statusError(status);
  }

  private async status(orderId: string): Promise<string | undefined> {
    const r = await this.pool.query(`SELECT status FROM ${this.schema}.pay_order WHERE order_id = $1`, [orderId]);
    return r.rows[0]?.status;
  }
  private async refusal(orderId: string): Promise<HttpError> { return statusError(await this.status(orderId)); }
  async close(): Promise<void> { await this.pool.end(); }
}

function statusError(status?: string): HttpError {
  return status === undefined ? new HttpError(404, 'Order not found')
    : status === 'PAID' ? new HttpError(409, 'This order was already paid')
    : new HttpError(409, 'Order expired or not payable');
}
