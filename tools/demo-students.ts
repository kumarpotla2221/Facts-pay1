// DEV ONLY. Prints a few Ranchi admission numbers you can demo with: students who still owe school fees.
//   npm run demo-students          five of them
//   npm run demo-students -- 20    twenty
import sql from 'mssql';
import { config, schools } from '../src/config.js';
import { getDues } from '../src/school-db.js';

const school = schools.find(s => s.slug === 'ranchi')!;
const n = Number(process.argv[2] ?? 5);
const pool = await new sql.ConnectionPool({
  server: school.db.host, port: school.db.port, database: school.db.name, user: school.db.user, password: process.env[school.db.passwordEnv],
  options: { encrypt: true, trustServerCertificate: config.DB_TRUST_CERT === '1' },
}).connect();
// The newest students, minus those with an online payment the school has not approved yet (the pay page would show less).
const { recordset } = await pool.request().input('n', sql.Int, n * 5).query<{ adm_no: string }>(`
  SELECT TOP (@n) student_id AS adm_no FROM students
   WHERE student_id NOT IN (SELECT adm_no FROM pay_order WHERE status = 'PAID' AND approved_at IS NULL)
   ORDER BY student_id DESC`);
const found: string[] = [];
for (const { adm_no } of recordset) {
  if (found.length === n) break;
  if ((await getDues(pool, school.duesSql, adm_no))?.items.length) found.push(adm_no);
}
console.log(found.join('\n'));
await pool.close();
