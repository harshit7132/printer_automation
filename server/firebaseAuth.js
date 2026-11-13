// Verifies Firebase Authentication ID tokens (RS256 JWTs) without extra dependencies.
// Spec: https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library
import crypto from 'node:crypto';
import { config } from './config.js';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const SKEW_S = 60;
let keys = new Map(); // kid -> KeyObject
let keysExpire = 0;
let lastFetch = 0;

export const accountsEnabled = () => !!(config.firebase.projectId && config.firebase.apiKey);

async function loadKeys(force = false) {
  const now = Date.now();
  if (!force && keys.size && now < keysExpire) return;
  if (force && now - lastFetch < 30_000) return; // don't hammer Google on bad tokens
  lastFetch = now;
  const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Could not fetch Firebase signing keys');
  const maxAge = Number((res.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || 3600);
  const { keys: list } = await res.json();
  const next = new Map();
  for (const jwk of list) next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
  keys = next;
  keysExpire = now + maxAge * 1000;
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/** Returns { uid, provider, isAnonymous, email, name } or throws. */
export async function verifyIdToken(token) {
  if (!accountsEnabled()) throw new Error('accounts disabled');
  if (typeof token !== 'string' || token.length > 4096) throw new Error('bad token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('bad token');
  const [h, p, s] = parts;
  const header = b64json(h);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('bad token header');

  await loadKeys();
  let key = keys.get(header.kid);
  if (!key) {
    await loadKeys(true);
    key = keys.get(header.kid);
  }
  if (!key) throw new Error('unknown signing key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('bad signature');

  const c = b64json(p);
  const now = Math.floor(Date.now() / 1000);
  const pid = config.firebase.projectId;
  if (c.aud !== pid) throw new Error('wrong audience');
  if (c.iss !== `https://securetoken.google.com/${pid}`) throw new Error('wrong issuer');
  if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 128) throw new Error('bad subject');
  if (!(c.exp > now - SKEW_S)) throw new Error('token expired');
  if (!(c.iat <= now + SKEW_S)) throw new Error('token from the future');
  if (c.auth_time && !(c.auth_time <= now + SKEW_S)) throw new Error('bad auth_time');

  const provider = c.firebase?.sign_in_provider || 'unknown';
  return {
    uid: c.sub,
    provider,
    isAnonymous: provider === 'anonymous',
    email: c.email_verified || provider === 'password' ? c.email || '' : '',
    name: c.name || '',
  };
}
