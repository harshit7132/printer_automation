import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { config } from '../config.js';
import { db, getSettings, nextCode, audit, tx } from '../db.js';
import { encryptJSON, decryptJSON, randomId } from '../crypto.js';
import {
  processUpload, storeFile, readStored, deleteFileRow, purgeOrderFiles, cleanupTmp, fileName, TMP_DIR, MAX_FILE_MB,
} from '../files.js';
import { loadOrder, publicView, setStatus, computePrintAmount } from '../orders.js';
import { notifyOwner } from '../notify.js';
import { capabilities, normalizeOptions, readOpts } from '../printopts.js';
import { continueAfterFlip } from '../printer.js';
import { accountsEnabled } from '../customers.js';
import { emitOrderUpdate, orderEvents } from '../events.js';
import { HttpError, asyncH, cleanText, cleanPhone, clampInt, isId, contentDisposition } from '../util.js';

export const SERVICES = ['logo', 'visiting', 'wedding', 'banner', 'poster', 'social', 'biodata', 'other'];
const r = Router();

const limited = (req, res) => res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests. Please wait a few minutes.' } });
const lim = (windowMin, limit) => rateLimit({ windowMs: windowMin * 60e3, limit, standardHeaders: 'draft-7', legacyHeaders: false, handler: limited });
const createLimiter = lim(60, 30);
const actionLimiter = lim(15, 40);
const readLimiter = lim(5, 400);

const upload = multer({
  storage: multer.diskStorage({ destination: TMP_DIR, filename: (req, file, cb) => cb(null, randomId(12)) }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 20, fields: 40, fieldSize: 16 * 1024, parts: 70 },
});

function mustLoad(id) {
  const o = loadOrder(id);
  if (!o) throw new HttpError(404, 'not_found', 'Order not found');
  return o;
}

r.get('/config', readLimiter, (req, res) => {
  const s = getSettings();
  res.json({
    shopName: s.shop_name,
    notice: { en: s.notice_en, hi: s.notice_hi },
    prices: { bw: Number(s.price_bw), color: Number(s.price_color) },
    accepting: { print: s.accepting_print === '1', design: s.accepting_design === '1' },
    defaultLang: s.default_lang,
    retentionHours: config.fileRetentionHours,
    maxFileMb: MAX_FILE_MB,
    services: SERVICES,
    caps: capabilities(s),
    accounts: accountsEnabled() ? { ...config.firebase } : null,
    packages: db.prepare('SELECT id, name_en, name_hi, desc_en, desc_hi, price FROM packages WHERE active = 1 ORDER BY sort, id').all(),
    banners: db.prepare('SELECT id, title_en, title_hi, text_en, text_hi, theme FROM banners WHERE active = 1 ORDER BY sort, id LIMIT ?')
      .all(clampInt(s.max_banners, 0, 10, 3)),
  });
});

// ---------- Print orders ----------
r.post('/print-orders', createLimiter, upload.array('files', 20), asyncH(async (req, res) => {
  try {
    const s = getSettings();
    if (s.accepting_print !== '1') throw new HttpError(403, 'closed_print', 'Printing is paused right now');
    const name = cleanText(req.body.name, 60, { required: true, field: 'name' });
    const phone = cleanPhone(req.body.phone);
    const notes = cleanText(req.body.notes, 300);
    const files = req.files || [];
    if (!files.length) throw new HttpError(400, 'no_files', 'Please choose at least one file');

    const processed = [];
    for (const f of files) processed.push(await processUpload(f, 'print'));

    const id = randomId(16);
    const t = Date.now();
    const code = tx(() => {
      const c = nextCode('print');
      db.prepare('INSERT INTO orders (id, code, type, status, amount, pii, customer_uid, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, c, 'print', 'draft', 0, encryptJSON({ name, phone, notes }), req.customer?.uid ?? null, t, t);
      return c;
    });
    processed.forEach((p, i) => storeFile(id, 'print', p, i));
    db.prepare('UPDATE orders SET amount = ? WHERE id = ?').run(computePrintAmount(id, s), id);
    audit('customer', 'created', id, `${code} (${files.length} files)`);
    emitOrderUpdate(id);
    res.json(await publicView(loadOrder(id)));
  } finally {
    cleanupTmp(req);
  }
}));

r.put('/orders/:id/print-options', actionLimiter, asyncH(async (req, res) => {
  const o = mustLoad(req.params.id);
  if (o.type !== 'print' || !['draft', 'awaiting_payment'].includes(o.status)) throw new HttpError(409, 'bad_state', 'Options can no longer be changed');
  const wanted = Array.isArray(req.body?.files) ? req.body.files : [];
  const byId = new Map(wanted.filter((f) => f && isId(f.id)).map((f) => [f.id, f]));
  const existing = db.prepare("SELECT * FROM files WHERE order_id = ? AND kind = 'print'").all(o.id);
  if (!existing.some((f) => byId.has(f.id))) throw new HttpError(400, 'no_files', 'Keep at least one file');

  const caps = capabilities(getSettings());
  const upd = db.prepare('UPDATE files SET copies = ?, color = ?, duplex = ?, opts = ?, sel_pages = ? WHERE id = ?');
  const normalized = [];
  for (const f of existing) {
    const w = byId.get(f.id);
    if (!w) continue;
    normalized.push([f, normalizeOptions(w, f, caps, !!readOpts(f).encrypted)]); // throws on a bad page range
  }
  for (const f of existing) if (!byId.has(f.id)) deleteFileRow(f);
  for (const [f, n] of normalized) upd.run(n.copies, n.color, n.duplex, JSON.stringify(n.opts), n.selPages, f.id);
  const amount = computePrintAmount(o.id);
  setStatus(o.id, 'awaiting_payment', { amount });
  res.json(await publicView(loadOrder(o.id)));
}));

// ---------- Design orders ----------
r.post('/design-orders', createLimiter, upload.fields([{ name: 'resources', maxCount: 12 }, { name: 'references', maxCount: 6 }]), asyncH(async (req, res) => {
  try {
    const s = getSettings();
    if (s.accepting_design !== '1') throw new HttpError(403, 'closed_design', 'Design orders are paused right now');
    const b = req.body;
    const name = cleanText(b.name, 60, { required: true, field: 'name' });
    const phone = cleanPhone(b.phone);
    const email = cleanText(b.email, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'bad_email', 'Invalid email');
    const service = SERVICES.includes(b.service) ? b.service : null;
    if (!service) throw new HttpError(400, 'required', 'Choose a service', { field: 'service' });
    const pkg = db.prepare('SELECT * FROM packages WHERE id = ? AND active = 1').get(clampInt(b.packageId, 1, 1e9, 0));
    if (!pkg) throw new HttpError(400, 'required', 'Choose a package', { field: 'package' });
    const brief = {
      service,
      packageId: pkg.id,
      packageName: pkg.name_en,
      packageNameHi: pkg.name_hi,
      title: cleanText(b.title, 150, { required: true, field: 'title' }),
      description: cleanText(b.description, 3000, { required: true, field: 'description' }),
      textContent: cleanText(b.textContent, 3000),
      size: cleanText(b.size, 40),
      customSize: cleanText(b.customSize, 60),
      colors: cleanText(b.colors, 120),
      deadline: /^\d{4}-\d{2}-\d{2}$/.test(b.deadline || '') ? b.deadline : '',
    };
    const resources = req.files?.resources || [];
    const references = req.files?.references || [];
    const procRes = [];
    for (const f of resources) procRes.push(await processUpload(f, 'design'));
    const procRef = [];
    for (const f of references) procRef.push(await processUpload(f, 'design'));

    const id = randomId(16);
    const t = Date.now();
    const code = tx(() => {
      const c = nextCode('design');
      db.prepare('INSERT INTO orders (id, code, type, status, amount, pii, meta, customer_uid, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, c, 'design', 'awaiting_payment', pkg.price, encryptJSON({ name, phone, email }), encryptJSON(brief), req.customer?.uid ?? null, t, t);
      return c;
    });
    procRes.forEach((p, i) => storeFile(id, 'resource', p, i));
    procRef.forEach((p, i) => storeFile(id, 'reference', p, i));
    audit('customer', 'created', id, code);
    emitOrderUpdate(id);
    res.json(await publicView(loadOrder(id)));
  } finally {
    cleanupTmp(req);
  }
}));

// ---------- Shared ----------
r.get('/orders/:id', readLimiter, asyncH(async (req, res) => {
  res.json(await publicView(mustLoad(req.params.id)));
}));

r.get('/orders/:id/events', asyncH(async (req, res) => {
  const o = mustLoad(req.params.id);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.flushHeaders) res.flushHeaders();

  const send = async () => {
    try {
      const current = loadOrder(req.params.id);
      if (!current) return res.end();
      const payload = JSON.stringify(await publicView(current));
      res.write(`event: order\ndata: ${payload}\n\n`);
    } catch {
      /* client disconnected */
    }
  };

  await send();

  const handler = () => { send(); };
  orderEvents.on(`order:${o.id}`, handler);

  const ping = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    orderEvents.off(`order:${o.id}`, handler);
  });
}));

r.post('/orders/:id/payment', actionLimiter, asyncH(async (req, res) => {
  const o = mustLoad(req.params.id);
  if (o.status !== 'awaiting_payment') throw new HttpError(409, 'bad_state', 'This order is not waiting for payment');
  const utr = String(req.body?.utr || '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z0-9]{6,30}$/.test(utr)) throw new HttpError(400, 'bad_utr', 'Enter the transaction ID from your payment app');
  const pii = decryptJSON(o.pii) || {};
  pii.utr = utr;
  setStatus(o.id, 'payment_submitted', { pii: encryptJSON(pii), paid_at: Date.now(), admin_note: null });
  audit('customer', 'payment_submitted', o.id, o.code);
  notifyOwner(`💰 Verify payment\n${o.code} • ₹${(o.amount / 100).toFixed(2)}\nUTR: ${utr}`);
  res.json(await publicView(loadOrder(o.id)));
}));

r.post('/orders/:id/cash', actionLimiter, asyncH(async (req, res) => {
  const o = mustLoad(req.params.id);
  if (o.status !== 'awaiting_payment') throw new HttpError(409, 'bad_state', 'This order is not waiting for payment');
  const pii = decryptJSON(o.pii) || {};
  pii.paymentMode = 'cash';
  setStatus(o.id, 'payment_submitted', { pii: encryptJSON(pii), paid_at: Date.now(), admin_note: null });
  audit('customer', 'cash_submitted', o.id, o.code);
  notifyOwner(`💵 Cash payment\n${o.code} • ₹${(o.amount / 100).toFixed(2)}\nCollect cash at counter`);
  res.json(await publicView(loadOrder(o.id)));
}));

// Manual two-sided printing: the customer has turned the stack over and put it back in the tray.
r.post('/orders/:id/continue', actionLimiter, asyncH(async (req, res) => {
  const o = mustLoad(req.params.id);
  if (o.status !== 'flip_needed') throw new HttpError(409, 'bad_state', 'Nothing to continue');
  continueAfterFlip(o);
  audit('customer', 'flip_continue', o.id, o.code);
  res.json(await publicView(loadOrder(o.id)));
}));

r.post('/orders/:id/cancel', actionLimiter, asyncH(async (req, res) => {
  const o = mustLoad(req.params.id);
  if (!['draft', 'awaiting_payment'].includes(o.status)) throw new HttpError(409, 'bad_state', 'This order can no longer be cancelled');
  purgeOrderFiles(o.id);
  setStatus(o.id, 'cancelled');
  audit('customer', 'cancelled', o.id, o.code);
  res.json(await publicView(loadOrder(o.id)));
}));

r.get('/orders/:id/download/:fid', readLimiter, asyncH(async (req, res) => {
  const o = mustLoad(req.params.id);
  const f = isId(req.params.fid) && db.prepare("SELECT * FROM files WHERE id = ? AND order_id = ? AND kind = 'delivery' AND purged = 0").get(req.params.fid, o.id);
  if (!f || o.status !== 'completed') throw new HttpError(404, 'not_found', 'File not found');
  res.set('Content-Type', f.mime);
  res.set('Content-Disposition', contentDisposition(fileName(f)));
  res.send(readStored(f.id));
}));

export default r;
