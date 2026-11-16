# Facts Pay

This is the `@facts-pay/api` workspace. Install dependencies from the repository root with `npm install`. Paths and commands below are relative to `apps/api/` unless stated otherwise; root commands are listed in the [monorepo README](../../README.md).

For the new Vercel deployment, follow [VERCEL.md](VERCEL.md). Set the Vercel project Root Directory to `apps/api`; the Expo app is a separate native build.
Online school fee + transport fee payments for many schools, each with its own (customised) SQL Server database.
A school's website embeds one hosted pay page. This service reads the dues from that school's database, takes the payment,
records it in its own `pay_order` table inside that database (never in the school's own records) and emails the parent a PDF
fee receipt. The school validates and approves the payment from `pay_order` and creates its own records. A parent may pay part of a
due, by the school's own rule (Ranchi: at least half), and can see and download the year's statement.

## How a payment flows
    parent ─▶ school website ─iframe─▶ /pay/<slug>            the pay page (public/)   demo: /view/<slug> stands in for the website
                                          │
                                          ▼  /api/<slug>/...   the API (src/)
                                 the school's own database     one login: reads the school's tables, writes only pay_order

    1. lookup        schools-sql/<slug>.sql   the student, what they owe (and the least they may pay of each), the statement,
                                              minus online payments in pay_order the school has not approved yet
    2. create order  INSERT pay_order         which dues and how much of each, checked against step 1, never trusted from the browser
    3. settle        UPDATE pay_order         marks the order PAID with a receipt number (OL-1001), the mode and the gateway ref,
                                              exactly once; then the PDF receipt is emailed. The school approves the payment from pay_order.
There is **one database per school and nothing else**: no central database, no ORM, no migrations. Nothing is installed in a
school's database except the `pay_order` table ([schools-sql/setup.sql](schools-sql/setup.sql), run once by the school itself);
the dues query lives here, in this repository. The API keeps no state, so you can run as many copies of it as you need.

## Project map
    src/                 the API (Fastify + TypeScript), read in this order:
      server.ts            starts it
      create-app.ts        wiring: security headers, rate limit, pay page, error handler
      routes.ts            HTTP: validates input, calls payments
      payments.ts          the flow: lookup -> createOrder -> settle
      school-db.ts         the only code that talks to a school database: the dues query and the pay_order statements
      schools.ts           slug -> school + its connection pool
      config.ts            env vars, schools.json and each school's dues query, validated at startup
      mailer.ts, receipt-pdf.ts, statement-pdf.ts, errors.ts
    public/              the hosted pay page (plain HTML/CSS/JS). Branding: public/schools/<slug>/logo.png, hero.jpg
    schools.json         the schools we serve and how to reach each one's database
    schools-sql/         README.md = the database contract · setup.sql = what the school runs once (the login + pay_order)
                         <slug>.sql = the school's dues query, one per school (ranchi.sql) · _template.sql = the empty shape to copy
    test/                pay.test.ts (integration, Ranchi DB) · receipt.test.ts (PDFs, no DB)
    demo-site/           DEMO ONLY: stand-in for the school's own website, served by the api at /view/<slug>

## Run locally
The api runs on your machine; the database is the Heroku demo copy (see "On Heroku"), so no SQL Server is needed here.

    heroku config -a facts-pay --shell | grep -v '^MSSQL_' > .env   # the app's own settings (.env.example lists them)
    npm run dev                                                    # api on :4000 with reload
- School site (Ranchi)  http://localhost:4000/view/ranchi
- Pay page direct       http://localhost:4000/pay/ranchi
- Receipt emails go straight through `SMTP_URL` (enter a real address on the pay page). Empty = no emails.
- `npm test` runs API resource and PDF tests without connecting to SQL Server. `npm run test:integration` runs database tests: PAYS one student's dues in that database, then marks them approved so they come back. Use a disposable test database.
- `npm run typecheck`. To eyeball the PDF designs: `RECEIPT_OUT=/tmp/r.pdf STATEMENT_OUT=/tmp/s.pdf npx vitest run test/receipt.test.ts`.

## On Heroku
The api runs as a Docker image on Heroku (app `facts-pay`). The demo school site is https://facts-pay-8f54f64208f2.herokuapp.com/view/ranchi
and the pay page it frames is https://facts-pay-8f54f64208f2.herokuapp.com/pay/ranchi.

Run the following Docker build and release commands from the repository root, where the Dockerfile and workspace lockfile live.

    docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
      --output type=image,oci-mediatypes=false,push=true -t registry.heroku.com/facts-pay/web .
    heroku container:release web -a facts-pay       # then: heroku logs --tail -a facts-pay
(Heroku's registry refuses the OCI manifest Docker Desktop produces by default, hence the flags.)

**The demo database on Heroku.** Heroku cannot reach a SQL Server on your laptop, so the app has the `mssql` add-on
(Softtrends, an Azure SQL Database, Basic tier). It holds a copy of just the 12 Ranchi tables that the dues query reads,
copied with `bcp` from the local restore (an Azure SQL Database cannot restore a `.bak`), plus our `pay_order` table, its
receipt sequence and two demo-only indexes on `sub_acct_code`. The add-on chooses the server, database name and login
(`heroku config:get MSSQL_TCP_URL -a facts-pay`); they are the `db` entry in schools.json and its password is `PAY_RANCHI_PASS`.
That one login owns the whole demo database (fine for a demo copy; a real school creates the login with setup.sql).

    heroku config:set -a facts-pay PAY_RANCHI_PASS=<pw> SMTP_URL='smtps://USER:PASS@smtp.provider.com:465' MAIL_FROM='...' MOCK_GATEWAY=1
For the real school, `db` in schools.json points at its own SQL Server and the login that setup.sql created there.

## Onboard a new school (no API code)
Every school's database is different, so each school gets its own dues query, always in the same shape.
1. Get a copy of the school's database. Copy [schools-sql/_template.sql](schools-sql/_template.sql) to `schools-sql/<slug>.sql`
   and write the dues query against the school's tables ([schools-sql/README.md](schools-sql/README.md) is the contract,
   [ranchi.sql](schools-sql/ranchi.sql) a complete worked example).
2. The school runs [schools-sql/setup.sql](schools-sql/setup.sql) once, as its own administrator: it creates the `pay_order`
   table and one login that can read the school's tables and write only `pay_order`. No administrator login is ever given
   to Facts Pay.
3. Add the school to [schools.json](schools.json) with its `db`; the password is the env var `PAY_<SLUG>_PASS`. If parents
   may pay a due in parts, its `minPayPercent` (the least they may pay of each due; leave it out for full payment only).
   Restart the API.
4. Optional branding: `public/schools/<slug>/logo.png` (pay page, PDFs, email) and `hero.jpg`.
5. School website: `<iframe src="https://pay.yourdomain/pay/<slug>">`, plus the 3-line `message` listener from
   [demo-site/index.html](demo-site/index.html) so the iframe grows with its content (no inner scrollbar on phones).
   Until then, `/view/<slug>` on the api is a stand-in for the school's website (it shows Ranchi's branding).

## Ranchi (Metas ERP backup)
The ERP is ledger-based: dues = outstanding **tuition** and **transport** balances, computed exactly like the school's own
queries (`database_backup/Queries for Ranchi School Fee.txt`). Nothing is written into the ERP: a paid order waits in
`pay_order` until the school approves it, records it as a normal `FR` receipt and sets `approved_at`; until then the pay page
takes it off the dues itself. A parent may pay at least half of each due (`minPayPercent` in schools.json).
[ranchi.sql](schools-sql/ranchi.sql) explains it step by step.

**No second factor yet:** lookup is by admission number only. This backup cannot support one today: only 1148 of the 2508
students have a real date of birth (the rest hold placeholders such as `2000-01-01` x270 or admission dates) and only 204 have a
parent mobile number. So date of birth and OTP both need the school to clean its data first; a personal pay link does not.

## Security (what is in place)
- **Database:** one login per school, created by the school itself with [setup.sql](schools-sql/setup.sql): it can read the
  school's tables and write only `pay_order`. SQL Server enforces that nothing is ever written into the school's own records.
  No administrator login is ever given to Facts Pay, and nothing of ours is installed in the database but that table.
- **Money:** every amount is checked against the school database when the order is made (each due still owed, each amount
  within the school's part-payment rule). Settling is one `UPDATE` that marks an order PAID exactly once, so a double click
  or a replay can never produce two receipts. Two orders made in different tabs before either is paid can both go through;
  the second becomes an overpayment the school sees when approving.
- **Lookup:** admission number only, sent in a POST body (never a URL). Lookups and new orders are each limited to 30 per IP
  per 10 minutes.
- **Browser:** strict CSP, only the school's own origins may iframe the page, DB values rendered as text only, global rate limit.
- **Data:** `database_backup/` is excluded from git and from the Docker image.

## Before production
- A real payment gateway: call `payments.settle()` from its signature-verified webhook (with its reference and payment mode)
  and set `MOCK_GATEWAY=0`.
- Agree with each school how PAID rows in `pay_order` are approved and recorded in its system, and who sets `approved_at`.
- A 2nd factor on lookup (a personal signed pay link sent by the school, or OTP once parent mobiles are in the ERP).
- HTTPS + `TRUST_PROXY=1`, real DB certificates (`DB_TRUST_CERT=0`), secrets in a secret manager.
- A real SMTP provider in `SMTP_URL` (with SPF/DKIM for the `MAIL_FROM` domain).
- More than one API copy: move the rate-limit counters to a shared store (they are in memory per copy).

## Mobile app

The React Native Android/iOS app is the sibling [mobile workspace](../mobile/README.md) at `apps/mobile/`. From the repository root, run `npm run dev:api` and `npm run dev:mobile` in separate terminals. Real gateway integration is pending; mobile checkout is disabled by default.
