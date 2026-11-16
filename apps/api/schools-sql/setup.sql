-- Facts Pay: the ONLY thing ever installed in a school's database. Run it ONCE, as an administrator, connected to the
-- database that holds the fee data. It creates one login, one table and one sequence, nothing else:
--
--   facts_pay         the login the Facts Pay API connects with. It may READ every table (db_datareader) and write
--                     ONLY into pay_order. SQL Server enforces that: it can never change the school's own records.
--   pay_order         one row per online payment attempt. The school validates and approves each PAID row and creates
--                     its own records from it (see APPROVAL below).
--   pay_receipt_seq   Facts Pay's receipt numbers: OL-1001, OL-1002, ...
--
-- The dues are read with a plain query that stays with Facts Pay (schools-sql/<slug>.sql), so nothing else is ever
-- installed here and no administrator login is ever given to Facts Pay.
--
-- Before running: replace the password. Afterwards send Facts Pay the server address, the port (usually 1433), the
-- database name and the password (the password by phone or another safe channel, never in the same email). The server
-- must allow SQL Server authentication (mixed mode) and connections on that port from the Facts Pay server's IP address.

-- The login. (Azure SQL Database has no server logins: run CREATE USER facts_pay WITH PASSWORD = '<password>'; instead of these two.)
CREATE LOGIN facts_pay WITH PASSWORD = '<password>';
GO
CREATE USER facts_pay FOR LOGIN facts_pay;
GO

-- The record of every online payment. Once a row is PAID, the money has been taken.
--
-- APPROVAL: the school (its accountant, or its ERP's import) validates each PAID row, approves it and creates its own
-- records, then marks the row:   UPDATE pay_order SET approved_at = SYSUTCDATETIME(), erp_receipt_no = '<their receipt no>'
--                                WHERE receipt_no = 'OL-1001';
-- Until then the school's records still show the amount as owed, so the pay page takes unapproved payments off the
-- dues and lists them on the statement. After approval, the school's own records are trusted.
-- In dbo, next to the school's own tables (the API expects it in the login's default schema).
IF OBJECT_ID('dbo.pay_order') IS NULL
CREATE TABLE dbo.pay_order (
  order_id       varchar(36)   NOT NULL PRIMARY KEY,        -- made by the API (a random UUID)
  adm_no         varchar(20)   NOT NULL,
  student_name   nvarchar(100) NOT NULL,
  class          varchar(60)   NOT NULL,
  section        varchar(60)   NOT NULL,
  due_ids        varchar(1000) NOT NULL,                    -- the dues being paid and how much of each, in paise: 'tuition=150000,transport=90000'
  amount_paise   int           NOT NULL,                    -- the sum of those, checked against the dues query, never trusted from the browser
  payer_email    varchar(120)  NULL,
  payer_phone    varchar(15)   NULL,
  snapshot       nvarchar(max) NOT NULL,                    -- JSON: the student + dues exactly as the parent saw them (printed on the receipt)
  status         varchar(10)   NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'PAID', 'FAILED')),
  receipt_no     varchar(40)   NULL,                        -- Facts Pay's receipt number, once PAID: OL-1001, OL-1002, ...
  gateway_ref    varchar(64)   NULL,                        -- the payment gateway's transaction id
  payment_mode   varchar(20)   NULL,                        -- how it was paid, as the gateway reports it: UPI, Card, NetBanking, ...
  created_at     datetime2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),   -- all times are UTC
  expires_at     datetime2(0)  NOT NULL,
  paid_at        datetime2(0)  NULL,
  approved_at    datetime2(0)  NULL,                        -- when the school validated and approved it, creating its own records
  erp_receipt_no varchar(40)   NULL                         -- the school's own receipt number for it
);
GO
-- Receipt numbers: OL-1001, OL-1002, ... one per PAID order, in payment order.
IF OBJECT_ID('dbo.pay_receipt_seq', 'SO') IS NULL CREATE SEQUENCE dbo.pay_receipt_seq AS int START WITH 1001;
GO

-- What the login may do, and all it may do.
ALTER ROLE db_datareader ADD MEMBER facts_pay;                 -- read every table (or GRANT SELECT on just the tables the dues query reads)
GRANT SELECT, INSERT, UPDATE ON dbo.pay_order TO facts_pay;    -- the ONLY table it may write
GRANT UPDATE ON dbo.pay_receipt_seq TO facts_pay;              -- to take the next receipt number
GO
