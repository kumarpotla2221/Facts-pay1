# Facts Pay
Online school fee + transport fee payments for many schools, each with its own (customised) SQL Server database.
A school's website embeds one hosted pay page. This service reads the dues from that school's database, takes the payment,
records it in its own `pay_order` table inside that database (never in the school's own records) and emails the parent a PDF
fee receipt. The school validates and approves the payment from `pay_order` and creates its own records. A parent may pay part of a
due, by the school's own rule (Ranchi: at least half), and can see and download the year's statement.

## How a payment flows
    parent ─▶ school website ─iframe─▶ /pay/<slug>            the pay page (public/)
                                          │
                                          ▼  /api/<slug>/...   the API (src/)
                                 the school's own database     stored procedures (schools-sql/)

    1. lookup        pay_get_dues       the student, what they owe (and the least they may pay of each), the statement
                     pay_get_unapproved   minus online payments the school has not approved yet
    2. create order  pay_create_order   which dues and how much of each, checked against step 1, never trusted from the browser
    3. settle        pay_settle         marks the order PAID with a receipt number (OL-1001), the mode and the gateway ref;
                                        then the PDF receipt is emailed. The school approves the payment from pay_order.
There is **one database per school and nothing else**: no central database, no ORM, no migrations. The API keeps no state,
so you can run as many copies of it as you need.

## Project map
    src/                 the API (Fastify + TypeScript), read in this order:
      server.ts            starts it
      app.ts               wiring: security headers, rate limit, pay page, error handler
      routes.ts            HTTP: validates input, calls payments
      payments.ts          the flow: lookup -> createOrder -> settle
      school-db.ts         the only code that talks to a school database: the procedure calls
      schools.ts           slug -> school + its connection pool
      config.ts            env vars + schools.json, validated at startup
      mailer.ts, receipt-pdf.ts, statement-pdf.ts, errors.ts
    public/              the hosted pay page (plain HTML/CSS/JS). Branding: public/schools/<slug>/logo.png, hero.jpg
    schools.json         the schools we serve and how to reach each one's database
    schools-sql/         README.md = the database contract · common.sql = same for every school (pay_order + approval)
                         <slug>.sql = one per school, read only (ranchi.sql) · _template.sql = the empty shape to copy
    test/                pay.test.ts (integration, Ranchi DB) · receipt.test.ts (PDFs, no DB)
    tools/               db.ts = `npm run db:deploy` / `db:status` (installs and checks the SQL in the school databases)
                         DEV ONLY: restore-ranchi.sh (loads the Ranchi backup) · demo-students.sh
    demo-site/           DEV ONLY: stand-in for the school's own website

## Run everything (Docker)
    cp .env.example .env                            # replace every CHANGE_ME; SMTP_URL = your SMTP provider
    docker compose up -d mssql && sh tools/restore-ranchi.sh     # needs Node: it runs `npm run db:deploy`
    docker compose up --build -d
- School site (Ranchi)  http://localhost:5003   `sh tools/demo-students.sh` prints admission numbers that owe fees
- Pay page direct       http://localhost:4000/pay/ranchi
- Receipt emails go straight through `SMTP_URL` (enter a real address on the pay page). Empty = no emails.
- Stop: `docker compose down` (data kept) | wipe: `docker compose down -v`
- Reset test payments: re-run `sh tools/restore-ranchi.sh`

## The api on Heroku, the school site local
The api runs as a Docker image on Heroku (app `facts-pay`, https://facts-pay-8f54f64208f2.herokuapp.com). The school
site stays local and frames that: `node demo-site/serve.js` (or `PAY_URL=http://localhost:4000 node demo-site/serve.js`
to frame a local api). Heroku must be able to reach the school's SQL Server, so point `SCHOOL_DB_HOST` at it.

    heroku config:set -a facts-pay SCHOOL_DB_HOST=<sql server host> PAY_RANCHI_PASS=<web login password> \
      SMTP_URL='smtps://USER:PASS@smtp.provider.com:465' MAIL_FROM='Facts Pay <you@provider.com>'
    docker build --platform linux/amd64 -t registry.heroku.com/facts-pay/web . && docker push registry.heroku.com/facts-pay/web
    heroku container:release web -a facts-pay       # then: heroku logs --tail -a facts-pay
`MOCK_GATEWAY=1` is already set there; add `DB_TRUST_CERT=1` only if the SQL Server has a self-signed certificate.
The pay page only needs the school site's origin (`http://localhost:5003`) in schools.json, which it has.

## Develop without the api container
    docker compose up -d mssql                      # database only
    npm install && npm run dev                      # api on :4000 with reload
    npm test                                        # integration tests: PAYS one Ranchi student's dues
    npm run typecheck
To eyeball the PDF designs: `RECEIPT_OUT=/tmp/r.pdf STATEMENT_OUT=/tmp/s.pdf npx vitest run test/receipt.test.ts`.

## Onboard a new school (no API code)
Every school's database is different, so each school gets its own SQL file, always in the same shape.
1. Copy [schools-sql/_template.sql](schools-sql/_template.sql) to `schools-sql/<slug>.sql` and write its one read-only
   procedure against that school's tables ([schools-sql/README.md](schools-sql/README.md) is the contract,
   [ranchi.sql](schools-sql/ranchi.sql) a complete worked example).
2. Add the school to [schools.json](schools.json) with its `db` logins (passwords go in env) and, if parents may pay a due
   in parts, its `minPayPercent` (the least they may pay of each due; leave it out for full payment only).
3. `npm run db:deploy -- <slug>` installs the SQL in its database and checks it against the contract. Then create the
   web login there and `ALTER ROLE facts_pay_role ADD MEMBER <login>`. Restart the API.
4. Optional branding: `public/schools/<slug>/logo.png` (pay page, PDFs, email) and `hero.jpg`.
5. School website: `<iframe src="https://pay.yourdomain/pay/<slug>">`, plus the 3-line `message` listener from
   [demo-site/index.html](demo-site/index.html) so the iframe grows with its content (no inner scrollbar on phones).

## Keeping many school databases in step
    npm run db:status              # every school: its version, out of date?, edited by hand in the database?
    npm run db:deploy -- ranchi    # after changing SQL: deploy to ONE school and check it
    npm run db:deploy              # then all the others (stops at the first failure)
A deploy is one transaction per school and safe to repeat. It refuses a school file that breaks the contract and leaves
that database exactly as it was.

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
- **Database:** the API's login can run five procedures and nothing else: no table access, and nothing is ever written into
  the school's own records. The API never holds the SQL Server admin password.
- **Money:** every amount is checked against the school database when the order is made (each due still owed, each amount
  within the school's part-payment rule). `pay_settle` is one transaction that marks an order PAID exactly once, so a double
  click or a replay can never produce two receipts. Two orders made in different tabs before either is paid can both go
  through; the second becomes an overpayment the school sees when approving.
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
