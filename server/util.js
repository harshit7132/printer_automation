export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function cleanText(v, max = 500, { required = false, field = 'field' } = {}) {
  let s = typeof v === 'string' ? v.replace(CTRL, '').trim() : '';
  if (s.length > max) s = s.slice(0, max);
  if (required && !s) throw new HttpError(400, 'required', `${field} is required`, { field });
  return s;
}

export function cleanPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) throw new HttpError(400, 'bad_phone', 'Enter a valid 10-digit mobile number');
  return d;
}

export function clampInt(v, min, max, def) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function rupeesToPaise(v, max = 10_000_000) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'bad_price', 'Invalid price');
  return Math.min(max, Math.round(n * 100));
}

export const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{10,40}$/.test(s);

export function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
