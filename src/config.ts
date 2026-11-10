import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// ---- environment variables (all of them, validated once at startup) ----
const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  MOCK_GATEWAY: z.enum(['0', '1']).default('0'),
  TRUST_PROXY: z.enum(['0', '1']).default('0'),   // 1 when behind nginx/ALB so rate limiting sees the real client IP
  DB_TRUST_CERT: z.enum(['0', '1']).default('0'), // 1 = accept the SQL Server's self-signed certificate (dev)
  LOG_LEVEL: z.string().default('info'),
  // Receipt emails, straight through an SMTP provider. Unset = no emails. e.g. smtps://user:pass@smtp.gmail.com:465
  SMTP_URL: z.string().optional().transform(v => v || undefined),
  MAIL_FROM: z.string().default('Facts Pay <receipts@facts-pay.local>'),
});
export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;

// ---- files next to src/ (dev, tests) and dist/ (production): both sit one level below the project root ----
const root = new URL('../', import.meta.url);
/** The hosted pay page + per-school branding (public/schools/<slug>/logo.png). */
export const publicDir = fileURLToPath(new URL('public/', root));

// ---- the schools we serve: schools.json. Onboarding a school = its schools-sql/<slug>.sql + one entry here ----
const login = z.object({
  user: z.string().min(1),
  passwordEnv: z.string().min(1),     // NAME of the env var holding the password. Passwords never go in this file.
});
const schoolSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{1,50}$/),
  name: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Websites allowed to iframe the pay page. The first one is "the school's website". Sent in a response header. */
  origins: z.array(z.string().regex(/^https?:\/\/[a-z0-9.-]+(:\d+)?$/)),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  /** Part payment: the least a parent may pay of each due, as a percentage of it. Leave out = every due in full only. */
  minPayPercent: z.int().min(1).max(100).default(100),
  db: login.extend({                  // the web login: may only run the pay_* procedures
    host: z.string().min(1),
    port: z.number().default(1433),
    name: z.string().min(1),
    /** A db_owner login, used ONLY by `npm run db:deploy` / `db:status` to install the SQL. Never by the API.
     *  Leave it out only where the web login itself owns the database (the demo copy on Heroku), never for a real school. */
    admin: login.optional(),
  }),
});
export type School = z.infer<typeof schoolSchema>;

export const schools: School[] = z.array(schoolSchema)
  .refine(list => new Set(list.map(s => s.slug)).size === list.length, 'schools.json: duplicate slug')
  .parse(JSON.parse(readFileSync(new URL('schools.json', root), 'utf8')));
