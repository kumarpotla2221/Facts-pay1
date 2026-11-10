#!/bin/sh
# DEV ONLY. Prints a few admission numbers you can demo with: students who still owe school fees.
# Usage:  sh tools/demo-students.sh [count]
set -eu
docker exec facts-mssql-1 sh -c '/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -d ranchi_school -W -Q "$1"' sh \
  "SET NOCOUNT ON; SELECT TOP ${1:-5} student_id AS adm_no FROM students
    WHERE dbo.pay_balance(sub_acct_code, 'tuition') > 0
      AND student_id NOT IN (SELECT adm_no FROM pay_order WHERE status = 'PAID' AND approved_at IS NULL) ORDER BY student_id DESC"
