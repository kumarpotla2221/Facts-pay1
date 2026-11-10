-- Facts Pay for <SCHOOL NAME>. Copy this file to schools-sql/<slug>.sql and write the dues query against that
-- school's own tables. The API sends it as is, with @adm_no (varchar(20)) = the admission number; nothing is installed
-- in the database. Contract: schools-sql/README.md. ranchi.sql is a complete worked example (a ledger-based ERP, so it
-- is on the long side).
--
-- This file only READS. Facts Pay never writes into the school's records: paid orders sit in pay_order (setup.sql)
-- until the school approves them and creates its own records.
--
-- Always return the four result sets below, in this order, with these column names. One batch: no GO, no CREATE.
SET NOCOUNT ON;

-- result 1: the student. One row, or NO row when the admission number is unknown.
SELECT CAST(NULL AS nvarchar(100)) AS name, CAST(NULL AS varchar(60)) AS cls, CAST(NULL AS varchar(60)) AS section
 WHERE 1 = 0;                                                                          -- TODO

-- result 2: every UNPAID due. due_id: letters, digits, _ and - only. type: 'fees' or 'transport'.
SELECT CAST(NULL AS varchar(20)) AS due_id, CAST(NULL AS varchar(10)) AS [type],
       CAST(NULL AS nvarchar(100)) AS label, CAST(NULL AS int) AS amount_paise
 WHERE 1 = 0;                                                                          -- TODO

-- result 3: optional breakdown of each due (lines of a due must add up to it). No breakdown = leave as is.
SELECT CAST(NULL AS varchar(20)) AS due_id, CAST(NULL AS int) AS line_no,
       CAST(NULL AS nvarchar(100)) AS label, CAST(NULL AS int) AS amount_paise
 WHERE 1 = 0;

-- result 4: the statement for this academic year, oldest first: every charge (a concession = a negative charge)
-- and every payment. Over the whole statement, charged - paid = what the student owes.
SELECT CAST(NULL AS date) AS [date], CAST(NULL AS varchar(40)) AS ref, CAST(NULL AS nvarchar(200)) AS label,
       CAST(NULL AS int) AS charged_paise, CAST(NULL AS int) AS paid_paise
 WHERE 1 = 0;                                                                          -- TODO
