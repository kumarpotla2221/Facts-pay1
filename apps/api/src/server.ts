import Fastify from 'fastify';
import { buildApp } from './create-app.js';
import { config } from './config.js';

const app = await buildApp({ createServer: Fastify });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void app.close().finally(() => process.exit(0)));
// Vercel captures listen() and binds the server after this module finishes loading.
void app.listen({ port: config.PORT, host: '0.0.0.0' }).catch(error => {
  app.log.error(error);
  process.exit(1);
});
