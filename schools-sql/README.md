# The school database contract

Every school's database is different, so every school has its own SQL file. To keep that from becoming a mess as
schools are added, three things are fixed:

1. **The API never changes per school.** It runs the school's dues query and the same few `pay_order` statements
   everywhere ([src/school-db.ts](../src/school-db.ts)), and the school's login is allowed to do nothing else.
2. **A school file has one fixed shape**: one read-only query with an agreed input and output.
3. **Nothing is installed in the school's database** except our `pay_order` table ([setup.sql](setup.sql), which the
   school runs once). The query stays here and is sent as is, so changing it means deploying the API and nothing in
   any database.

**Facts Pay never writes into the school's own records.** Every online payment is a row in `pay_order`; the school
validates and approves it and creates its own records from there. SQL Server enforces it: the login can write nothing else.

| File | What is in it | How many |
|---|---|---|
| [setup.sql](setup.sql) | the login, `pay_order`, `pay_receipt_seq`. The school runs it once, as its own administrator | one, identical for every school |
| `<slug>.sql` | the dues query, written against that school's own tables | one per school ([ranchi.sql](ranchi.sql)) |
| [_template.sql](_template.sql) | the empty shape of a school file | copy it to start a new school |

## What a school file must provide

### The dues query, with `@adm_no varchar(20)` — read
One batch (no `GO`, no `CREATE`, no `USE`; table variables are fine), sent as is with the admission number bound as
`@adm_no`. Start with `SET NOCOUNT ON`. Returns four result sets, in this order:

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
- Read only: never write into the school's tables (the login could not anyway).
- How long the file is depends on the school's database. A school with a "fees due" table needs a few dozen lines.
  Ranchi is long because its ERP keeps ledger balances instead, and its file explains that step by step.

## What `setup.sql` gives every school
- login `facts_pay` — `db_datareader`, plus `SELECT, INSERT, UPDATE` on `pay_order` and `UPDATE` on the sequence.
  Nothing else: it cannot write into any other table, and it holds no administrator rights.
- `pay_order` — one row per payment attempt: `CREATED` → `PAID` or `FAILED`. A PAID row holds everything the school
  needs to record the payment: admission number, student name, class, section, what was paid and how much of each,
  the amount, Facts Pay's receipt number (`OL-1001`, ...), the gateway's reference and the payment mode (UPI, Card, ...).
  Unpaid attempts are kept too (the login may not delete); they are small.
- `pay_receipt_seq` — the receipt numbers. Settling is one `UPDATE` in the API: it marks an order `PAID` with the next
  number only while the order is `CREATED` and not expired, so a double click, a replay, an expired or a failed order is refused.
- **Approval.** The school validates each PAID row, approves it and creates its own records (by hand or through its
  ERP's import), then marks the row: `UPDATE pay_order SET approved_at = SYSUTCDATETIME(), erp_receipt_no = '<their number>'
  WHERE receipt_no = 'OL-1001'`. Until then the school's records still count the amount as owed, so the pay page takes
  unapproved payments off the dues and lists them on the statement. After approval, the school's own records are trusted.

## Onboard a school
1. Get a copy of the school's database. Copy [_template.sql](_template.sql) to `<slug>.sql` and write the dues query
   for that school's tables.
2. The school runs [setup.sql](setup.sql) once, as its own administrator, and sends the server, port, database name and
   the password.
3. Add the school to `schools.json`; its password is the env var `PAY_<SLUG>_PASS`. Restart the API.
4. Agree with the school how PAID rows in `pay_order` are approved and recorded in its system, and who sets `approved_at`.
