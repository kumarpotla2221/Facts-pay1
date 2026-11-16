/** Create a new isolated synthetic PostgreSQL demo. Existing schemas and roles are never overwritten. */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
const api=new URL('../',import.meta.url);
const schema='school_ranchi_demo',role='facts_pay_ranchi_demo';
const file=new URL('.env.supabase-demo',api);
if(fs.existsSync(file))throw new Error('Private demo environment file already exists; refusing to overwrite');
let url;
try{url=new URL(process.env.SUPABASE_MIGRATION_URL||'missing:');}
catch{throw new Error('SUPABASE_MIGRATION_URL is invalid; keep credentials private');}
const ref=process.env.SUPABASE_PROJECT_REF;
if(!ref||decodeURIComponent(url.username)!==`postgres.${ref}`||!url.hostname.endsWith('.pooler.supabase.com')||url.port!=='5432')throw new Error('Use the matching Supabase administrator Session pooler URI');
for(const key of ['ssl','sslmode','sslcert','sslkey','sslrootcert'])url.searchParams.delete(key);
const ssl={rejectUnauthorized:true,ca:fs.readFileSync(new URL('certs/supabase-ca.crt',api),'utf8')};
const admin=new pg.Client({connectionString:url.toString(),ssl,connectionTimeoutMillis:15000});
const password=randomBytes(32).toString('hex');
let transaction=false;
try{
 await admin.connect();
 const existing=await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname=$2',[schema,role]);
 if(existing.rowCount)throw new Error('Demo schema or role already exists; refusing to overwrite');
 await admin.query('BEGIN');transaction=true;
 await admin.query(fs.readFileSync(new URL('schools-sql/demo.postgres.sql',api),'utf8').replaceAll('{{schema}}',`"${schema}"`));
 await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  GRANT CONNECT ON DATABASE postgres TO ${role}; GRANT USAGE ON SCHEMA ${schema} TO ${role};
  GRANT SELECT ON ${['acct','classes','sections','students','student_curr_data','fee_charge_acct','transport_routes','fiscal_year','journal_doc','journal_tran','fee_receipt_doc','fee_receipt_tran','pay_order'].map(t=>`${schema}.${t}`).join(',')} TO ${role};
  GRANT INSERT(order_id,adm_no,student_name,class,section,due_ids,amount_paise,payer_email,payer_phone,snapshot,expires_at) ON ${schema}.pay_order TO ${role};
  GRANT UPDATE(status,receipt_no,gateway_ref,payment_mode,paid_at) ON ${schema}.pay_order TO ${role};
  GRANT USAGE ON SEQUENCE ${schema}.pay_receipt_seq TO ${role};`);
 await admin.query('COMMIT');transaction=false;
 const appUrl=new URL(url);appUrl.username=`${role}.${ref}`;appUrl.password=password;appUrl.port='6543';
 fs.writeFileSync(file,`PAY_RANCHI_DATABASE_URL=${appUrl}\nPAY_RANCHI_SCHEMA=${schema}\nTRUST_PROXY=1\nMOCK_GATEWAY=1\nDEMO_ADMISSION=DEMO001\n`,{flag:'wx'});
 const app=new pg.Client({connectionString:appUrl.toString(),ssl,connectionTimeoutMillis:15000});
 try{
  await app.connect();
  const r=await app.query(`SELECT count(*)::int AS demo_students,
   has_schema_privilege(current_user,'school_ranchi','USAGE') AS can_access_migrated_school,
   has_table_privilege(current_user,'${schema}.students','UPDATE') AS can_change_students FROM ${schema}.students`);
  if(r.rows[0].can_access_migrated_school||r.rows[0].can_change_students)throw new Error('Demo permissions are not isolated');
  console.log(JSON.stringify({demoCreated:true,schema,role,...r.rows[0],privateEnvironmentFile:'.env.supabase-demo'}));
 }finally{await app.end();}
}catch(error){
 if(transaction)await admin.query('ROLLBACK').catch(()=>{});
 let message=String(error.message);
 for(const secret of [process.env.SUPABASE_MIGRATION_URL,decodeURIComponent(url.password),password].filter(Boolean))message=message.replaceAll(secret,'[redacted]');
 console.error(JSON.stringify({demoCreated:false,message,code:error.code}));process.exitCode=1;
}finally{await admin.end().catch(()=>{});}
