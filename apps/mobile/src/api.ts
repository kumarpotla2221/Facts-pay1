export interface School { name: string; color: string; address?: string; phone?: string; email?: string; checkout?: { mode: 'demo' | 'unavailable'; message: string } }
export interface Due { id: string; label: string; paise: number; minPaise: number; lines: { label: string; paise: number }[] }
export interface Lookup { student: { name: string; cls: string; section: string }; items: Due[]; statement: { date: string; ref: string; label: string; chargedPaise: number; paidPaise: number }[] }
export interface Order { orderId: string; paise: number }
export interface Receipt { receiptNo: string; paise: number; gatewayRef: string; emailed: boolean }
export const baseUrl = (process.env.EXPO_PUBLIC_API_URL || '').replace(/\/+$/, '');
export const slug = process.env.EXPO_PUBLIC_SCHOOL_SLUG || 'ranchi';
export const demoCheckout = process.env.EXPO_PUBLIC_DEMO_CHECKOUT === '1';
export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}
export async function request(path: string, body?: unknown): Promise<Response> {
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('Set EXPO_PUBLIC_API_URL in apps/mobile/.env to your backend URL.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${baseUrl}/api/${encodeURIComponent(slug)}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new ApiError(typeof data?.error === 'string' ? data.error : `Request failed (${response.status})`, response.status);
    }
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Request timed out. Check your connection. Payment status may need checking before retrying.');
    throw error;
  } finally { clearTimeout(timer); }
}
export async function api<T>(path: string, body?: unknown): Promise<T> { return (await request(path, body)).json(); }
export function parseAmount(value: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ''] = value.trim().split('.');
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(paise) ? paise : null;
}
export const money = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
