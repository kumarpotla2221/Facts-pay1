// Installs and checks the Facts Pay SQL in the schools' databases. The only way that SQL gets into a database.
//
//   npm run db:deploy -- ranchi    one school (do one first, look at it, then the rest)
//   npm run db:deploy              every school in schools.json, one after another, stopping at the first failure
//   npm run db:status              which school has which version, and whether anyone changed it by hand since
//
// For each school it runs schools-sql/common.sql, then the school's own schools-sql/<slug>.sql, checks that the
// result honours the contract and records a fingerprint, all in ONE transaction: a school database is either
// fully on the new version or untouched. The scripts only create what is missing and replace procedures, so
// deploying again is always safe.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import sql from 'mssql';
import { config, schools, type School } from '../src/config.js';

// Line endings are normalised so the same file gives the same fingerprint on Windows and on macOS/Linux.
const readSql = (name: string) => readFileSync(new URL(`../schools-sql/${name}.sql`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** What a school's database should contain, and a fingerprint of it. */
function wanted(school: School) {
  const common = readSql('common'), own = readSql(school.slug);
  return { common, own, hash: createHash('sha256').update(common).update(own).digest('hex') };
}

/** Connects with the school's ADMIN login (db.admin in schools.json). The API never uses this login. */
function connect(school: School): Promise<sql.ConnectionPool> {
  const admin = school.db.admin;
  if (!admin) throw new Error(`schools.json: "${school.slug}" has no db.admin login`);
  const password = process.env[admin.passwordEnv];
  if (!password) throw new Error(`env var ${admin.passwordEnv} (admin password of ${school.slug}) is not set`);
  return new sql.ConnectionPool({
    server: config.SCHOOL_DB_HOST ?? school.db.host, port: school.db.port, database: school.db.name, user: admin.user, password,
    options: { encrypt: true, trustServerCertificate: config.DB_TRUST_CERT === '1' }, requestTimeout: 120_000,
  }).connect();
}

/** `GO` on a line of its own separates batches. It is a convention of SQL tools, not SQL: the server never sees it. */
const batches = (script: string) => script.split(/^\s*GO\s*;?\s*$/im).map(b => b.trim()).filter(Boolean);

async function deploy(school: School): Promise<string> {
  const w = wanted(school);
  const pool = await connect(school);
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    const run = (batch: string) => new sql.Request(tx).batch(batch);
    for (const b of batches(w.common)) await run(b);
    for (const b of batches(w.own)) await run(b);
    await checkContract(tx);                               // a school file that breaks the contract is not installed
    await new sql.Request(tx).input('hash', sql.Char(64), w.hash).query('INSERT pay_deployment (sql_hash) VALUES (@hash)');
    await tx.commit();
    return `deployed (version ${w.hash.slice(0, 8)})`;
  } catch (err) {
    await tx.rollback().catch(() => {});   // nothing of this deploy stays behind
    throw err;
  } finally { await pool.close(); }
}

/**
 * Every school file is hand-written against a different database, so the deploy itself checks what it produced
 * against schools-sql/README.md: pay_get_dues really runs and returns the four result sets with the agreed columns.
 */
async function checkContract(tx: sql.Transaction): Promise<void> {
  const problems: string[] = [];
  const dues = await new sql.Request(tx).input('adm_no', sql.VarChar(20), '-no-such-student-').execute('pay_get_dues');
  const sets = dues.recordsets as unknown as { columns: Record<string, unknown> }[];
  const expected = [['name', 'cls', 'section'], ['due_id', 'type', 'label', 'amount_paise'], ['due_id', 'line_no', 'label', 'amount_paise'],
    ['date', 'ref', 'label', 'charged_paise', 'paid_paise']];
  if (sets.length !== 4) problems.push(`pay_get_dues returned ${sets.length} result sets, the contract says 4`);
  else expected.forEach((columns, i) => {
    const missing = columns.filter(c => !(c in sets[i]!.columns));
    if (missing.length) problems.push(`pay_get_dues result ${i + 1} has no column ${missing.join(', ')}`);
  });


  if (problems.length) throw new Error('breaks the contract in schools-sql/README.md: ' + problems.join('; '));
}

async function status(school: School): Promise<{ ok: boolean; text: string }> {
  const w = wanted(school);
  const pool = await connect(school);
  try {
    const { recordset: [exists] } = await pool.request().query<{ id: number | null }>(`SELECT OBJECT_ID('pay_deployment') AS id`);
    if (!exists?.id) return { ok: false, text: 'never deployed' };
    const { recordset: [last] } = await pool.request().query<{ sql_hash: string; deployed_at: Date }>(
      'SELECT TOP 1 sql_hash, deployed_at FROM pay_deployment ORDER BY id DESC');
    if (!last) return { ok: false, text: 'never deployed' };
    // Someone edited one of our objects directly in the database after the last deploy?
    const { recordset: edited } = await pool.request().input('at', sql.DateTime2, last.deployed_at).query<{ name: string }>(
      `SELECT name FROM sys.objects WHERE name LIKE 'pay[_]%' AND type IN ('P', 'V', 'FN', 'IF', 'TF', 'U', 'SO')
          AND modify_date > DATEADD(second, 1, @at) ORDER BY name`);
    const version = `version ${last.sql_hash.slice(0, 8)}, deployed ${last.deployed_at.toISOString().slice(0, 16).replace('T', ' ')}`;
    if (edited.length) return { ok: false, text: `CHANGED IN THE DATABASE since the last deploy: ${edited.map(e => e.name).join(', ')} (${version})` };
    if (last.sql_hash !== w.hash) return { ok: false, text: `OUT OF DATE: the SQL files here are newer (${version})` };
    return { ok: true, text: `up to date (${version})` };
  } finally { await pool.close(); }
}

// ---- command line ----
const [command, ...slugs] = process.argv.slice(2);
const unknown = slugs.filter(slug => !schools.some(s => s.slug === slug));
if (unknown.length) { console.error(`Not in schools.json: ${unknown.join(', ')}`); process.exit(1); }
const targets = slugs.length ? schools.filter(s => slugs.includes(s.slug)) : schools;

let failures = 0;
for (const school of targets) {
  try {
    if (command === 'deploy') console.log(`${school.slug}: ${await deploy(school)}`);
    else if (command === 'status') { const s = await status(school); if (!s.ok) failures++; console.log(`${school.slug}: ${s.text}`); }
    else throw new Error('Usage: tools/db.ts deploy|status [school ...]');
  } catch (err) {
    failures++;
    console.error(`${school.slug}: FAILED - ${(err as Error).message}`);
    if (command !== 'status') break;   // never spread a broken script to the next school
  }
}
process.exit(failures ? 1 : 0);
