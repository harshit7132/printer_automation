import QRCode from 'qrcode';
import { config } from './config.js';
import { db, getSettings } from './db.js';
import { decryptJSON } from './crypto.js';
import { fileName } from './files.js';
import { isId } from './util.js';

export const FINAL = ['printed', 'completed', 'rejected', 'cancelled', 'expired'];
const EXTRA_COLS = new Set(['verified_at', 'paid_at', 'done_at', 'error', 'admin_note', 'amount', 'pii']);

export function loadOrder(id) {
  if (!isId(id)) return null;
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) || null;
}

export function orderFiles(orderId) {
  return db.prepare('SELECT * FROM files WHERE order_id = ? ORDER BY kind, sort, created_at').all(orderId);
}

export function setStatus(id, status, extra = {}) {
  const cols = ['status = ?', 'updated_at = ?'];
  const vals = [status, Date.now()];
  for (const [k, v] of Object.entries(extra)) {
    if (!EXTRA_COLS.has(k)) throw new Error('bad column ' + k);
    cols.push(`${k} = ?`);
    vals.push(v === undefined ? null : v);
  }
  db.prepare(`UPDATE orders SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
}

export function queuePosition(o) {
  if (o.status === 'printing') return 0;
  if (o.status !== 'queued') return null;
  const ahead = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE type='print' AND status='queued' AND verified_at < ?").get(o.verified_at).n;
  const printing = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='printing'").get().n;
  return ahead + printing + 1;
}

export function computePrintAmount(orderId, s = getSettings()) {
  const bw = Number(s.price_bw);
  const color = Number(s.price_color);
  let total = 0;
  for (const f of db.prepare("SELECT pages, copies, color FROM files WHERE order_id = ? AND kind = 'print'").all(orderId)) {
    total += f.pages * f.copies * (f.color ? color : bw);
  }
  return total;
}

export function upiLink(s, o) {
  const payee = s.payee_name || s.shop_name;
  return `upi://pay?pa=${s.upi_id}&pn=${encodeURIComponent(payee)}&am=${(o.amount / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent('Order ' + o.code)}`;
}

/** What a customer holding the order link may see. */
export async function publicView(o) {
  const s = getSettings();
  const pii = decryptJSON(o.pii) || {};
  const meta = decryptJSON(o.meta) || {};
  const files = orderFiles(o.id);
  const v = {
    id: o.id,
    code: o.code,
    type: o.type,
    status: o.status,
    amount: o.amount,
    createdAt: o.created_at,
    firstName: (pii.name || '').split(/\s+/)[0] || '',
    note: ['awaiting_payment', 'rejected'].includes(o.status) ? o.admin_note : null,
    queuePosition: queuePosition(o),
    retentionHours: config.fileRetentionHours,
    prices: { bw: Number(s.price_bw), color: Number(s.price_color) },
    files: files.filter((f) => f.kind === 'print').map((f) => ({
      id: f.id, name: fileName(f), pages: f.pages, copies: f.copies, color: !!f.color, duplex: !!f.duplex,
    })),
    uploads: files.filter((f) => f.kind === 'resource' || f.kind === 'reference').map((f) => ({ kind: f.kind, name: fileName(f), size: f.size })),
    deliveries: o.status === 'completed'
      ? files.filter((f) => f.kind === 'delivery' && !f.purged).map((f) => ({ id: f.id, name: fileName(f), size: f.size }))
      : [],
  };
  if (o.type === 'design') v.design = { service: meta.service, packageName: meta.packageName, packageNameHi: meta.packageNameHi, title: meta.title };
  if (o.status === 'awaiting_payment') {
    if (s.upi_id) {
      const link = upiLink(s, o);
      v.payment = {
        upiId: s.upi_id,
        payee: s.payee_name || s.shop_name,
        link,
        qr: await QRCode.toDataURL(link, { margin: 1, width: 360, errorCorrectionLevel: 'M' }),
      };
    } else {
      v.payment = { unavailable: true };
    }
  }
  return v;
}

/** Full view for the owner. */
export function adminView(o) {
  return {
    id: o.id,
    code: o.code,
    type: o.type,
    status: o.status,
    amount: o.amount,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    paidAt: o.paid_at,
    verifiedAt: o.verified_at,
    doneAt: o.done_at,
    error: o.error,
    adminNote: o.admin_note,
    queuePosition: queuePosition(o),
    customer: decryptJSON(o.pii) || {},
    brief: decryptJSON(o.meta) || null,
    files: orderFiles(o.id).map((f) => ({
      id: f.id, kind: f.kind, name: fileName(f), mime: f.mime, size: f.size, pages: f.pages,
      copies: f.copies, color: !!f.color, duplex: !!f.duplex, purged: !!f.purged,
    })),
  };
}
