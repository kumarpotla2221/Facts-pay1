import sql from 'mssql';
import type { School } from './config.js';
import { HttpError } from './errors.js';

/** slug -> school (from schools.json) and a connection pool to THAT school's own database. */
export class Schools {
  // ponytail: one small pool per school, opened on first use and kept open. With hundreds of schools,
  // close pools that have been idle for a while.
  private pools = new Map<string, Promise<sql.ConnectionPool>>();

  constructor(private list: School[], private opts: { trustCert: boolean; onPoolError: (err: Error, slug: string) => void }) {}

  get(slug: string): School {
    const school = this.list.find(s => s.slug === slug);
    if (!school) throw new HttpError(404, 'Unknown school');
    return school;
  }

  db(school: School): Promise<sql.ConnectionPool> {
    let pool = this.pools.get(school.slug);
    if (!pool) {
      const password = process.env[school.db.passwordEnv];
      if (!password) throw new Error(`Env var ${school.db.passwordEnv} (DB password of ${school.slug}) is not set`);
      const p = new sql.ConnectionPool({
        server: school.db.host,
        port: school.db.port,
        database: school.db.name,
        user: school.db.user,
        password,
        options: { encrypt: true, trustServerCertificate: this.opts.trustCert },
        pool: { max: 5 },
      });
      p.on('error', err => this.opts.onPoolError(err, school.slug));   // a dropped connection must not crash the server
      pool = p.connect();
      this.pools.set(school.slug, pool);
      pool.catch(() => this.pools.delete(school.slug));   // could not connect: try again on the next request
    }
    return pool;
  }

  async close(): Promise<void> {
    await Promise.all([...this.pools.values()].map(p => p.then(pool => pool.close(), () => {})));
  }
}
