/** Read the local SQL Server copy; create a new PRIVATE schema in Supabase, atomically. Never overwrite a schema.
 * node --env-file=.env scripts/migrate-supabase.mjs [--apply]
 * Credentials are read only from the environment. Default is a read-only preflight.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import sql from 'mssql';
import pg from 'pg';

const api = new URL('../', import.meta.url);
const names = ['acct','classes','fee_charge_acct','fee_receipt_doc','fee_receipt_tran','fiscal_year',
  'journal_doc','journal_tran','pay_order','sections','student_curr_data','students','transport_routes'];
const school = JSON.parse(fs.readFileSync(new URL('schools.json',api),'utf8')).find(s=>s.slug==='ranchi');
const schema = process.env.PAY_RANCHI_SCHEMA || 'school_ranchi';
if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema) || ['public','auth','storage'].includes(schema)) throw new Error('Use a new private school schema');
const qi = s => '"' + s.replaceAll('"','""') + '"';
const si = s => '[' + s.replaceAll(']',']]') + ']';
let uri;
try { uri = new URL(process.env.SUPABASE_MIGRATION_URL || 'missing:'); }
catch { throw new Error('SUPABASE_MIGRATION_URL is not a valid URI; keep credentials private'); }
const expected = process.env.SUPABASE_PROJECT_REF;
if (!expected || decodeURIComponent(uri.username) !== `postgres.${expected}` || !uri.hostname.endsWith('.pooler.supabase.com') || uri.port !== '5432') {
  throw new Error('Set SUPABASE_PROJECT_REF and the matching Supabase Session pooler URI (port 5432)');
}
for (const key of ['ssl','sslmode','sslcert','sslkey','sslrootcert']) uri.searchParams.delete(key);
const target = new pg.Client({connectionString:uri.toString(),ssl:{rejectUnauthorized:true,ca:fs.readFileSync(new URL('certs/supabase-ca.crt',api),'utf8')},
  connectionTimeoutMillis:15000,application_name:'FactsPayMigration'});
const source = new sql.ConnectionPool({server:school.db.host,port:school.db.port,database:school.db.name,user:school.db.user,
  password:process.env.PAY_RANCHI_PASS,options:{encrypt:true,trustServerCertificate:process.env.DB_TRUST_CERT==='1'},pool:{max:1},requestTimeout:120000});

const typeOf = (c, table) => {
 switch(c.type) {
  case 'int': return 'integer'; case 'smallint': return 'smallint'; case 'bigint': return 'bigint'; case 'bit': return 'boolean';
  case 'decimal': case 'numeric': return `numeric(${c.precision},${c.scale})`;
  case 'date': return 'date';
  case 'datetime': case 'datetime2': case 'smalldatetime':
    if(c.type==='datetime2' && c.scale>3) throw new Error('Source timestamp precision exceeds this migrator\'s millisecond contract');
    return table==='pay_order'?'timestamptz(3)':'timestamp(3)';
  case 'varchar': case 'char': case 'nvarchar': case 'nchar': return c.max_length===-1?'text':`varchar(${c.max_length/(c.type.startsWith('n')?2:1)})`;
  default: throw new Error(`Unsupported source type ${c.type}`);
 }
};
function sourceSelect(c) {
 const col=si(c.name), alias=si(c.name.toLowerCase());
 if (['decimal','numeric','bigint'].includes(c.type)) return `CONVERT(varchar(100),${col}) AS ${alias}`;
 if (['date','datetime','datetime2','smalldatetime'].includes(c.type)) return `CONVERT(varchar(30),${col},126) AS ${alias}`;
 return `${col} AS ${alias}`;
}
function canonical(row, columns) {
 return columns.map(c=>{
  const v=row[c.name.toLowerCase()];
  if(v===null || v===undefined) return null;
  if(c.type==='date') return String(v).slice(0,10);
  if(['datetime','datetime2','smalldatetime'].includes(c.type)) {
   let text=String(v).replace(/Z$/, '');
   if(text.length===19) text+='.000';
   return text.slice(0,23).padEnd(23,'0');
  }
  return v;
 });
}
const mod=1n<<256n;
function checksum(rows, cols, running=0n) {
 for(const row of rows) running=(running+BigInt('0x'+createHash('sha256').update(JSON.stringify(canonical(row,cols))).digest('hex')))%mod;
 return running;
}
function pgSelect(c,table) {
 const col=qi(c.name.toLowerCase());
 if(['datetime','datetime2','smalldatetime'].includes(c.type)) return `to_char(${col}${table==='pay_order'?" AT TIME ZONE 'UTC'":''},'YYYY-MM-DD"T"HH24:MI:SS.MS') AS ${col}`;
 if(c.type==='date') return `${col}::text AS ${col}`;
 return col;
}
let inTransaction=false;
try {
 await target.connect(); await source.connect();
 const existing=await target.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema]);
 const metadata={};
 for(const name of names) {
  const r=await source.request().input('name',sql.VarChar,name).query(`
   SELECT c.name,t.name AS type,c.max_length,c.precision,c.scale,c.is_nullable
   FROM sys.columns c JOIN sys.types t ON t.user_type_id=c.user_type_id WHERE c.object_id=OBJECT_ID('dbo.'+@name) ORDER BY c.column_id;
   SELECT c.name FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
    JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
    WHERE i.object_id=OBJECT_ID('dbo.'+@name) AND i.is_primary_key=1 ORDER BY ic.key_ordinal;
   SELECT COUNT_BIG(*) AS n FROM dbo.${si(name)};`);
  metadata[name]={columns:r.recordsets[0],pk:r.recordsets[1].map(c=>c.name),rows:Number(r.recordsets[2][0].n)};
  if(!metadata[name].columns.length || !metadata[name].pk.length) throw new Error(`Missing table/key: ${name}`);
  metadata[name].columns.forEach(c=>typeOf(c,name));
 }
 console.log(JSON.stringify({preflight:true,project:expected,schema,schemaAlreadyExists:!!existing.rowCount,
  tables:names.map(table=>({table,rows:metadata[table].rows}))}));
 if(!process.argv.includes('--apply')) process.exitCode=0;
 else {
  if(existing.rowCount) throw new Error('Target schema already exists; migration refuses to overwrite data');
  await target.query('BEGIN'); inTransaction=true;
  await target.query(`CREATE SCHEMA ${qi(schema)}; REVOKE ALL ON SCHEMA ${qi(schema)} FROM PUBLIC,anon,authenticated`);
  const report=[];
  for(const name of names) {
   const m=metadata[name], table=`${qi(schema)}.${qi(name)}`;
   await target.query(`CREATE TABLE ${table} (${m.columns.map(c=>`${qi(c.name.toLowerCase())} ${typeOf(c,name)}${c.is_nullable?'':' NOT NULL'}`).join(',')},
    PRIMARY KEY (${m.pk.map(c=>qi(c.toLowerCase())).join(',')}))`);
   await target.query(`REVOKE ALL ON TABLE ${table} FROM PUBLIC,anon,authenticated`);
   let hash=0n,copied=0;
   const batchSize=name==='students'?300:2000;
   for(let offset=0;offset<m.rows;offset+=batchSize) {
    const r=await source.request().input('offset',sql.Int,offset).input('size',sql.Int,batchSize)
     .query(`SELECT ${m.columns.map(sourceSelect).join(',')} FROM dbo.${si(name)} ORDER BY ${m.pk.map(si).join(',')} OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`);
    hash=checksum(r.recordset,m.columns,hash); copied+=r.recordset.length;
    // Numeric values are strings until PostgreSQL parses them as exact numeric, never JS floating point.
    for(const row of r.recordset) for(const c of m.columns) if(name==='pay_order' && ['datetime','datetime2'].includes(c.type) && row[c.name.toLowerCase()]) row[c.name.toLowerCase()]+='Z';
    const inserted=await target.query(`INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table},$1::json)`,[JSON.stringify(r.recordset)]);
    if(inserted.rowCount!==r.recordset.length) throw new Error(`Incomplete batch in ${name}`);
    if(offset && offset%20000===0) console.log(JSON.stringify({table:name,copied,total:m.rows}));
   }
   const actual=await target.query(`SELECT ${m.columns.map(c=>pgSelect(c,name)).join(',')} FROM ${table}`);
   if(copied!==m.rows || actual.rowCount!==m.rows || checksum(actual.rows,m.columns)!==hash) throw new Error(`Row count/checksum mismatch in ${name}`);
   report.push({table:name,rows:copied,checksum:hash.toString(16).padStart(64,'0')});
   console.log(JSON.stringify({verified:true,table:name,rows:copied}));
  }
  const seq=await source.request().query("SELECT CONVERT(varchar(30),current_value) AS value FROM sys.sequences WHERE name='pay_receipt_seq'");
  const maxReceipt=await target.query(`SELECT max(substring(receipt_no FROM '^OL-([0-9]+)$')::bigint)::text AS n FROM ${qi(schema)}.pay_order`);
  const next=Math.max(1001,Number(seq.recordset[0]?.value||1000)+1,Number(maxReceipt.rows[0]?.n||1000)+1);
  await target.query(`CREATE SEQUENCE ${qi(schema)}.pay_receipt_seq START WITH ${next};
   REVOKE ALL ON SEQUENCE ${qi(schema)}.pay_receipt_seq FROM PUBLIC,anon,authenticated;
   ALTER TABLE ${qi(schema)}.pay_order ALTER COLUMN status SET DEFAULT 'CREATED', ALTER COLUMN created_at SET DEFAULT clock_timestamp(),
     ADD CHECK (status IN ('CREATED','PAID','FAILED'));
   CREATE UNIQUE INDEX pay_order_receipt_unique ON ${qi(schema)}.pay_order(receipt_no) WHERE receipt_no IS NOT NULL;
   CREATE INDEX pay_order_pending ON ${qi(schema)}.pay_order(lower(btrim(adm_no)),paid_at) WHERE status='PAID' AND approved_at IS NULL;
   CREATE INDEX students_admission ON ${qi(schema)}.students(lower(btrim(student_id)));
   CREATE INDEX student_latest ON ${qi(schema)}.student_curr_data(student_code,academic_year DESC);
   CREATE INDEX journal_student ON ${qi(schema)}.journal_tran(lower(btrim(sub_acct_code)),finance_year);
   CREATE INDEX journal_document ON ${qi(schema)}.journal_doc(finance_year,lower(btrim(doc_type_code)),doc_no);
   CREATE INDEX fee_student ON ${qi(schema)}.fee_receipt_tran(lower(btrim(sub_acct_code)));
   CREATE INDEX fee_document ON ${qi(schema)}.fee_receipt_doc(school_code,finance_year,lower(btrim(doc_type_code)),doc_no);`);
  await target.query(`CREATE TABLE ${qi(schema)}._facts_pay_migration (completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
   source_database text NOT NULL, report jsonb NOT NULL);
   REVOKE ALL ON TABLE ${qi(schema)}._facts_pay_migration FROM PUBLIC,anon,authenticated`);
  await target.query(`INSERT INTO ${qi(schema)}._facts_pay_migration(source_database,report) VALUES($1,$2)`,[school.db.name,JSON.stringify(report)]);
  await target.query('COMMIT'); inTransaction=false;
  console.log(JSON.stringify({migrationComplete:true,schema,tables:report.length,rows:report.reduce((a,t)=>a+t.rows,0),nextReceipt:next}));
 }
} catch(error) {
 if(inTransaction) await target.query('ROLLBACK').catch(()=>{});
 const secrets=[process.env.SUPABASE_MIGRATION_URL,process.env.PAY_RANCHI_PASS,decodeURIComponent(uri.password)].filter(Boolean);
 let message=String(error.message); for(const secret of secrets) message=message.replaceAll(secret,'[redacted]');
 console.error(JSON.stringify({migrationComplete:false,rolledBack:inTransaction,code:error.code,message})); process.exitCode=1;
} finally { await source.close().catch(()=>{}); await target.end().catch(()=>{}); }
