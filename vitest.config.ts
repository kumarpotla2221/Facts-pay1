import { defineConfig } from 'vitest/config';

try { process.loadEnvFile('.env'); } catch { /* env already set */ }
process.env.MOCK_GATEWAY = '1';
process.env.SCHOOL_DB_HOST = 'localhost';   // tests run on the host; schools.json names the Docker host `mssql`

export default defineConfig({
  test: { testTimeout: 30_000, fileParallelism: false },
});
