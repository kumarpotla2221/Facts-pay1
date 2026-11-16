# Supabase database

The API supports the existing SQL Server database and a PostgreSQL copy in Supabase. For Ranchi, set
`PAY_RANCHI_DATABASE_URL` to use PostgreSQL. Without that variable, the existing SQL Server configuration applies.
The Expo app continues to call the API; database credentials belong only on the backend.

## Migrate a SQL Server backup

A SQL Server `.bak` cannot be restored directly into Supabase PostgreSQL. Restore it to local SQL Server first.
This repository's migration copies the **13 tables used by Facts Pay**, not the entire school ERP. It copies
all columns and rows in those tables. It does not install ERP procedures or alter the source database.

In the API workspace's ignored `.env`, configure the existing SQL Server login (`PAY_RANCHI_PASS` and
`schools.json`) and add:

```dotenv
SUPABASE_PROJECT_REF=your-project-reference
SUPABASE_MIGRATION_URL=postgresql://postgres.your-project-reference:ENCODED_DATABASE_PASSWORD@YOUR_SESSION_POOLER_HOST:5432/postgres
PAY_RANCHI_SCHEMA=school_ranchi
```

Copy the **Session pooler** URI from Supabase → Connect → Direct/connection string. Replace the password
placeholder with the database password, URL-encoding special characters. Keep this file private.
For a local SQL Server with a development certificate, also set `DB_TRUST_CERT=1`.

From `apps/api`, run:

```powershell
node --env-file=.env scripts/migrate-supabase.mjs
node --env-file=.env scripts/migrate-supabase.mjs --apply
```

The first command only checks connections and metadata. `--apply` creates a new private schema in one transaction.
It refuses to overwrite an existing schema. It checks every table's row count and a SHA-256 based checksum
covering every column of every row before committing, and preserves the next receipt sequence number.
An error rolls back the new schema. `_facts_pay_migration` records the verified counts and checksums.
The source should be a restored backup or otherwise held unchanged while copying.

The copied tables are `acct`, `classes`, `fee_charge_acct`, `fee_receipt_doc`, `fee_receipt_tran`, `fiscal_year`,
`journal_doc`, `journal_tran`, `pay_order`, `sections`, `student_curr_data`, `students`, and `transport_routes`.

This is a snapshot migration. Future changes in the school's SQL Server database require a separate synchronization
process. Updating ERP data should use an administrator/migration account, never the application's login.

## Connect the hosted API

Create a separate PostgreSQL login for the API. Grant it `USAGE` on the private school schema, `SELECT` on the
13 copied tables, `INSERT` on the new-order columns of `pay_order`, `UPDATE` on its payment-status columns,
and `USAGE` on `pay_receipt_seq`. Do not grant it writes to ERP tables or use the `postgres` migration account
as the application's login. Do not expose the schema through the Supabase Data API.

Use the Supabase **transaction pooler** (port `6543`) for Vercel. A custom role's pooler username is
`ROLE_NAME.PROJECT_REFERENCE`. In Vercel's API project (`apps/api`), set:

```dotenv
PAY_RANCHI_DATABASE_URL=postgresql://ROLE_NAME.PROJECT_REFERENCE:ENCODED_ROLE_PASSWORD@YOUR_POOLER_HOST:6543/postgres
PAY_RANCHI_SCHEMA=school_ranchi
TRUST_PROXY=1
MOCK_GATEWAY=0
```

Redeploy after saving the variables. Use Production for the production database; preview deployments should
have their own database/schema. Never prefix database credentials with `EXPO_PUBLIC_` or `NEXT_PUBLIC_`.

The adapter uses one connection per warm process, parameterized unnamed queries compatible with transaction
pooling, and verified TLS using `certs/supabase-ca.crt` (Supabase's public CA certificate, downloaded from
`https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`). PostgreSQL dues SQL is in
`schools-sql/ranchi.postgres.sql`; existing SQL Server SQL remains available in `ranchi.sql`.
Keep the app and Supabase in nearby regions for lower latency.

## Verify the adapter

Normal API tests skip the PostgreSQL integration suite. To run it, set `SUPABASE_TEST_URL` privately to an
administrator's Session pooler URI and run `npx vitest run test/postgres.test.ts` from `apps/api`.
It creates a unique temporary schema with synthetic school data, verifies fee calculations and racing payment
updates, then drops only that test schema. It never pays a real student's dues.
