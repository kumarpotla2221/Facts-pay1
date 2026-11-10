import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import nodemailer, { type Transporter } from 'nodemailer';
import { ZodError } from 'zod';
import { config, publicDir, schools as schoolList } from './config.js';
import { HttpError } from './errors.js';
import { Mailer } from './mailer.js';
import { Payments } from './payments.js';
import { payRoutes } from './routes.js';
import { Schools } from './schools.js';

/** Builds the whole server. Tests pass a fake mail transport; everything else comes from config. */
export async function buildApp(opts: { logger?: boolean; mailTransport?: Pick<Transporter, 'sendMail'> } = {}) {
  const app = Fastify({ logger: opts.logger === false ? false : { level: config.LOG_LEVEL }, bodyLimit: 4096, trustProxy: config.TRUST_PROXY === '1' });

  const schools = new Schools(schoolList, {
    dbHostOverride: config.SCHOOL_DB_HOST, trustCert: config.DB_TRUST_CERT === '1',
    onPoolError: (err, slug) => app.log.error({ err, school: slug }, 'school database connection error'),
  });
  const mailer = new Mailer(opts.mailTransport ?? (config.SMTP_URL ? nodemailer.createTransport(config.SMTP_URL) : undefined), config.MAIL_FROM, app.log);
  const payments = new Payments(schools, mailer);
  const payPage = readFileSync(publicDir + 'index.html');

  // Security headers. The pay page overrides frame-ancestors per school (below); everything else is not embeddable.
  await app.register(helmet, {
    frameguard: false,
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], baseUri: ["'none'"], formAction: ["'none'"], frameAncestors: ["'none'"] } },
  });
  await app.register(rateLimit, { max: 60, timeWindow: '1 minute' });
  await app.register(fastifyStatic, { root: publicDir, prefix: '/assets/', index: false });

  app.addHook('onSend', async (req, reply) => { if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store'); });

  app.get('/health', async () => ({ ok: true }));

  // Hosted pay page. Only the school's own website(s) may iframe it.
  app.get('/pay/:slug', async (req, reply) => {
    const school = schools.get((req.params as { slug: string }).slug);
    return reply
      .header('content-security-policy', `default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${school.origins.join(' ') || "'none'"}`)
      .type('text/html; charset=utf-8')
      .send(payPage);
  });

  payRoutes(app, { payments, schools, config });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Invalid request' });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: status === 429 ? 'Too many requests, slow down' : 'Invalid request' });
    req.log.error(err); // details to the log only, never to the client
    return reply.code(500).send({ error: 'Something went wrong, please try again' });
  });

  app.addHook('onClose', async () => { await schools.close(); });
  return app;
}
