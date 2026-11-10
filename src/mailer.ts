import { existsSync } from 'node:fs';
import type { FastifyBaseLogger } from 'fastify';
import type { Transporter } from 'nodemailer';
import { publicDir } from './config.js';
import { classOf, formatIst, inr, renderReceiptPdf, type Receipt } from './receipt-pdf.js';

/** Emails the PDF fee receipt to the payer. No transport (SMTP_URL unset) = emails disabled. */
export class Mailer {
  constructor(private transport: Pick<Transporter, 'sendMail'> | undefined, private from: string, private log: FastifyBaseLogger) {}

  get enabled() { return !!this.transport; }

  /**
   * Never rejects: the payment is already recorded in the school's DB, so a mail failure is only logged.
   * ponytail: no retry/outbox. Add a `receiptEmailedAt` column + retry job if delivery failures show up in logs.
   */
  async sendReceipt(to: string, r: Receipt): Promise<boolean> {
    if (!this.transport) return false;
    try {
      const pdf = await renderReceiptPdf(r);
      const logo = `${publicDir}schools/${r.school.slug}/logo.png`;
      const hasLogo = existsSync(logo);
      await this.transport.sendMail({
        from: this.from,
        to,
        replyTo: r.school.email ?? undefined,
        subject: `Fee receipt ${r.receiptNo} - ${r.school.name}`,
        text: `Dear parent,\n\nWe received ${inr(r.totalPaise)} for ${r.student.name} (adm. no. ${r.student.admNo}) on ${formatIst(r.paidAt)}.\n`
          + `Receipt no. ${r.receiptNo}. The receipt is attached as a PDF.\n\n${r.school.name}`,
        html: receiptHtml(r, hasLogo),
        attachments: [
          { filename: `Receipt-${r.receiptNo}.pdf`, content: pdf, contentType: 'application/pdf' },
          ...(hasLogo ? [{ filename: 'logo.png', path: logo, cid: 'school-logo' }] : []),   // inline in the email body
        ],
      });
      return true;
    } catch (err) {
      this.log.error({ err, receiptNo: r.receiptNo, orderId: r.orderId }, 'receipt email failed');
      return false;
    }
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);   // DB values go into HTML

function receiptHtml(r: Receipt, hasLogo: boolean): string {
  const row = (k: string, v: string) => `<tr><td style="padding:4px 0;color:#6b7280">${k}</td><td style="padding:4px 0;text-align:right;font-weight:600">${esc(v)}</td></tr>`;
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#1d2433">
  <div style="background:${esc(r.school.color)};color:#fff;padding:20px 24px;border-radius:10px 10px 0 0">
    ${hasLogo ? '<img src="cid:school-logo" alt="" height="36" style="display:block;max-width:100%;height:36px;width:auto;margin-bottom:10px;background:#fff;border-radius:6px;padding:4px 8px">' : ''}
    <div style="font-size:18px;font-weight:700">${esc(r.school.name)}</div>
    <div style="font-size:13px;opacity:.85">Fee payment received</div>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:0;padding:20px 24px;border-radius:0 0 10px 10px">
    <p style="margin:0 0 4px;color:#6b7280">Amount paid</p>
    <p style="margin:0 0 16px;font-size:26px;font-weight:700">${esc(inr(r.totalPaise))}</p>
    <table style="width:100%;font-size:14px;border-collapse:collapse">
      ${row('Receipt no.', r.receiptNo)}${row('Student', r.student.name)}${row('Admission no.', r.student.admNo)}${row('Class', classOf(r.student))}${row('Paid on', formatIst(r.paidAt))}
    </table>
    <p style="font-size:13px;color:#6b7280;margin:16px 0 0">Your receipt is attached as a PDF. Please keep it for your records.</p>
  </div>
</div>`;
}
