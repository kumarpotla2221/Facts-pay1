import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { config, schools as schoolList } from '../src/config.js';
import { HttpError } from '../src/errors.js';
import type { Payments } from '../src/payments.js';
import { payRoutes } from '../src/routes.js';
import { Schools } from '../src/schools.js';

function appWithCheckout(mock: '0' | '1') {
  const app = Fastify({ logger: false });
  const payments = {
    lookup: vi.fn().mockResolvedValue({ student: { name: 'Synthetic student', cls: 'I', section: 'A' }, items: [], statement: [] }),
    createOrder: vi.fn().mockResolvedValue({ orderId: '00000000-0000-4000-8000-000000000001', paise: 10000 }),
    settle: vi.fn(),
  };
  const schools = new Schools(schoolList, { trustCert: false, onPoolError: () => {} });
  payRoutes(app, { payments: payments as unknown as Payments, schools, config: { ...config, MOCK_GATEWAY: mock, DEMO_ADMISSION: 'DEMO001' } });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message });
    return reply.code(500).send({ error: 'Unexpected test error' });
  });
  return { app, payments };
}

describe('checkout availability', () => {
  const slug = schoolList[0]!.slug;
  const payload = { adm: 'TEST-1', pays: [{ id: 'tuition', paise: 10000 }] };

  it('announces unavailable checkout and refuses to create orders or settle payments before reaching the database', async () => {
    const { app, payments } = appWithCheckout('0');
    try {
      const info = await app.inject({ method: 'GET', url: `/api/${slug}/info` });
      expect(info.json().checkout).toMatchObject({ mode: 'unavailable' });
      expect(info.json().checkout.demoAdmission).toBeUndefined();
      const order = await app.inject({ method: 'POST', url: `/api/${slug}/orders`, payload });
      expect(order.statusCode).toBe(503);
      expect(order.json().error).toContain('school fee counter');
      expect(payments.createOrder).not.toHaveBeenCalled();
      const paid = await app.inject({ method: 'POST', url: `/api/${slug}/orders/00000000-0000-4000-8000-000000000001/pay`,
        payload: { outcome: 'success', mode: 'UPI' } });
      expect(paid.statusCode).toBe(403);
      expect(payments.settle).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('keeps fee lookup and PDF statements available while checkout is unavailable', async () => {
    const { app, payments } = appWithCheckout('0');
    try {
      const dues = await app.inject({ method: 'POST', url: `/api/${slug}/dues`, payload: { adm: payload.adm } });
      expect(dues.statusCode).toBe(200);
      const statement = await app.inject({ method: 'POST', url: `/api/${slug}/statement`, payload: { adm: payload.adm } });
      expect(statement.statusCode).toBe(200);
      expect(statement.rawPayload.subarray(0,5).toString()).toBe('%PDF-');
      expect(payments.lookup).toHaveBeenCalledWith(slug, payload.adm);
    } finally { await app.close(); }
  });

  it('allows explicitly enabled demo checkout', async () => {
    const { app, payments } = appWithCheckout('1');
    try {
      const info = await app.inject({ method: 'GET', url: `/api/${slug}/info` });
      expect(info.json().checkout).toMatchObject({ mode: 'demo', demoAdmission: 'DEMO001' });
      const order = await app.inject({ method: 'POST', url: `/api/${slug}/orders`, payload });
      expect(order.statusCode).toBe(200);
      expect(payments.createOrder).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });
});
