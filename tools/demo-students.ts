// DEV ONLY. Prints a few Ranchi admission numbers you can demo with: students who still owe school fees.
//   npm run demo-students          five of them
//   npm run demo-students -- 20    twenty
import sql from 'mssql';
import { config, schools } from '../src/config.js';

const school = schools.find(s => s.slug === 'ranchi')!;
const login = school.db.admin ?? school.db;   // reads the students table, which the web login may not
const pool = await new sql.ConnectionPool({
  server: school.db.host, port: school.db.port, database: school.db.name, user: login.user, password: process.env[login.passwordEnv],
  options: { encrypt: true, trustServerCertificate: config.DB_TRUST_CERT === '1' },
}).connect();
const { recordset } = await pool.request().input('n', sql.Int, Number(process.argv[2] ?? 5)).query<{ adm_no: string }>(`
  SELECT TOP (@n) student_id AS adm_no FROM students
   WHERE dbo.pay_balance(sub_acct_code, 'tuition') > 0
     AND student_id NOT IN (SELECT adm_no FROM pay_order WHERE status = 'PAID' AND approved_at IS NULL)
   ORDER BY student_id DESC`);
console.log(recordset.map(r => r.adm_no).join('\n'));
await pool.close();
