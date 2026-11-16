import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { HttpError } from './errors.js';
import type { Payments } from './payments.js';
import { ID_RE } from './school-db.js';
import type { Schools } from './schools.js';
import { renderStatementPdf } from './statement-pdf.js';

// The HTTP layer: validate the input, call a service, return its result. No business rules here.
const slugP = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,50}$/) });
// The admission number travels in the POST body only: never in a URL (URLs end up in access logs).
const lookupB = z.object({ adm: z.string().regex(/^[A-Za-z0-9/_-]{1,20}$/) });
const orderB = lookupB.extend({
  pays: z.array(z.object({ id: z.string().regex(ID_RE), paise: z.int32().positive() })).min(1).max(20),   // which dues, how much of each
  email: z.email().max(120).optional(),
  phone: z.string().regex(/^\+?[0-9]{10,14}$/).optional(),
});
const settleP = slugP.extend({ orderId: z.uuid() });
const settleB = z.object({ outcome: z.enum(['success', 'fail']), mode: z.string().regex(/^[A-Za-z][A-Za-z ]{0,19}$/).default('Online') });   // mode: UPI, Card, ...

export function payRoutes(app: FastifyInstance, deps: { payments: Payments; schools: Schools; config: Config }) {
  const { payments, schools, config } = deps;

  /** What the pay page needs to brand itself. */
  app.get('/api/:slug/info', async req => {
    const s = schools.get(slugP.parse(req.params).slug);
    return { name: s.name, color: s.color, address: s.address, phone: s.phone, email: s.email, website: s.origins[0] ?? null };
  });

  // The admission number is the only check (no second factor yet), so the routes that reveal something about a
  // student get a tighter per-IP limit than the global one: it slows down someone walking through admission
  // numbers to collect names and dues (an order reveals the amount owed, and adds a row to the school's database).
  const perStudentLimit = { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } };

  app.post('/api/:slug/dues', perStudentLimit, async req => {
    const { slug } = slugP.parse(req.params);
    return payments.lookup(slug, lookupB.parse(req.body).adm);
  });

  /** The student's statement for the year as a PDF (the same data the lookup returns). */
  app.post('/api/:slug/statement', perStudentLimit, async (req, reply) => {
    const { slug } = slugP.parse(req.params);
    const { adm } = lookupB.parse(req.body);
    const pdf = await renderStatementPdf({ school: schools.get(slug), adm, ...await payments.lookup(slug, adm) });
    return reply.type('application/pdf').send(pdf);
  });

  app.post('/api/:slug/orders', perStudentLimit, async req => {
    const { slug } = slugP.parse(req.params);
    const { adm, pays, email, phone } = orderB.parse(req.body);
    return payments.createOrder(slug, adm, pays, { email, phone });
  });

  // MOCK gateway only. A real gateway calls a signature-verified webhook that ends in the same payments.settle().
  app.post('/api/:slug/orders/:orderId/pay', async req => {
    if (config.MOCK_GATEWAY !== '1') throw new HttpError(403, 'Mock gateway disabled');
    const { slug, orderId } = settleP.parse(req.params);
    const { outcome, mode } = settleB.parse(req.body);
    return payments.settle(slug, orderId, outcome, mode);
  });
}
