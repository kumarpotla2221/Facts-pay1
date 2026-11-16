/** Copy the migrated school data into an independent demo. Never overwrite schemas, roles, or credentials. */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
const api=new URL('../',import.meta.url);
const source='school_ranchi',schema='school_ranchi_full_demo',role='facts_pay_ranchi_full_demo';
const tables=['acct','classes','fee_charge_acct','fee_receipt_doc','fee_receipt_tran','fiscal_year','journal_doc','journal_tran','pay_order','sections','student_curr_data','students','transport_routes'];
const file=new URL('.env.supabase-school-demo',api);
if(fs.existsSync(file))throw new Error('Private school demo environment already exists; refusing to overwrite');
let uri;
try{uri=new URL(process.env.SUPABASE_MIGRATION_URL||'missing:');}catch{throw new Error('Invalid migration URI; keep credentials private');}
const ref=process.env.SUPABASE_PROJECT_REF;
if(!ref||decodeURIComponent(uri.username)!==`postgres.${ref}`||!uri.hostname.endsWith('.pooler.supabase.com')||uri.port!=='5432')throw new Error('Use the matching Supabase administrator Session pooler URI');
for(const key of ['ssl','sslmode','sslcert','sslkey','sslrootcert'])uri.searchParams.delete(key);
const ssl={rejectUnauthorized:true,ca:fs.readFileSync(new URL('certs/supabase-ca.crt',api),'utf8')};
const admin=new pg.Client({connectionString:uri.toString(),ssl,connectionTimeoutMillis:15000,application_name:'FactsPaySchoolDemoClone'});
const password=randomBytes(32).toString('hex');
let transaction=false;
// Sorting row digests makes this independent of physical row order. No student values leave the database.
const fingerprint=table=>`SELECT count(*)::text AS rows, md5(coalesce(string_agg(digest,'' ORDER BY digest),'')) AS checksum
 FROM (SELECT md5(row_to_json(t)::text) AS digest FROM ${table} t) rows`;
try{
 await admin.connect();
 const exists=await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname=$2',[schema,role]);
 if(exists.rowCount)throw new Error('School demo schema or role already exists; refusing to overwrite');
 const migrated=await admin.query(`SELECT count(*)::int AS n FROM ${source}._facts_pay_migration`);
 if(migrated.rows[0].n!==1)throw new Error('A verified source migration is required');
 await admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ');transaction=true;
 await admin.query("SET LOCAL statement_timeout='120s'");
 await admin.query(`CREATE SCHEMA ${schema}; REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC,anon,authenticated`);
 const report=[];
 for(const table of tables){
  // Explicitly exclude defaults/identities to prevent any linkage to source sequences or functions.
  await admin.query(`CREATE TABLE ${schema}.${table} (LIKE ${source}.${table} INCLUDING ALL EXCLUDING DEFAULTS EXCLUDING IDENTITY);
   INSERT INTO ${schema}.${table} SELECT * FROM ${source}.${table};
   REVOKE ALL ON TABLE ${schema}.${table} FROM PUBLIC,anon,authenticated`);
  const expected=(await admin.query(fingerprint(`${source}.${table}`))).rows[0];
  const actual=(await admin.query(fingerprint(`${schema}.${table}`))).rows[0];
  if(expected.rows!==actual.rows||expected.checksum!==actual.checksum)throw new Error(`Copy verification failed: ${table}`);
  report.push({table,rows:Number(actual.rows),checksum:actual.checksum});
  await admin.query(`ANALYZE ${schema}.${table}`);
  console.log(JSON.stringify({table,rows:Number(actual.rows),verified:true}));
 }
 const sequence=await admin.query(`SELECT last_value::text FROM ${source}.pay_receipt_seq`);
 const receipts=await admin.query(`SELECT max(substring(receipt_no FROM '^OL-([0-9]+)$')::bigint)::text AS n FROM ${schema}.pay_order`);
 const next=Math.max(1001,Number(sequence.rows[0].last_value)+1,Number(receipts.rows[0].n||1000)+1);
 await admin.query(`CREATE SEQUENCE ${schema}.pay_receipt_seq START WITH ${next};
  ALTER TABLE ${schema}.pay_order ALTER COLUMN status SET DEFAULT 'CREATED', ALTER COLUMN created_at SET DEFAULT clock_timestamp();
  CREATE TABLE ${schema}._facts_pay_demo (label text NOT NULL CHECK(label='school-data-snapshot'),source_schema text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),report jsonb NOT NULL);
  CREATE TABLE ${schema}._facts_pay_demo_pay_order_baseline AS SELECT * FROM ${schema}.pay_order;
  REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC,anon,authenticated;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC,anon,authenticated;
  CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  GRANT CONNECT ON DATABASE postgres TO ${role}; GRANT USAGE ON SCHEMA ${schema} TO ${role};
  GRANT SELECT ON ${tables.map(t=>`${schema}.${t}`).join(',')} TO ${role};
  GRANT INSERT(order_id,adm_no,student_name,class,section,due_ids,amount_paise,payer_email,payer_phone,snapshot,expires_at) ON ${schema}.pay_order TO ${role};
  GRANT UPDATE(status,receipt_no,gateway_ref,payment_mode,paid_at) ON ${schema}.pay_order TO ${role};
  GRANT USAGE ON SEQUENCE ${schema}.pay_receipt_seq TO ${role};`);
 await admin.query(`INSERT INTO ${schema}._facts_pay_demo(label,source_schema,report) VALUES('school-data-snapshot',$1,$2)`,[source,JSON.stringify(report)]);
 await admin.query('COMMIT');transaction=false;
 const appUri=new URL(uri);appUri.username=`${role}.${ref}`;appUri.password=password;appUri.port='6543';
 fs.writeFileSync(file,`PAY_RANCHI_DATABASE_URL=${appUri}\nPAY_RANCHI_SCHEMA=${schema}\nTRUST_PROXY=1\nMOCK_GATEWAY=1\n`,{flag:'wx'});
 const app=new pg.Client({connectionString:appUri.toString(),ssl,connectionTimeoutMillis:15000});
 try{
  await app.connect();
  const r=await app.query(`SELECT count(*)::int AS students,
   has_schema_privilege(current_user,'${source}','USAGE') AS can_access_original,
   has_table_privilege(current_user,'${schema}.students','UPDATE') AS can_modify_students FROM ${schema}.students`);
  if(r.rows[0].can_access_original||r.rows[0].can_modify_students)throw new Error('School demo login is not isolated');
  console.log(JSON.stringify({schoolDemoReady:true,schema,tables:report.length,rows:report.reduce((n,t)=>n+t.rows,0),nextReceipt:next,...r.rows[0]}));
 }finally{await app.end();}
}catch(error){
 if(transaction)await admin.query('ROLLBACK').catch(()=>{});
 let message=String(error.message);
 for(const secret of [process.env.SUPABASE_MIGRATION_URL,decodeURIComponent(uri.password),password].filter(Boolean))message=message.replaceAll(secret,'[redacted]');
 console.error(JSON.stringify({schoolDemoReady:false,rolledBack:transaction,code:error.code,message}));process.exitCode=1;
}finally{await admin.end().catch(()=>{});}
