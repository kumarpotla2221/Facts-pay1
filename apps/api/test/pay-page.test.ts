import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const script = readFileSync(new URL('../public/pay.js', import.meta.url), 'utf8');

function page(mode: 'demo' | 'unavailable' | 'error') {
  const elements = new Map<string, ReturnType<typeof element>>();
  function element() {
    const classes = new Set<string>();
    return { textContent: '', disabled: true, hidden: true, value: '100', checked: true,
      onclick: undefined as undefined | (() => Promise<void>),
      classList: { add: (s: string) => classes.add(s), remove: (s: string) => classes.delete(s), contains: (s: string) => classes.has(s) },
      addEventListener: () => {}, setAttribute: () => {}, removeAttribute: () => {},
      querySelector: () => get('lookupButton'),
    };
  }
  function get(id: string) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id)!;
  }
  const fetch = vi.fn(async () => {
    if (mode === 'error') throw new Error('Network unavailable');
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({
      name: 'Synthetic school', color: '#000000', checkout: { mode, message: mode === 'demo' ? 'Demo checkout only.' : 'Online payments are currently unavailable.' },
    }) };
  });
  const context = vm.createContext({
    fetch, location: { pathname: '/pay/ranchi' },
    document: { getElementById: get, querySelectorAll: () => [],
      documentElement: { classList: { contains: () => false }, style: { setProperty: () => {} } } },
  });
  vm.runInContext(script, context);
  const selectFee = () => vm.runInContext("items = [{id:'tuition'}]; refreshTotal();", context);
  return { get, fetch, selectFee };
}

describe('payment-page checkout availability', () => {
  it('keeps checkout disabled after fees are selected and prevents programmatic order creation', async () => {
    const p = page('unavailable');
    await vi.waitFor(() => expect(p.get('checkoutNotice').textContent).toContain('currently unavailable'));
    p.selectFee();
    expect(p.get('pay').disabled).toBe(true);
    expect(p.get('pay').textContent).toBe('Online payments unavailable');
    await p.get('pay').onclick!();
    expect(p.fetch).toHaveBeenCalledOnce(); // school info only; no order or settlement request
    expect(p.get('pay').disabled).toBe(true);
    expect(p.get('err').textContent).toContain('currently unavailable');
  });

  it('keeps checkout disabled if payment availability could not be loaded', async () => {
    const p = page('error');
    await vi.waitFor(() => expect(p.get('checkoutNotice').textContent).toContain('could not be checked'));
    p.selectFee();
    expect(p.get('pay').disabled).toBe(true);
  });

  it('enables explicitly configured demo checkout and keeps the button locked while a request is running', async () => {
    const p = page('demo');
    await vi.waitFor(() => expect(p.get('checkoutNotice').textContent).toContain('Demo checkout'));
    p.selectFee();
    expect(p.get('pay').disabled).toBe(false);
    p.get('pay').classList.add('busy');
    p.selectFee();
    expect(p.get('pay').disabled).toBe(true);
  });
});
