# Presentation demo

The hosted demo uses the private `school_ranchi_demo` schema, with synthetic students and a separate
`facts_pay_ranchi_demo` login. This login cannot access the migrated `school_ranchi` data. No payment gateway
or real money is involved. The page labels checkout and printed receipts as a demo.

Sample admission numbers:

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
