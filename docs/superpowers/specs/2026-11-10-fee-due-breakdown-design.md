# Fee due breakdown on the pay page

## Problem
The pay page shows one total per ledger ("School fees: Rs. 3,000"). Parents can't tell what it covers.

## Goal
Each fee card lists what the amount is made of, e.g. `Nov 2026 tuition  Rs. 3,000`. Lines always add up to the due.

## Contract addition (schools-sql/README.md)
`pay_due_lines_v (adm_no, due_id, line_no int, label nvarchar(100), amount_paise int)`. It's display only.
- The lines of a due sum exactly to that due's `amount_paise` in `pay_dues_v`.
- A school with nothing to break down returns no rows (sunrise, greenfield: empty view).
- `pay_mark_paid` is unchanged.

## Ranchi mapping (schools-sql/ranchi.sql)
For each student and ledger, take the current-FY journal entries up to today, excluding receipts (`BR`, `CR`), and group them:
- `GJV_OB` → "Previous year balance"
- narration LIKE '%annual%' → "Annual charges <fy>-<yy>"
- narration LIKE '%admission%' → "Admission charges <fy>-<yy>"
- otherwise by month of doc_date → "<Mon yyyy> tuition|transport"

Within each group, net = Dr − Cr, so concessions and scholarships reduce the charge they belong to.
Allocate the ledger balance newest group first. Each group gets min(net, balance left), and groups with net ≤ 0 are skipped.
Oldest charges therefore count as paid first. Because each group gets at most what's left of the balance, the lines sum to the balance.

## API
`getDues` also reads `pay_due_lines_v` and returns `lines: {label, paise}[]` on each item, ordered by line_no.

## Page
Each fee card lists its lines (label, amount) above "Amount: Rs. X". If there are no lines, the card is unchanged.

## Out of scope
A "View full statement" link.

## Testing
- Ranchi: for all students, lines sum to the due amount (SQL check).
- Spot checks: 24/135 → one line "Nov 2026 tuition 3,000"; ST012045 → concession months netted.
- `npm test` still passes, and the sunrise/greenfield items carry `lines: []`.
