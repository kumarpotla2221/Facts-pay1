-- Facts Pay for RANCHI (Metas school ERP).
-- This is the query the API runs, as is, for one admission number (@adm_no): nothing is installed in the database.
-- It only READS, and returns the four result sets of the contract in schools-sql/README.md.
-- Facts Pay never writes into the ERP. A paid order sits in pay_order (setup.sql) until the school validates and
-- approves it and writes its own receipt; until then the pay page takes it off the dues itself.
--
-- HOW THIS ERP KEEPS FEES (read this first)
--   There are no "fee due" rows. Instead every student has a running balance on two ledgers, and the balance
--   is what they owe:
--
--       tuition ledger    the account(s) flagged is_studentacct = 1          (account 12)
--       transport ledger  the debit account of the fees used by the routes   (account 485)
--
--   balance = (debits - credits) booked this finance year up to today
--             - fee receipts the accountant has not posted to the journal yet
--
--   That is the school's own query (database_backup/Queries for Ranchi School Fee.txt), done for one student.
--   So a student has at most two dues, called 'tuition' and 'transport', each one the full balance of its ledger.
--
-- How much of a due may be paid at once (minPayPercent in schools.json) is checked by the API.
SET NOCOUNT ON;
DECLARE @school_code varchar(10) = '01';

-- Today's date and the current finance year, in Indian time (the server may run in UTC).
DECLARE @now datetime2(0) = DATEADD(minute, 330, SYSUTCDATETIME());
DECLARE @today date = CAST(@now AS date);
DECLARE @fy int = (SELECT MAX(fiscal_year) FROM fiscal_year WHERE from_date <= @now);

-- Which ERP account codes belong to which ledger: rows of ('tuition', code) and ('transport', code).
DECLARE @ledger_acct TABLE (ledger varchar(20), acct_code int);
INSERT @ledger_acct (ledger, acct_code)
SELECT 'tuition', acct_code
  FROM acct
 WHERE is_studentacct = 1
UNION
SELECT 'transport', fc.dr_acct_code
  FROM fee_charge_acct fc
  JOIN transport_routes tr ON tr.fee_code = fc.fee_type_code;

-- Step 1: find the student and their current class (the class of the latest academic year on record).
DECLARE @found bit = 0, @sub varchar(50), @name nvarchar(100), @class varchar(60), @section varchar(60);

SELECT @found = 1,
       @sub   = s.sub_acct_code,
       @name  = s.student_name,
       @class = c.class_name,
       @section = sec.section_name
  FROM students s
  CROSS APPLY (SELECT TOP 1 x.class_code, x.section_code
                 FROM student_curr_data x
                WHERE x.student_code = s.student_code
                ORDER BY x.academic_year DESC) latest
  JOIN classes  c   ON c.class_code     = latest.class_code
  JOIN sections sec ON sec.section_code = latest.section_code
 WHERE s.student_id = @adm_no;

-- Result 1: the student
SELECT @name AS name, @class AS cls, @section AS section
 WHERE @found = 1;

-- Step 2: what they owe on each ledger:
--   1. what the journal says this finance year, up to today. A debit is a charge (adds), a credit is a payment
--      or concession (subtracts);
--   2. minus fee receipts already given but not yet posted to the journal (cr_no = 0), so the journal does not
--      know about them. Cancelled receipts do not count. (No finance-year filter here, as in the school's query.)
-- Zero or less (a credit balance) means nothing to pay.
DECLARE @dues TABLE (due_id varchar(20) PRIMARY KEY, [type] varchar(10), label nvarchar(100), balance decimal(18,2));

INSERT @dues (due_id, [type], label, balance)
SELECT ledger.due_id, ledger.[type], ledger.label,
       ISNULL((SELECT SUM(CASE WHEN jt.cr_dr = 'Dr' THEN jt.amount ELSE -jt.amount END)
                 FROM journal_tran jt
                 JOIN journal_doc  jd ON jd.finance_year  = jt.finance_year
                                     AND jd.doc_type_code = jt.doc_type_code
                                     AND jd.doc_no        = jt.doc_no
                WHERE jt.school_code   = @school_code
                  AND jt.finance_year  = @fy
                  AND jt.sub_acct_code = @sub
                  AND jt.amount        > 0
                  AND jd.doc_date      < DATEADD(day, 1, @today)
                  AND jt.acct_code IN (SELECT acct_code FROM @ledger_acct WHERE ledger = ledger.due_id)), 0)
     - ISNULL((SELECT SUM(ft.amount)
                 FROM fee_receipt_doc fd
                 JOIN fee_receipt_tran ft ON ft.school_code   = fd.school_code
                                         AND ft.finance_year  = fd.finance_year
                                         AND ft.doc_type_code = fd.doc_type_code
                                         AND ft.doc_no        = fd.doc_no
                WHERE ft.school_code   = @school_code
                  AND ft.doc_type_code = 'FR'
                  AND ft.sub_acct_code = @sub
                  AND fd.doc_date      < DATEADD(day, 1, @today)
                  AND fd.approved_by  <> '_Cancel'
                  AND fd.cr_no         = 0
                  AND ft.acct_code IN (SELECT acct_code FROM @ledger_acct WHERE ledger = ledger.due_id)), 0)
  FROM (VALUES ('tuition',   'fees',      N'School fees (tuition & charges)'),
               ('transport', 'transport', N'Transport fees')
       ) ledger (due_id, [type], label)
 WHERE @found = 1;

DELETE @dues WHERE balance <= 0;

-- Result 2: the dues, in paise (the API works in whole paise, never decimals)
SELECT due_id, [type], label, CAST(ROUND(balance * 100, 0) AS int) AS amount_paise
  FROM @dues;

-- Step 3: what each due is made of. This is only shown to the parent; the lines of a due must add up to it.
--
-- 3a. Take this year's journal entries on the ledger and put them into groups:
--       '0'      the balance brought forward from last year
--       '1'      annual charges
--       '2'      admission charges
--       yyyymm   one group per month, for everything else (monthly fees)
--     Concessions (credits) reduce the group they belong to. Receipts (BR, CR) are left out, because the
--     balance has already taken them off.
DECLARE @groups TABLE (due_id varchar(20), grp varchar(6), label nvarchar(100), net decimal(18,2));

INSERT @groups (due_id, grp, net)
SELECT d.due_id,
       CASE WHEN jt.doc_type_code = 'GJV_OB'        THEN '0'
            WHEN jt.narration LIKE '%annual%'       THEN '1'
            WHEN jt.narration LIKE '%admission%'    THEN '2'
            ELSE CONVERT(char(6), jd.doc_date, 112) END,
       SUM(CASE WHEN jt.cr_dr = 'Dr' THEN jt.amount ELSE -jt.amount END)
  FROM @dues d
  JOIN journal_tran jt ON jt.sub_acct_code = @sub
                      AND jt.acct_code IN (SELECT acct_code FROM @ledger_acct WHERE ledger = d.due_id)
  JOIN journal_doc  jd ON jd.finance_year  = jt.finance_year
                      AND jd.doc_type_code = jt.doc_type_code
                      AND jd.doc_no        = jt.doc_no
 WHERE jt.school_code  = @school_code
   AND jt.finance_year = @fy
   AND jt.amount       > 0
   AND jt.doc_type_code NOT IN ('BR', 'CR')
   AND jd.doc_date     < DATEADD(day, 1, @today)
 GROUP BY d.due_id,
          CASE WHEN jt.doc_type_code = 'GJV_OB'     THEN '0'
               WHEN jt.narration LIKE '%annual%'    THEN '1'
               WHEN jt.narration LIKE '%admission%' THEN '2'
               ELSE CONVERT(char(6), jd.doc_date, 112) END
HAVING SUM(CASE WHEN jt.cr_dr = 'Dr' THEN jt.amount ELSE -jt.amount END) > 0;

-- Give each group the name the parent will read.
DECLARE @fy_text varchar(10) = CAST(@fy AS varchar(4)) + '-' + RIGHT(CAST(@fy + 1 AS varchar(4)), 2);   -- 2026-27

UPDATE @groups
   SET label = CASE grp
                 WHEN '0' THEN N'Previous year balance'
                 WHEN '1' THEN N'Annual charges ' + @fy_text
                 WHEN '2' THEN N'Admission charges ' + @fy_text
                 ELSE FORMAT(CONVERT(date, grp + '01', 112), 'MMM yyyy', 'en-US') + N' ' + due_id   -- Nov 2026 tuition
               END;

-- 3b. The balance is what is still unpaid, and at the fee counter the OLDEST charges are treated as paid first.
--     So we hand the balance out to the NEWEST groups first, until it runs out:
--         what is left for a group = balance - the total of all groups newer than it
--     A group that gets its full amount is shown as is. A group that gets less is a part-paid month
--     and is shown with "(balance)". A group that gets nothing is not shown.
SELECT g.due_id,
       CAST(ROW_NUMBER() OVER (PARTITION BY g.due_id ORDER BY g.grp) AS int)       AS line_no,
       CAST(CASE WHEN left_over.amount < g.net THEN g.label + N' (balance)' ELSE g.label END AS nvarchar(100)) AS label,
       CAST(ROUND(CASE WHEN left_over.amount < g.net THEN left_over.amount ELSE g.net END * 100, 0) AS int)    AS amount_paise
  FROM @groups g
  JOIN @dues   d ON d.due_id = g.due_id
  CROSS APPLY (SELECT d.balance - ISNULL(SUM(newer.net), 0) AS amount
                 FROM @groups newer
                WHERE newer.due_id = g.due_id
                  AND newer.grp    > g.grp) left_over
 WHERE left_over.amount > 0
 ORDER BY g.due_id, line_no;                                                       -- Result 3: the lines

-- Step 4: the statement: every charge and payment on both ledgers this finance year, oldest first. These are
-- exactly the entries step 2 adds up, so charged - paid over the whole statement = what the student owes.
--   charged   a charge (Dr); a concession or a credit is a negative charge
--   paid      a fee receipt, posted to the journal (BR, CR) or not yet (FR with cr_no = 0)
-- The lines of one document with the same wording are added up (annual charges come as several lines).
SELECT CAST(x.doc_date AS date) AS [date], x.ref, x.label,
       CAST(ROUND(SUM(x.charged) * 100, 0) AS int) AS charged_paise,
       CAST(ROUND(SUM(x.paid) * 100, 0) AS int)    AS paid_paise
  FROM (SELECT jd.doc_date, jd.jv_no AS ref, jt.narration AS label,
               CASE WHEN jt.doc_type_code IN ('BR', 'CR') THEN 0 ELSE s.signed END AS charged,
               CASE WHEN jt.doc_type_code IN ('BR', 'CR') THEN -s.signed ELSE 0 END AS paid
          FROM journal_tran jt
          JOIN journal_doc  jd ON jd.finance_year  = jt.finance_year
                              AND jd.doc_type_code = jt.doc_type_code
                              AND jd.doc_no        = jt.doc_no
          CROSS APPLY (SELECT CASE WHEN jt.cr_dr = 'Dr' THEN jt.amount ELSE -jt.amount END AS signed) s
         WHERE jt.school_code   = @school_code
           AND jt.finance_year  = @fy
           AND jt.sub_acct_code = @sub
           AND jt.amount        > 0
           AND jd.doc_date      < DATEADD(day, 1, @today)
           AND jt.acct_code IN (SELECT acct_code FROM @ledger_acct)
        UNION ALL
        SELECT fd.doc_date, 'FR-' + CAST(fd.doc_no AS varchar(12)), ft.narration, 0, ft.amount
          FROM fee_receipt_doc fd
          JOIN fee_receipt_tran ft ON ft.school_code   = fd.school_code
                                  AND ft.finance_year  = fd.finance_year
                                  AND ft.doc_type_code = fd.doc_type_code
                                  AND ft.doc_no        = fd.doc_no
         WHERE ft.school_code   = @school_code
           AND ft.doc_type_code = 'FR'
           AND ft.sub_acct_code = @sub
           AND fd.doc_date      < DATEADD(day, 1, @today)
           AND fd.approved_by  <> '_Cancel'
           AND fd.cr_no         = 0
           AND ft.acct_code IN (SELECT acct_code FROM @ledger_acct)
       ) x
 GROUP BY x.doc_date, x.ref, x.label
 ORDER BY x.doc_date, x.ref;                                                      -- Result 4: the statement
