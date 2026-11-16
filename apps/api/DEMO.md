# Presentation demo with school data

The hosted demo uses **`school_ranchi_full_demo`**, an independent copy of the migrated `school_ranchi` database.
All 13 app tables, including students, fee ledgers and existing payment records, are copied and verified.
Use your **existing school admission numbers**. The demo page does not suggest a synthetic student.

Checkout remains simulated. **Simulate success** changes only demo payment rows, and printed receipts say
**DEMO RECEIPT - No money was collected**. The `facts_pay_ranchi_full_demo` login cannot access the original
`school_ranchi` schema or update student records. Email delivery is not configured on this hosted demo.

## Copy the migrated data for a presentation

Configure `SUPABASE_PROJECT_REF` and `SUPABASE_MIGRATION_URL` privately as described in [SUPABASE.md](SUPABASE.md).
After the source migration is verified, run from `apps/api`:

```powershell
node --env-file=.env scripts/clone-school-demo.mjs
```

The script copies all 13 tables in one transaction, compares counts and complete row checksums, and creates
independent receipt numbering and a restricted login. Existing schemas, roles and credential files are never
overwritten. Import the generated, ignored `.env.supabase-school-demo` into the Vercel API project's Production
environment. **Remove `DEMO_ADMISSION`**, keep `MOCK_GATEWAY=1`, then redeploy.

To restore the presentation's starting balances, run as the Supabase administrator:

```sql
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM school_ranchi_full_demo._facts_pay_demo WHERE label='school-data-snapshot') THEN
    RAISE EXCEPTION 'Expected a school-data demo';
  END IF;
END $$;
TRUNCATE school_ranchi_full_demo.pay_order;
INSERT INTO school_ranchi_full_demo.pay_order
SELECT * FROM school_ranchi_full_demo._facts_pay_demo_pay_order_baseline;
COMMIT;
```

This restores only demo payments, including the original copied payment rows. Receipt numbering continues forward.
The original database stays unchanged. This is a snapshot; later source updates need an explicit refresh or new copy.

## Synthetic-student alternative

The separate `school_ranchi_demo` schema and `facts_pay_ranchi_demo` login contain three fictional students.
These admission numbers work only when that synthetic dataset is selected:

| Admission | Starting balance | Use |
| --- | --- | --- |
| `DEMO001` | Rs. 10,000 | Tuition, transport, previous-year and annual charges, partial payments |
| `DEMO002` | Rs. 3,000 | A second student for another walkthrough |
| `DEMO003` | Rs. 0 | Demonstrate the fully-paid state |

Open the payment page, enter a sample admission, click **Get fee details**, choose fees and amounts, and click
**Pay**. The mock panel offers **Simulate success** and **Simulate failure**. A simulated success creates a demo
receipt and reduces only that demo student's remaining balance. View/download the statement or print the receipt.
Email delivery requires a separately configured SMTP service and is not configured on this hosted demo.

## Create a fresh demo in Supabase

Configure `SUPABASE_PROJECT_REF` and `SUPABASE_MIGRATION_URL` in a private local environment as described in
[SUPABASE.md](SUPABASE.md). From `apps/api`:

```powershell
node --env-file=.env scripts/create-demo.mjs
```

This creates synthetic tables, a restricted login, and an ignored `.env.supabase-demo` file. Existing schemas,
roles, and private environment files are never overwritten. Import the generated settings into the Vercel API
project's Production environment, then redeploy. It sets `MOCK_GATEWAY=1` and `DEMO_ADMISSION=DEMO001`.
Keep the original production connection settings privately for restoring the migrated data later.

The demo keeps simulated payments between visits. To restore starting balances for another presentation,
run this as the Supabase administrator in the SQL Editor:

```sql
-- Only the synthetic demo payment table. No ERP or migrated school rows are changed.
DELETE FROM school_ranchi_demo.pay_order;
```

Before using the migrated school data again, set `MOCK_GATEWAY=0`, restore its restricted login and schema,
remove `DEMO_ADMISSION`, and redeploy. Integrate and verify a real payment gateway before accepting money.
