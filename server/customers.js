// Signed-in customers. The browser sends its Firebase ID token as "Authorization: Bearer <token>".
// No cookies are used, so these endpoints can't be triggered cross-site (no CSRF).
import { db } from './db.js';
import { encryptJSON, decryptJSON } from './crypto.js';
import { verifyIdToken, accountsEnabled } from './firebaseAuth.js';
import { HttpError, cleanText } from './util.js';

/** Sets req.customer = { uid, provider, isAnonymous, email, name } when a valid token is sent. */
export async function attachCustomer(req, res, next) {
  req.customer = null;
  const h = req.get('authorization') || '';
  if (!h.startsWith('Bearer ') || !accountsEnabled()) return next();
  try {
    req.customer = await verifyIdToken(h.slice(7));
    touch(req.customer);
  } catch (e) {
    req.authError = e.message;
  }
  next();
}

export function requireCustomer(req, res, next) {
  if (!req.customer) return next(new HttpError(401, 'signin_required', 'Please sign in again'));
  next();
}

function touch(c) {
  const t = Date.now();
  db.prepare(`INSERT INTO customers (uid, provider, profile, created_at, last_seen) VALUES (?, ?, NULL, ?, ?)
    ON CONFLICT(uid) DO UPDATE SET provider = excluded.provider, last_seen = excluded.last_seen`)
    .run(c.uid, c.provider, t, t);
}

/** Always returns a fresh object: callers mutate it, so nothing may be shared between customers. */
export function getProfile(uid) {
  const row = db.prepare('SELECT profile FROM customers WHERE uid = ?').get(uid);
  const stored = decryptJSON(row?.profile) || {};
  return { name: '', phone: '', email: '', ...stored, prefs: { ...(stored.prefs || {}) } };
}

const PREF_KEYS = {
  color: (v) => !!v,
  sides: (v) => (['single', 'long', 'short', 'manual'].includes(v) ? v : 'single'),
  paper: (v) => cleanText(v, 10),
  orientation: (v) => (['auto', 'portrait', 'landscape'].includes(v) ? v : 'auto'),
  scale: (v) => (['fit', 'shrink', 'noscale'].includes(v) ? v : 'fit'),
};

/** Merges a partial update into the saved profile. Phone is validated by the caller's form. */
export function saveProfile(uid, patch) {
  const p = getProfile(uid);
  if (patch.name !== undefined) p.name = cleanText(patch.name, 60);
  if (patch.phone !== undefined) {
    const d = String(patch.phone || '').replace(/\D/g, '').slice(-10);
    p.phone = /^[6-9]\d{9}$/.test(d) ? d : '';
  }
  if (patch.email !== undefined) {
    const e = cleanText(patch.email, 120);
    p.email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
  }
  if (patch.prefs && typeof patch.prefs === 'object') {
    for (const [k, fn] of Object.entries(PREF_KEYS)) if (patch.prefs[k] !== undefined) p.prefs[k] = fn(patch.prefs[k]);
  }
  db.prepare('UPDATE customers SET profile = ? WHERE uid = ?').run(encryptJSON(p), uid);
  return p;
}

/** Moves a guest's orders and details into the account they just signed in to. */
export function mergeGuest(guestUid, intoUid) {
  if (guestUid === intoUid) return;
  const guest = getProfile(guestUid);
  const target = getProfile(intoUid);
  const merged = {
    name: target.name || guest.name,
    phone: target.phone || guest.phone,
    email: target.email || guest.email,
    prefs: { ...guest.prefs, ...target.prefs },
  };
  db.prepare('UPDATE orders SET customer_uid = ? WHERE customer_uid = ?').run(intoUid, guestUid);
  db.prepare('UPDATE customers SET profile = ? WHERE uid = ?').run(encryptJSON(merged), intoUid);
  db.prepare('DELETE FROM customers WHERE uid = ?').run(guestUid);
}

export function deleteCustomer(uid) {
  db.prepare('UPDATE orders SET customer_uid = NULL WHERE customer_uid = ?').run(uid);
  db.prepare('DELETE FROM customers WHERE uid = ?').run(uid);
}

export { accountsEnabled, verifyIdToken };
