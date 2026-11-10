# The school database contract

Every school's database is different, so every school has its own SQL file. To keep that from becoming a mess as
schools are added, three things are fixed:

1. **The API never changes per school.** In every school database it calls the same procedures, and the web login
   is allowed to do nothing else.
2. **A school file has one fixed shape**: one read-only procedure with an agreed input and output. Everything else is
   the same for all schools and already written, in [common.sql](common.sql).
3. **One command installs and checks it.** `npm run db:deploy` refuses a school file that breaks the contract;
   `npm run db:status` shows which school has which version.

**Facts Pay never writes into the school's own records.** Every online payment is a row in `pay_order` (common.sql);
the school validates and approves it and creates its own records from there.

| File | What is in it | How many |
|---|---|---|
| [common.sql](common.sql) | `pay_order`, `pay_create_order`, `pay_settle`, `pay_fail_order`, `pay_get_unapproved` | one, identical for every school |
| `<slug>.sql` | `pay_get_dues`, written against that school's own tables | one per school ([ranchi.sql](ranchi.sql)) |
| [_template.sql](_template.sql) | the empty shape of a school file | copy it to start a new school |

## What a school file must provide

### `pay_get_dues @adm_no varchar(20)` — read
Returns four result sets, in this order:

1. **student** — `name nvarchar, cls varchar, section varchar`. One row, or no row when the admission number is unknown.
2. **dues** — `due_id varchar(20)` (letters, digits, `_`, `-`), `type` (`'fees'` or `'transport'`), `label nvarchar`,
   `amount_paise int`. Unpaid dues only, as the school's records have them. (How much of a due may be paid at once is
   not the database's business: that is `minPayPercent` in schools.json, checked by the API.)
3. **lines** — `due_id, line_no int, label nvarchar(100), amount_paise int`. Optional display breakdown of a due
   (e.g. `Nov 2026 tuition`), ordered. The lines of a due must add up to its `amount_paise`. No breakdown = no rows.
4. **statement** — `date date, ref varchar, label nvarchar, charged_paise int, paid_paise int`. The student's
   account for this academic year, oldest first: every charge (a concession is a negative charge) and every
   payment. Over the whole statement `charged - paid` must equal what the student owes. The pay page shows it
   collapsed under the student's details, sums `paid_paise` into "Paid this academic year", and offers it as a PDF.

### Rules for a school file
- Only `CREATE OR ALTER`, so it can be deployed again at any time. Batches are separated by `GO` on its own line.
- Name every object `pay_...` (the status check watches those names). Read only: never write into the school's tables.
- How long the file is depends on the school's database. A school with a "fees due" table needs a few dozen lines.
  Ranchi is long because its ERP keeps ledger balances instead, and its file explains that step by step.

## What `common.sql` gives every school
- `pay_order` — one row per payment attempt: `CREATED` → `PAID` or `FAILED`. A PAID row holds everything the school
  needs to record the payment: admission number, student name, class, section, what was paid and how much of each,
  the amount, Facts Pay's receipt number (`OL-1001`, ...), the gateway's reference and the payment mode (UPI, Card, ...).
  Unpaid attempts older than 30 days are deleted automatically; paid orders are kept.
- `pay_settle` — in one transaction: lock the order, check it is `CREATED` and not expired, mark it `PAID` with the
  next receipt number. A double click, a replay, an expired or a failed order is refused.
- **Approval.** The school validates each PAID row, approves it and creates its own records (by hand or through its
  ERP's import), then marks the row: `UPDATE pay_order SET approved_at = SYSUTCDATETIME(), erp_receipt_no = '<their number>'
  WHERE receipt_no = 'OL-1001'`. Until then the school's records still count the amount as owed, so the pay page takes
  unapproved payments off the dues and lists them on the statement (`pay_get_unapproved`). After approval, the school's
  own records are trusted.
- `pay_deployment` — one row per deploy: the version that is installed.
- role `facts_pay_role` — `EXECUTE` on the five procedures the API calls. No table access.

## What the deploy checks
After installing the files, and before anything is kept, `npm run db:deploy` verifies that `pay_get_dues` runs and returns
the four result sets with the columns above. If not, the whole deploy is rolled back and the school's database is left
exactly as it was.

## Onboard a school
1. Copy [_template.sql](_template.sql) to `<slug>.sql` and write `pay_get_dues` for that school's tables.
2. Add the school to `schools.json` (its `db` logins; passwords go in env).
3. `npm run db:deploy -- <slug>`
4. Create the web login in that database and add it to the role: `ALTER ROLE facts_pay_role ADD MEMBER <login>`.
5. Agree with the school how PAID rows in `pay_order` are approved and recorded in its system, and who sets `approved_at`.
