-- PostgreSQL equivalent of ranchi.sql. $1 = admission number; {{schema}} is a validated, quoted private schema.
-- All amounts stay numeric in SQL and become integer paise at the API boundary.
WITH settings AS (
  SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date + 1 AS tomorrow,
    (SELECT max(fiscal_year) FROM {{schema}}.fiscal_year
      WHERE from_date <= CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') AS fy
), ledger_acct AS (
  SELECT 'tuition'::text AS ledger, acct_code FROM {{schema}}.acct WHERE is_studentacct = 1
  UNION
  SELECT 'transport', COALESCE(NULLIF(btrim(fc.dr_acct_code), ''), '0')::int
    FROM {{schema}}.fee_charge_acct fc JOIN {{schema}}.transport_routes tr ON btrim(tr.fee_code) = btrim(fc.fee_type_code)
), student AS (
  SELECT s.sub_acct_code, s.student_name AS name, c.class_name AS cls, COALESCE(sec.section_name, '') AS section
    FROM {{schema}}.students s
    CROSS JOIN LATERAL (SELECT x.class_code, x.section_code FROM {{schema}}.student_curr_data x
      WHERE x.student_code = s.student_code ORDER BY x.academic_year DESC LIMIT 1) latest
    JOIN {{schema}}.classes c ON c.class_code = latest.class_code
    JOIN {{schema}}.sections sec ON btrim(sec.section_code) = btrim(latest.section_code)
   WHERE lower(btrim(s.student_id)) = lower(btrim($1)) LIMIT 1
), journal AS MATERIALIZED (
  SELECT jt.*, jd.doc_date AS posted_date, jd.jv_no,
    CASE WHEN lower(btrim(jt.cr_dr)) = 'dr' THEN jt.amount ELSE -jt.amount END AS signed
    FROM {{schema}}.journal_tran jt
    JOIN {{schema}}.journal_doc jd ON jd.finance_year = jt.finance_year
      AND lower(btrim(jd.doc_type_code)) = lower(btrim(jt.doc_type_code)) AND jd.doc_no = jt.doc_no
    CROSS JOIN settings p CROSS JOIN student s
   WHERE jt.school_code = '01' AND jt.finance_year = p.fy AND jt.amount > 0
     AND lower(btrim(jt.sub_acct_code)) = lower(btrim(s.sub_acct_code)) AND jd.doc_date < p.tomorrow
     AND COALESCE(NULLIF(btrim(jt.acct_code), ''), '0')::int IN (SELECT acct_code FROM ledger_acct)
), receipts AS MATERIALIZED (
  SELECT ft.*, fd.doc_date AS posted_date
    FROM {{schema}}.fee_receipt_doc fd JOIN {{schema}}.fee_receipt_tran ft
      ON btrim(ft.school_code) = btrim(fd.school_code) AND ft.finance_year::int = fd.finance_year
      AND lower(btrim(ft.doc_type_code)) = lower(btrim(fd.doc_type_code)) AND ft.doc_no = fd.doc_no
    CROSS JOIN settings p CROSS JOIN student s
   WHERE ft.school_code = '01' AND lower(btrim(ft.doc_type_code)) = 'fr'
     AND lower(btrim(ft.sub_acct_code)) = lower(btrim(s.sub_acct_code)) AND fd.doc_date < p.tomorrow
     AND lower(btrim(fd.approved_by)) <> '_cancel' AND fd.cr_no = 0
     AND COALESCE(NULLIF(btrim(ft.acct_code), ''), '0')::int IN (SELECT acct_code FROM ledger_acct)
), balances AS (
  SELECT l.*,
    COALESCE((SELECT sum(j.signed) FROM journal j WHERE COALESCE(NULLIF(btrim(j.acct_code), ''), '0')::int
      IN (SELECT acct_code FROM ledger_acct WHERE ledger = l.due_id)), 0)
    - COALESCE((SELECT sum(r.amount) FROM receipts r WHERE COALESCE(NULLIF(btrim(r.acct_code), ''), '0')::int
      IN (SELECT acct_code FROM ledger_acct WHERE ledger = l.due_id)), 0) AS balance
    FROM (VALUES ('tuition', 'fees', 'School fees (tuition & charges)'),
                 ('transport', 'transport', 'Transport fees')) l(due_id, type, label)
   WHERE EXISTS (SELECT FROM student)
), dues AS (SELECT * FROM balances WHERE balance > 0), grouped AS (
  SELECT d.due_id,
    CASE WHEN lower(btrim(j.doc_type_code)) = 'gjv_ob' THEN '0'
      WHEN j.narration ILIKE '%annual%' THEN '1' WHEN j.narration ILIKE '%admission%' THEN '2'
      ELSE to_char(j.posted_date, 'YYYYMM') END AS grp, sum(j.signed) AS net
    FROM dues d JOIN journal j ON COALESCE(NULLIF(btrim(j.acct_code), ''), '0')::int
      IN (SELECT acct_code FROM ledger_acct WHERE ledger = d.due_id)
   WHERE lower(btrim(j.doc_type_code)) NOT IN ('br', 'cr')
   GROUP BY d.due_id, 2 HAVING sum(j.signed) > 0
), labeled AS (
  SELECT g.*,
    CASE g.grp WHEN '0' THEN 'Previous year balance'
      WHEN '1' THEN 'Annual charges ' || p.fy || '-' || right((p.fy + 1)::text, 2)
      WHEN '2' THEN 'Admission charges ' || p.fy || '-' || right((p.fy + 1)::text, 2)
      ELSE to_char(to_date(g.grp || '01', 'YYYYMMDD'), 'Mon YYYY') || ' ' || g.due_id END AS label,
    d.balance - COALESCE(sum(g.net) OVER (PARTITION BY g.due_id ORDER BY g.grp DESC
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS remaining
    FROM grouped g JOIN dues d USING (due_id) CROSS JOIN settings p
), lines AS (
  SELECT due_id, grp, label || CASE WHEN remaining < net THEN ' (balance)' ELSE '' END AS label,
    round(least(remaining, net) * 100)::int AS paise FROM labeled WHERE remaining > 0
), statement_source AS (
  SELECT posted_date, jv_no AS ref, narration AS label,
    CASE WHEN lower(btrim(doc_type_code)) IN ('br', 'cr') THEN 0 ELSE signed END AS charged,
    CASE WHEN lower(btrim(doc_type_code)) IN ('br', 'cr') THEN -signed ELSE 0 END AS paid FROM journal
  UNION ALL
  SELECT posted_date, 'FR-' || doc_no, narration, 0, amount FROM receipts
), statement AS (
  SELECT posted_date, ref, label, round(sum(charged) * 100)::int AS charged, round(sum(paid) * 100)::int AS paid
    FROM statement_source GROUP BY posted_date, ref, label
)
SELECT CASE WHEN EXISTS (SELECT FROM student) THEN jsonb_build_object(
  'student', (SELECT jsonb_build_object('name', name, 'cls', cls, 'section', section) FROM student),
  'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', d.due_id, 'type', d.type, 'label', d.label,
    'paise', round(d.balance * 100)::int, 'lines', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'label', l.label, 'paise', l.paise) ORDER BY l.grp) FROM lines l WHERE l.due_id = d.due_id), '[]'::jsonb))
    ORDER BY d.due_id DESC) FROM dues d), '[]'::jsonb),
  'statement', COALESCE((SELECT jsonb_agg(jsonb_build_object('date', to_char(posted_date, 'YYYY-MM-DD'),
    'ref', COALESCE(ref, ''), 'label', COALESCE(label, ''), 'chargedPaise', charged, 'paidPaise', paid)
    ORDER BY posted_date, ref) FROM statement), '[]'::jsonb)
) ELSE NULL END AS dues;
