# Deploy the web payment page and API to Vercel

Deploy the `apps/api` workspace first. It serves both the web payment page and the Fastify API. The Expo Android/iOS app is built separately and calls this API over HTTPS.

## Import from GitHub

1. In Vercel, select **Add New > Project** and import `kumarpotla2221/Facts-pay1`.
2. Set **Root Directory** to `apps/api`. Use the outer monorepo's workspace, rather than the separate nested `facts-pay/` checkout.
3. Select the **Fastify** framework preset. Keep access to source files outside the Root Directory enabled so npm can use the root workspace manifest and lockfile.
4. Select **Node.js 24.x**. The committed `vercel.json` supplies the install and build commands; leave Output Directory at its framework default.
5. Add the environment variables below and deploy.

| Variable | Initial value |
| --- | --- |
| `TRUST_PROXY` | `1` |
| `MOCK_GATEWAY` | `0` |
| `DB_TRUST_CERT` | `0` |
| `LOG_LEVEL` | `info` |

Database credentials and SMTP credentials are not needed to render the page or pass the health check. Keep them unset during this first deployment. Local `.env` files are not committed or uploaded as configuration; add real credentials through Vercel's Environment Variables settings when needed.

The API has one startup entrypoint, `src/server.ts`, which imports Fastify directly so Vercel can detect it. `src/create-app.ts` contains the app factory used by the server and tests. Use the native Fastify preset without a `functions` override: Vercel CLI 65.14 rejects these overrides with an `unused_function` error before building the app. Runtime files are included through Vercel's file tracing; `config.ts` exposes the public asset directory to that tracer. The root and API manifests pin Node.js 24.x so a broad version range cannot override the selected runtime.

Vercel supports [Fastify applications](https://vercel.com/docs/frameworks/backend/fastify) and [npm workspaces monorepos](https://vercel.com/docs/monorepos). The Dockerfile is for container hosts; Vercel uses this workspace's Fastify configuration.

## Check the first deployment

Open these paths on the deployment's HTTPS URL:

- `/` redirects to the first school configured in `schools.json`.
- `/health` returns `{"ok":true}`. This checks the application process, not the database.
- `/pay/ranchi` displays the payment page.
- `/view/ranchi` displays the demo school website.
- `/api/ranchi/info` returns school branding without connecting to the database.

Student lookup, statements, orders, and payments remain unavailable until a reachable database is configured. The current SQL Server address `127.0.0.1` refers to the Vercel function itself after deployment; it cannot reach SQL Server on your laptop.

## Connect Supabase in the next phase

Supabase uses PostgreSQL. This API currently uses the `mssql` driver and T-SQL, so adding a Supabase URL alone will not connect it. The next phase is to migrate the restored school database, convert the database adapter and queries, and verify balances and payment settlement against PostgreSQL. Store the resulting connection credentials only in backend environment variables.

After the API is connected and verified, set `EXPO_PUBLIC_API_URL=https://YOUR-PROJECT.vercel.app` in `apps/mobile/.env`, then restart Expo or rebuild the installed app. Keep database credentials out of the mobile environment.

The current checkout is still a demo payment implementation. Real payment gateway integration is required before taking live payments. The API's in-memory rate limits are per function instance; use shared rate limiting or platform controls before opening payment endpoints to production traffic.
