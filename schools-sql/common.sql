-- Facts Pay: the part that is THE SAME in every school database, however different the schools are.
-- Installed by `npm run db:deploy` BEFORE the school's own <slug>.sql. Safe to run again at any time: it only
-- creates what is missing and replaces the procedures.
--
-- Facts Pay never writes into the school's own records. Every online payment lives in ONE table here, pay_order.
-- The school validates and approves each PAID row and creates its own records from it (see "approval" below).
--
--   pay_order         one row per online payment attempt
--   pay_create_order  the parent pressed "Pay"
--   pay_settle        the gateway said "paid": the order becomes PAID and gets a receipt number
--   pay_fail_order    the gateway said "failed / cancelled"
--   pay_get_unapproved  the PAID orders the school has not approved yet (the pay page takes them off the dues)
--   pay_deployment    which version of this SQL the database has (written by the deploy tool)
--   facts_pay_role    the web login gets ONLY this role: it can run the procedures, it cannot touch any table

-- One row per deploy; the newest row describes what is installed now. `npm run db:status` reads it.
IF OBJECT_ID('pay_deployment') IS NULL
CREATE TABLE pay_deployment (
  id          int IDENTITY  NOT NULL PRIMARY KEY,
  sql_hash    char(64)      NOT NULL,                             -- fingerprint of common.sql + the school's <slug>.sql
  deployed_at datetime2(3)  NOT NULL DEFAULT SYSDATETIME(),       -- server time, comparable with sys.objects.modify_date
  deployed_by sysname       NOT NULL DEFAULT ORIGINAL_LOGIN()
);
GO

-- The record of every online payment. Once a row is PAID, the money has been taken.
--
-- APPROVAL: the school (its accountant, or its ERP's import) validates each PAID row, approves it and creates its own
-- records, then marks the row:   UPDATE pay_order SET approved_at = SYSUTCDATETIME(), erp_receipt_no = '<their receipt no>'
--                                WHERE receipt_no = 'OL-1001';
-- Until then the school's records still show the amount as owed, so the pay page takes unapproved payments off the
-- dues and lists them on the statement (pay_get_unapproved). After approval, the school's own records are trusted.
IF OBJECT_ID('pay_order') IS NULL
CREATE TABLE pay_order (
  order_id       varchar(36)   NOT NULL PRIMARY KEY,        -- made by the API (a random UUID)
  adm_no         varchar(20)   NOT NULL,
  student_name   nvarchar(100) NOT NULL,
  class          varchar(60)   NOT NULL,
  section        varchar(60)   NOT NULL,
  due_ids        varchar(1000) NOT NULL,                    -- the dues being paid and how much of each, in paise: 'tuition=150000,transport=90000'
  amount_paise   int           NOT NULL,                    -- the sum of those, checked against pay_get_dues, never trusted from the browser
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
IF OBJECT_ID('pay_receipt_seq', 'SO') IS NULL CREATE SEQUENCE pay_receipt_seq AS int START WITH 1001;
GO
CREATE OR ALTER PROCEDURE pay_create_order
  @order_id varchar(36), @adm_no varchar(20), @student_name nvarchar(100), @class varchar(60), @section varchar(60),
  @due_ids varchar(1000), @amount_paise int, @payer_email varchar(120) = NULL, @payer_phone varchar(15) = NULL,
  @snapshot nvarchar(max), @ttl_minutes int
AS
BEGIN
  SET NOCOUNT ON;
  -- Housekeeping, so abandoned attempts never pile up in the school's database: unpaid orders older than 30 days go.
  -- ponytail: runs on every new order and scans the table. Add an index on (status, created_at) if it ever gets big.
  DELETE pay_order WHERE status <> 'PAID' AND created_at < DATEADD(day, -30, SYSUTCDATETIME());

  INSERT pay_order (order_id, adm_no, student_name, class, section, due_ids, amount_paise, payer_email, payer_phone, snapshot, expires_at)
  VALUES (@order_id, @adm_no, @student_name, @class, @section, @due_ids, @amount_paise, @payer_email, @payer_phone, @snapshot,
          DATEADD(minute, @ttl_minutes, SYSUTCDATETIME()));
END
GO
-- The gateway said "paid". The order becomes PAID and gets the next receipt number, once: a double click, a replay,
-- an expired or a failed order is refused.
-- Errors:  50010 ORDER_NOT_FOUND | 50011 ORDER_ALREADY_PAID | 50012 ORDER_NOT_PAYABLE (failed or expired)
CREATE OR ALTER PROCEDURE pay_settle @order_id varchar(36), @gateway_ref varchar(64), @payment_mode varchar(20)
AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON;
  DECLARE @status varchar(10), @expires_at datetime2(0), @receipt_no varchar(40);
  BEGIN TRY
    BEGIN TRAN;
    -- Lock the order row. A double click or a replay waits here, then finds the order already PAID.
    SELECT @status = status, @expires_at = expires_at
      FROM pay_order WITH (UPDLOCK, HOLDLOCK) WHERE order_id = @order_id;
    IF @status IS NULL THROW 50010, 'ORDER_NOT_FOUND', 1;
    IF @status = 'PAID' THROW 50011, 'ORDER_ALREADY_PAID', 1;
    IF @status <> 'CREATED' OR @expires_at <= SYSUTCDATETIME() THROW 50012, 'ORDER_NOT_PAYABLE', 1;

    SET @receipt_no = 'OL-' + CAST(NEXT VALUE FOR pay_receipt_seq AS varchar(12));
    UPDATE pay_order
       SET status = 'PAID', receipt_no = @receipt_no, gateway_ref = @gateway_ref, payment_mode = @payment_mode,
           paid_at = SYSUTCDATETIME()
     WHERE order_id = @order_id;
    COMMIT;
  END TRY
  BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    THROW;
  END CATCH

  SELECT receipt_no, adm_no, amount_paise, payer_email, snapshot FROM pay_order WHERE order_id = @order_id;
END
GO
CREATE OR ALTER PROCEDURE pay_fail_order @order_id varchar(36)
AS
BEGIN
  SET NOCOUNT ON;
  UPDATE pay_order SET status = 'FAILED' WHERE order_id = @order_id AND status = 'CREATED';
  IF @@ROWCOUNT = 1 RETURN;
  -- Nothing changed: say why. A late "failed" message must never be answered with "nothing was charged" for a PAID order.
  DECLARE @status varchar(10) = (SELECT status FROM pay_order WHERE order_id = @order_id);
  IF @status IS NULL THROW 50010, 'ORDER_NOT_FOUND', 1;
  IF @status = 'PAID' THROW 50011, 'ORDER_ALREADY_PAID', 1;
END
GO
-- The student's online payments the school has not approved yet (see "approval" above).
CREATE OR ALTER PROCEDURE pay_get_unapproved @adm_no varchar(20)
AS
BEGIN
  SET NOCOUNT ON;
  SELECT receipt_no, paid_at, payment_mode, due_ids, amount_paise
    FROM pay_order
   WHERE adm_no = @adm_no AND status = 'PAID' AND approved_at IS NULL
   ORDER BY paid_at;
END
GO
-- The web login's role. A hosted database that hands out ONE login with no right to create roles (the Heroku MSSQL
-- add-on used for the demo) skips this: there the API simply runs as that login.
IF DATABASE_PRINCIPAL_ID('facts_pay_role') IS NULL AND HAS_PERMS_BY_NAME(NULL, 'DATABASE', 'CREATE ROLE') = 1
  CREATE ROLE facts_pay_role;
GO
IF DATABASE_PRINCIPAL_ID('facts_pay_role') IS NOT NULL
BEGIN
  GRANT EXECUTE ON pay_create_order   TO facts_pay_role;
  GRANT EXECUTE ON pay_settle         TO facts_pay_role;
  GRANT EXECUTE ON pay_fail_order     TO facts_pay_role;
  GRANT EXECUTE ON pay_get_unapproved TO facts_pay_role;
END
