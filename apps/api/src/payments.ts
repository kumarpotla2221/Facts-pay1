import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';
import type { Mailer } from './mailer.js';
import { inr } from './receipt-pdf.js';
import { createOrder, failOrder, getDues, getUnapproved, settleOrder, type Due, type Entry, type Snapshot, type Student } from './school-db.js';
import type { Schools } from './schools.js';

const ORDER_TTL_MINUTES = 15;

/** A due as the pay page sees it: with the school's part-payment rule applied (minPayPercent in schools.json). */
export type Payable = Due & { minPaise: number };
export interface Lookup { student: Student; items: Payable[]; statement: Entry[] }

const dateIst = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });   // YYYY-MM-DD

/** The payment flow: 1. lookup  2. createOrder  3. settle. All data lives in the school's own database. */
export class Payments {
  constructor(private schools: Schools, private mailer: Mailer) {}

  /** 1. The student, what they owe and their statement for the year. */
  async lookup(slug: string, adm: string): Promise<Lookup> {
    const school = this.schools.get(slug);
    const db = await this.schools.db(school);
    const dues = await getDues(db, school.duesSql, adm);
    if (!dues) throw new HttpError(404, 'No student found for this admission number');

    // Online payments the school has not approved yet: its records still count them as owed, so take them off here
    // and show them on the statement (the school's own system does the same with its not-yet-posted counter receipts).
    for (const p of await getUnapproved(db, adm)) {
      for (const { id, paise } of p.pays) {
        const due = dues.items.find(i => i.id === id);
        if (!due) continue;
        due.paise -= paise;
        let left = paise;                                   // the oldest charges count as paid first, like at the counter
        for (const line of due.lines) { const take = Math.min(line.paise, left); line.paise -= take; left -= take; }
        due.lines = due.lines.filter(l => l.paise > 0);
      }
      dues.statement.push({ date: dateIst(p.paidAt), ref: p.receiptNo, label: `Paid online (${p.mode})`, chargedPaise: 0, paidPaise: p.paise });
    }
    dues.statement.sort((a, b) => a.date.localeCompare(b.date));

    const items = dues.items.filter(i => i.paise > 0).map(i => ({ ...i, minPaise: Math.ceil(i.paise * school.minPayPercent / 100) }));
    return { ...dues, items };
  }

  /**
   * 2. The parent pressed "Pay". `pays` = which dues and how much of each. The browser is not trusted: every due
   * must still be owed, and each amount must follow the school's rule (from the due's minimum up to the whole due).
   */
  async createOrder(slug: string, adm: string, pays: { id: string; paise: number }[], payer: { email?: string; phone?: string } = {}) {
    const db = await this.schools.db(this.schools.get(slug));
    const { student, items } = await this.lookup(slug, adm);
    if (new Set(pays.map(p => p.id)).size !== pays.length) throw new HttpError(400, 'Invalid request');
    const snapshot: Snapshot = { student, items: items.map(i => ({ ...i, paying: 0 })) };
    for (const p of pays) {
      const due = snapshot.items.find(i => i.id === p.id);
      if (!due) throw new HttpError(409, 'Dues changed, please reload');
      if (p.paise < due.minPaise || p.paise > due.paise) throw new HttpError(400, `${due.label}: pay between ${inr(due.minPaise)} and ${inr(due.paise)}`);
      due.paying = p.paise;
    }
    const paise = pays.reduce((sum, p) => sum + p.paise, 0);

    const orderId = randomUUID();
    await createOrder(db, { orderId, adm, student, pays, paise, ...payer, snapshot, ttlMinutes: ORDER_TTL_MINUTES });
    return { orderId, paise };
  }

  /**
   * 3. The gateway reported the outcome, with its reference and how the parent paid (UPI, Card, ...). With a real
   * gateway this is called from its signature-verified webhook; MOCK_GATEWAY lets the browser call it directly.
   */
  async settle(slug: string, orderId: string, outcome: 'success' | 'fail', mode: string) {
    const school = this.schools.get(slug);
    const db = await this.schools.db(school);

    if (outcome === 'fail') {
      await failOrder(db, orderId);   // refuses (409) if the order is in fact already PAID
      throw new HttpError(402, 'Payment failed, nothing was charged');
    }

    const gatewayRef = `MOCK-${randomUUID().slice(0, 8)}`;
    // The order becomes PAID with a receipt number, once. A double click, a replay, an expired or a failed order is
    // refused (409). Nothing is written into the school's own records: the school approves the payment from pay_order.
    const paid = await settleOrder(db, orderId, gatewayRef, mode);

    const emailed = !!paid.payerEmail && this.mailer.enabled;
    if (emailed) {
      void this.mailer.sendReceipt(paid.payerEmail!, {   // in the background: the parent already sees the receipt on screen
        school, receiptNo: paid.receiptNo, orderId, gatewayRef, mode, paidAt: new Date(), totalPaise: paid.paise,
        student: { admNo: paid.admNo, ...paid.snapshot.student }, items: paid.snapshot.items,
      });
    }
    return { receiptNo: paid.receiptNo, paise: paid.paise, gatewayRef, emailed };
  }
}
