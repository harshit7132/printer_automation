import { sign, safeEqual } from './crypto.js';
import { HttpError } from './util.js';

const SESSION_MS = 12 * 3600e3;
export const COOKIE = 'emitra_sid';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'emitra-admin';

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setSession(req, res, user) {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + SESSION_MS })).toString('base64url');
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    maxAge: SESSION_MS,
    path: '/api/admin',
  });
}

export function clearSession(req, res) {
  res.clearCookie(COOKIE, { path: '/api/admin', httpOnly: true, sameSite: 'strict', secure: req.secure });
}

function readSession(req) {
  const tok = parseCookies(req)[COOKIE];
  if (!tok || tok.length > 1000) return null;
  const [payload, mac] = tok.split('.');
  if (!payload || !mac || !safeEqual(mac, sign(payload))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}

/** Requires a valid admin session; state-changing requests must carry the custom header (CSRF guard). */
export function requireAdmin(req, res, next) {
  if (req.method !== 'GET' && req.get(CSRF_HEADER) !== CSRF_VALUE) return next(new HttpError(403, 'csrf', 'Request blocked'));
  const s = readSession(req);
  if (!s) return next(new HttpError(401, 'auth', 'Please log in'));
  req.admin = s;
  next();
}
