#!/bin/sh
# Restore the Ranchi school's .bak into the compose SQL Server as `ranchi_school`, install the Facts Pay SQL
# (npm run db:deploy) and create the `pay_ranchi` login (password = PAY_RANCHI_PASS in .env, generated if missing).
# Usage (from repo root, after `docker compose up -d mssql`):  sh tools/restore-ranchi.sh [path/to/file.bak]
# WARNING: replaces an existing ranchi_school DB (online receipts made in it are lost).
set -eu
BAK=${1:-$(ls database_backup/*.bak | head -1)}
C=facts-mssql-1
sq() { docker exec -i "$C" sh -c '/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -b "$@"' sh "$@"; }

grep -q '^PAY_RANCHI_PASS=' .env || echo "PAY_RANCHI_PASS=Rp$(openssl rand -hex 16)" >> .env
P=$(grep '^PAY_RANCHI_PASS=' .env | cut -d= -f2 | sed 's/[[:space:]]*#.*//')   # drop an inline comment, as docker/node do

docker exec -u 0 "$C" mkdir -p /var/opt/mssql/backup
docker cp "$BAK" "$C":/var/opt/mssql/backup/ranchi.bak
docker exec -u 0 "$C" chown mssql /var/opt/mssql/backup/ranchi.bak
# logical file names differ per backup: read them, then MOVE both
FILES=$(sq -h -1 -W -s '|' -Q "SET NOCOUNT ON; RESTORE FILELISTONLY FROM DISK='/var/opt/mssql/backup/ranchi.bak'" | cut -d'|' -f1,3)
DATA=$(echo "$FILES" | grep '|D$' | cut -d'|' -f1); LOG=$(echo "$FILES" | grep '|L$' | cut -d'|' -f1)
sq -Q "IF DB_ID('ranchi_school') IS NOT NULL ALTER DATABASE ranchi_school SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
       RESTORE DATABASE ranchi_school FROM DISK='/var/opt/mssql/backup/ranchi.bak' WITH REPLACE,
       MOVE '$DATA' TO '/var/opt/mssql/data/ranchi_school.mdf', MOVE '$LOG' TO '/var/opt/mssql/data/ranchi_school_log.ldf';
       ALTER DATABASE ranchi_school SET MULTI_USER;" > /dev/null

[ -d node_modules ] || npm install                            # the deploy tool is part of this project
npm run --silent db:deploy -- ranchi                          # installs common.sql + the ERP adapter + settings
sq -v P="$P" -i /dev/stdin <<'SQL'
IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name='pay_ranchi') ALTER LOGIN pay_ranchi WITH PASSWORD='$(P)';
ELSE CREATE LOGIN pay_ranchi WITH PASSWORD='$(P)', CHECK_POLICY=OFF;
GO
USE ranchi_school;
IF USER_ID('pay_ranchi') IS NOT NULL DROP USER pay_ranchi;   -- orphaned user from the source server, if any
CREATE USER pay_ranchi FOR LOGIN pay_ranchi;
ALTER ROLE facts_pay_role ADD MEMBER pay_ranchi;
SQL
echo "ranchi_school restored from $BAK (login pay_ranchi can only run the pay_* procedures)"
