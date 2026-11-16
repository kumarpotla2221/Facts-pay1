import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
    trustCert: config.DB_TRUST_CERT === '1',
    onPoolError: (err, slug) => app.log.error({ err, school: slug }, 'school database connection error'),
  });
  const mailer = new Mailer(opts.mailTransport ?? (config.SMTP_URL ? nodemailer.createTransport(config.SMTP_URL) : undefined), config.MAIL_FROM, app.log);
  const payments = new Payments(schools, mailer);
  const payPage = readFileSync(publicDir + 'index.html');
  const demoSite = readFileSync(fileURLToPath(new URL('../demo-site/index.html', import.meta.url)), 'utf8');

  // Security headers. The pay page overrides frame-ancestors per school (below); everything else is not embeddable.
  await app.register(helmet, {
    frameguard: false,
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], baseUri: ["'none'"], formAction: ["'none'"], frameAncestors: ["'none'"] } },
  });
  await app.register(rateLimit, { max: 60, timeWindow: '1 minute' });
  await app.register(fastifyStatic, { root: publicDir, prefix: '/assets/', index: false });

  app.addHook('onSend', async (req, reply) => { if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store'); });

  app.get('/health', async () => ({ ok: true }));

  app.get('/', async (_req, reply) => {
    const school = schoolList[0];
    if (!school) throw new HttpError(503, 'School payments are temporarily unavailable.');
    return reply.redirect(`/pay/${school.slug}`);
  });

  // Hosted pay page. Only the school's own website(s) may iframe it (and the demo site below, which is this origin).
  app.get('/pay/:slug', async (req, reply) => {
    const school = schools.get((req.params as { slug: string }).slug);
    return reply
      .header('content-security-policy', `default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' ${school.origins.join(' ')}`)
      .type('text/html; charset=utf-8')
      .send(payPage);
  });

  // DEMO ONLY: a stand-in for the school's own website, framing the pay page the way the real site will.
  // Its CSP is looser than the pay page's because it uses a CDN stylesheet, web fonts and an embedded map.
  app.get('/view/:slug', async (req, reply) => {
    const { slug } = schools.get((req.params as { slug: string }).slug);
    return reply
      .header('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; "
        + "font-src https://cdnjs.cloudflare.com https://fonts.gstatic.com; script-src 'unsafe-inline'; frame-src 'self' https://www.google.com; img-src 'self' data:")
      .type('text/html; charset=utf-8')
      .send(demoSite.replace('__PAY_PAGE__', `/pay/${slug}`));
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
