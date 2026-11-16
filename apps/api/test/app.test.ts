import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/create-app.js';
import { schools } from '../src/config.js';

describe('API workspace resources (no database)', () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await buildApp({ logger: false }); });
  afterAll(async () => { await app?.close(); });

  it('opens the first configured school from the deployment URL', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`/pay/${schools[0]!.slug}`);
  });

  it('serves health and bundled payment assets', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });

    const css = await app.inject({ method: 'GET', url: '/assets/pay.css' });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    expect(css.body.length).toBeGreaterThan(0);
  });

  it('serves the payment page and demo site using workspace school settings', async () => {
    const slug = schools[0]!.slug;
    const pay = await app.inject({ method: 'GET', url: `/pay/${slug}` });
    expect(pay.statusCode).toBe(200);
    expect(pay.headers['content-type']).toContain('text/html');

    const demo = await app.inject({ method: 'GET', url: `/view/${slug}` });
    expect(demo.statusCode).toBe(200);
    expect(demo.body).toContain(`/pay/${slug}`);
    expect(demo.body).not.toContain('__PAY_PAGE__');
  });
});
