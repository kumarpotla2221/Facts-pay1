-- Synthetic demo only. {{schema}} is validated and quoted by scripts/create-demo.mjs.
CREATE SCHEMA {{schema}};
REVOKE ALL ON SCHEMA {{schema}} FROM PUBLIC, anon, authenticated;

CREATE TABLE {{schema}}._facts_pay_demo (
  label text NOT NULL CHECK (label = 'synthetic-demo'), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO {{schema}}._facts_pay_demo(label) VALUES ('synthetic-demo');
CREATE TABLE {{schema}}.fiscal_year (fiscal_year integer PRIMARY KEY, from_date timestamp NOT NULL);
INSERT INTO {{schema}}.fiscal_year
SELECT fy, make_date(fy,4,1)::timestamp FROM (
  SELECT extract(year FROM current_timestamp AT TIME ZONE 'Asia/Kolkata')::int
    - CASE WHEN extract(month FROM current_timestamp AT TIME ZONE 'Asia/Kolkata') < 4 THEN 1 ELSE 0 END AS fy
) y;
CREATE TABLE {{schema}}.acct (acct_code integer PRIMARY KEY, is_studentacct integer NOT NULL);
INSERT INTO {{schema}}.acct VALUES (12,1),(485,0);
CREATE TABLE {{schema}}.classes (class_code integer PRIMARY KEY, class_name text NOT NULL);
INSERT INTO {{schema}}.classes VALUES (1,'Class VI'),(2,'Class VIII'),(3,'Class X');
CREATE TABLE {{schema}}.sections (section_code text PRIMARY KEY, section_name text NOT NULL);
INSERT INTO {{schema}}.sections VALUES ('A','A'),('B','B');
CREATE TABLE {{schema}}.students (
  student_code integer PRIMARY KEY, student_id text NOT NULL UNIQUE, student_name text NOT NULL, sub_acct_code text NOT NULL
);
INSERT INTO {{schema}}.students VALUES
  (1,'DEMO001','Demo Student One','DEMO-1'),(2,'DEMO002','Demo Student Two','DEMO-2'),(3,'DEMO003','Demo Student Three','DEMO-3');
CREATE TABLE {{schema}}.student_curr_data (
  student_code integer NOT NULL, academic_year integer NOT NULL, class_code integer NOT NULL, section_code text NOT NULL,
  PRIMARY KEY(student_code,academic_year)
);
INSERT INTO {{schema}}.student_curr_data SELECT 1,fiscal_year,1,'A' FROM {{schema}}.fiscal_year;
INSERT INTO {{schema}}.student_curr_data SELECT 2,fiscal_year,2,'B' FROM {{schema}}.fiscal_year;
INSERT INTO {{schema}}.student_curr_data SELECT 3,fiscal_year,3,'A' FROM {{schema}}.fiscal_year;
CREATE TABLE {{schema}}.fee_charge_acct (fee_type_code text PRIMARY KEY, dr_acct_code text NOT NULL);
INSERT INTO {{schema}}.fee_charge_acct VALUES ('BUS','485');
CREATE TABLE {{schema}}.transport_routes (route_id integer PRIMARY KEY, fee_code text NOT NULL);
INSERT INTO {{schema}}.transport_routes VALUES (1,'BUS');
CREATE TABLE {{schema}}.journal_doc (
  finance_year integer NOT NULL, doc_type_code text NOT NULL, doc_no integer NOT NULL, doc_date timestamp NOT NULL, jv_no text,
  PRIMARY KEY(finance_year,doc_type_code,doc_no)
);
INSERT INTO {{schema}}.journal_doc
SELECT fiscal_year,'GJV_OB',1,from_date,'DEMO-OPENING' FROM {{schema}}.fiscal_year UNION ALL
SELECT fiscal_year,'JV',2,from_date,'DEMO-ANNUAL' FROM {{schema}}.fiscal_year UNION ALL
SELECT fiscal_year,'JV',3,date_trunc('month',current_timestamp AT TIME ZONE 'Asia/Kolkata'),'DEMO-MONTH' FROM {{schema}}.fiscal_year UNION ALL
SELECT fiscal_year,'BR',4,date_trunc('month',current_timestamp AT TIME ZONE 'Asia/Kolkata'),'DEMO-COUNTER' FROM {{schema}}.fiscal_year;
CREATE TABLE {{schema}}.journal_tran (
  school_code text NOT NULL, finance_year integer NOT NULL, doc_type_code text NOT NULL, doc_no integer NOT NULL, seq_id integer NOT NULL,
  acct_code text NOT NULL, cr_dr text NOT NULL, amount numeric(18,2) NOT NULL, narration text, sub_acct_code text NOT NULL,
  PRIMARY KEY(finance_year,doc_type_code,doc_no,seq_id)
);
INSERT INTO {{schema}}.journal_tran
SELECT '01',f.fiscal_year,t.doc_type_code,t.doc_no,t.seq_id,t.acct_code,t.cr_dr,t.amount,t.narration,t.sub_acct_code
FROM {{schema}}.fiscal_year f CROSS JOIN (VALUES
 ('GJV_OB',1,1,'12','Dr',5000.00,'Previous year balance','DEMO-1'),
 ('JV',2,1,'12','Dr',2000.00,'Annual charges','DEMO-1'),
 ('JV',3,1,'12','Dr',3000.00,'Monthly tuition','DEMO-1'),
 ('JV',3,2,'485','Dr',1000.00,'Monthly transport','DEMO-1'),
 ('BR',4,1,'12','Cr',1000.00,'Demo counter receipt','DEMO-1'),
 ('JV',3,3,'12','Dr',2500.00,'Monthly tuition','DEMO-2'),
 ('JV',3,4,'485','Dr',500.00,'Monthly transport','DEMO-2'),
 ('JV',3,5,'12','Dr',3500.00,'Monthly tuition','DEMO-3'),
 ('BR',4,2,'12','Cr',3500.00,'Demo counter receipt','DEMO-3')
) t(doc_type_code,doc_no,seq_id,acct_code,cr_dr,amount,narration,sub_acct_code);
CREATE TABLE {{schema}}.fee_receipt_doc (
  school_code text, finance_year integer, doc_type_code text, doc_no integer, doc_date timestamp, approved_by text, cr_no integer
);
CREATE TABLE {{schema}}.fee_receipt_tran (
  school_code text, finance_year text, doc_type_code text, doc_no integer, sub_acct_code text, acct_code text, amount numeric(18,2), narration text
);
CREATE TABLE {{schema}}.pay_order (
  order_id varchar(36) PRIMARY KEY, adm_no varchar(20) NOT NULL, student_name varchar(100) NOT NULL,
  class varchar(60) NOT NULL, section varchar(60) NOT NULL, due_ids varchar(1000) NOT NULL, amount_paise integer NOT NULL,
  payer_email varchar(120), payer_phone varchar(15), snapshot text NOT NULL,
  status varchar(10) NOT NULL DEFAULT 'CREATED' CHECK(status IN ('CREATED','PAID','FAILED')),
  receipt_no varchar(40) UNIQUE, gateway_ref varchar(64), payment_mode varchar(20),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  paid_at timestamptz, approved_at timestamptz, erp_receipt_no varchar(40)
);
CREATE SEQUENCE {{schema}}.pay_receipt_seq START WITH 1001;
REVOKE ALL ON ALL TABLES IN SCHEMA {{schema}} FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA {{schema}} FROM PUBLIC,anon,authenticated;
