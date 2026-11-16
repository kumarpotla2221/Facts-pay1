import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.resetModules(); });

async function client() {
  vi.stubEnv('EXPO_PUBLIC_API_URL', 'http://localhost:4000/');
  vi.stubEnv('EXPO_PUBLIC_SCHOOL_SLUG', 'ranchi');
  return import('../src/api.js');
}

describe('mobile API (no database)', () => {
  it('sends admission numbers in the body and normalizes the base URL', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] })));
    vi.stubGlobal('fetch', fetch);
    const { api } = await client();
    expect(await api('dues', { adm: '26/39' })).toEqual({ items: [] });
    expect(fetch).toHaveBeenCalledWith('http://localhost:4000/api/ranchi/dues', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ adm: '26/39' }),
    }));
  });

  it('distinguishes a confirmed failed payment from an uncertain connection failure', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Payment failed, nothing was charged' }), { status: 402 }))
      .mockRejectedValueOnce(new TypeError('Network request failed'));
    vi.stubGlobal('fetch', fetch);
    const { api, ApiError } = await client();
    const failed = await api('orders/example/pay', { outcome: 'fail' }).catch(error => error);
    expect(failed).toBeInstanceOf(ApiError);
    if (!(failed instanceof ApiError)) throw new Error('Expected a confirmed API failure');
    expect(failed.status).toBe(402);
    const uncertain = await api('orders/example/pay', { outcome: 'success' }).catch(error => error);
    expect(uncertain).not.toBeInstanceOf(ApiError);
  });

  it('handles non-JSON and null error responses', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('Gateway unavailable', { status: 502 }))
      .mockResolvedValueOnce(new Response('null', { status: 500 })));
    const { request } = await client();
    await expect(request('info')).rejects.toMatchObject({ status: 502, message: 'Request failed (502)' });
    await expect(request('info')).rejects.toMatchObject({ status: 500, message: 'Request failed (500)' });
  });

  it('aborts stalled connections and reports uncertain payment status', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const { request } = await client();
    const check = expect(request('info')).rejects.toThrow('Payment status may need checking');
    await vi.advanceTimersByTimeAsync(20000);
    await check;
  });

  it('validates exact paise amounts without rounding invalid input', async () => {
    const { parseAmount, money } = await client();
    expect(parseAmount(' 123.45 ')).toBe(12345);
    expect(parseAmount('0.01')).toBe(1);
    for (const value of ['', '-1', '1.001', '1e3', 'NaN', '9007199254740992']) expect(parseAmount(value)).toBeNull();
    expect(money(12345)).toBe('\u20b9123.45');
  });
});
