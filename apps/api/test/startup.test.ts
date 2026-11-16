import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

it('finishes startup when the deployment host defers binding the HTTP server', async () => {
  const serverUrl = new URL('../src/server.ts', import.meta.url).href;
  const script = `
    import http from 'node:http';
    let onCapture;
    const captured = new Promise(resolve => { onCapture = resolve; });
    http.Server.prototype.listen = function () {
      onCapture();
      return this;
    };
    const timeout = setTimeout(() => {
      console.error('Startup waited for the host to finish binding the server');
      process.exit(1);
    }, 8000);
    await import(${JSON.stringify(serverUrl)});
    await captured;
    clearTimeout(timeout);
    console.log('startup-ready');
    process.exit(0);
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    timeout: 12000,
    env: { ...process.env, PORT: '0', LOG_LEVEL: 'silent', TRUST_PROXY: '1', MOCK_GATEWAY: '0', SMTP_URL: '', PAY_RANCHI_PASS: '' },
  });
  expect(stdout).toContain('startup-ready');
}, 20000);
