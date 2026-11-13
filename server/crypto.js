// AES-256-GCM encryption for stored files and customer data, HMAC for sessions.
import crypto from 'node:crypto';
import { config } from './config.js';

const master = Buffer.from(config.masterKey, 'hex');
if (master.length !== 32) {
  console.error('✖ MASTER_KEY must be 64 hex characters. Run "npm run setup".');
  process.exit(1);
}
const derive = (label) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), label, 32));
const FILE_KEY = derive('emitra-files-v1');
const FIELD_KEY = derive('emitra-fields-v1');
// Session key is tied to the password hash, so changing the password logs everyone out.
const SESSION_KEY = crypto.createHash('sha256').update(config.sessionSecret + '|' + config.adminPassHash).digest();

function seal(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function open(key, blob) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

export const encryptBuffer = (buf) => seal(FILE_KEY, buf);
export const decryptBuffer = (blob) => open(FILE_KEY, blob);

export function encryptJSON(value) {
  return seal(FIELD_KEY, Buffer.from(JSON.stringify(value), 'utf8')).toString('base64');
}
export function decryptJSON(str) {
  if (!str) return null;
  try {
    return JSON.parse(open(FIELD_KEY, Buffer.from(str, 'base64')).toString('utf8'));
  } catch {
    return null;
  }
}

export const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');

export function sign(data) {
  return crypto.createHmac('sha256', SESSION_KEY).update(data).digest('base64url');
}

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
