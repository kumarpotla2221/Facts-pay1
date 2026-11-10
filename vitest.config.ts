import { defineConfig } from 'vitest/config';

try { process.loadEnvFile('.env'); } catch { /* env already set */ }
process.env.MOCK_GATEWAY = '1';

export default defineConfig({
  test: { testTimeout: 30_000, fileParallelism: false },
});
