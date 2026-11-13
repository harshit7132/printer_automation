import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { db, getSettings, setSetting, audit } from '../db.js';
import { safeEqual, randomId } from '../crypto.js';
import { requireAdmin, setSession, clearSession } from '../auth.js';
import { processUpload, storeFile, readStored, purgeOrderFiles, cleanupTmp, fileName, TMP_DIR, MAX_FILE_MB } from '../files.js';
import { loadOrder, adminView, setStatus, FINAL } from '../orders.js';
import { listPrinters, testPage, workerStatus, kick, continueAfterFlip, resetStages } from '../printer.js';
import { ALL_PAPERS } from '../printopts.js';
import { HttpError, asyncH, cleanText, clampInt, rupeesToPaise, isId, contentDisposition } from '../util.js';

const r = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60e3,
  limit: 8,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: { code: 'rate_limited', message: 'Too many login attempts. Try again in 15 minutes.' } }),
});

r.post('/login', loginLimiter, asyncH(async (req, res) => {
  const { username, password } = req.body || {};
  const userOk = typeof username === 'string' && safeEqual(username.trim().toLowerCase(), config.adminUser);
  // Always run bcrypt so response time doesn't reveal whether the username was right.
  const passOk = typeof password === 'string' && password.length < 200 && (await bcrypt.compare(password, config.adminPassHash));
  if (!userOk || !passOk) {
    audit('system', 'login_failed', null, req.ip);
    throw new HttpError(401, 'bad_login', 'Wrong username or password');
  }
  setSession(req, res, config.adminUser);
  audit('admin', 'login', null, req.ip);
  res.json({ ok: true });
}));

r.use(requireAdmin);

r.post('/logout', (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

r.get('/me', (req, res) => res.json({ user: req.admin.u }));

// ---------- Dashboard ----------
r.get('/summary', (req, res) => {
  const count = (sql, ...a) => db.prepare(sql).get(...a).n;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const s = getSettings();
  res.json({
    pending: count("SELECT COUNT(*) n FROM orders WHERE status = 'payment_submitted'"),
    awaiting: count("SELECT COUNT(*) n FROM orders WHERE status = 'awaiting_payment'"),
    queued: count("SELECT COUNT(*) n FROM orders WHERE status IN ('queued','printing','flip_needed')"),
    customers: count("SELECT COUNT(*) n FROM customers WHERE provider != 'anonymous'"),
    failed: count("SELECT COUNT(*) n FROM orders WHERE status = 'failed'"),
    design: count("SELECT COUNT(*) n FROM orders WHERE type='design' AND status = 'in_progress'"),
    ordersToday: count('SELECT COUNT(*) n FROM orders WHERE created_at >= ?', startOfDay.getTime()),
    revenueToday: db.prepare('SELECT COALESCE(SUM(amount),0) n FROM orders WHERE verified_at >= ?').get(startOfDay.getTime()).n,
    queuePaused: s.queue_paused === '1',
    printerName: s.printer_name || '(Windows default)',
    upiReady: !!s.upi_id,
    worker: workerStatus(),
  });
});

const VIEWS = {
  pending: "status IN ('payment_submitted','awaiting_payment') ORDER BY CASE status WHEN 'payment_submitted' THEN 0 ELSE 1 END, paid_at, created_at",
  queue: "type = 'print' AND status IN ('printing','flip_needed','queued','failed') ORDER BY CASE status WHEN 'printing' THEN 0 WHEN 'flip_needed' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END, verified_at",
  design: "type = 'design' AND status IN ('in_progress') ORDER BY verified_at",
  history: '1=1 ORDER BY created_at DESC LIMIT 300',
};

r.get('/orders', (req, res) => {
  const where = VIEWS[req.query.view] || VIEWS.history;
  let list = db.prepare(`SELECT * FROM orders WHERE ${where}`).all().map(adminView);
  const q = cleanText(req.query.q, 60).toLowerCase();
  if (q) {
    list = list.filter((o) => [o.code, o.customer.name, o.customer.phone, o.customer.utr].some((x) => x && String(x).toLowerCase().includes(q)));
  }
  res.json(list);
});

r.get('/orders/:id', (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) throw new HttpError(404, 'not_found', 'Order not found');
  res.json(adminView(o));
});

r.post('/orders/:id/action', asyncH(async (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) throw new HttpError(404, 'not_found', 'Order not found');
  const action = req.body?.action;
  const note = cleanText(req.body?.note, 300);
  const bad = () => { throw new HttpError(409, 'bad_state', `Cannot ${action} an order that is ${o.status}`); };
  const t = Date.now();

  switch (action) {
    case 'verify': // payment confirmed (UPI or cash)
      if (!['payment_submitted', 'awaiting_payment'].includes(o.status)) bad();
      setStatus(o.id, o.type === 'print' ? 'queued' : 'in_progress', { verified_at: t, paid_at: o.paid_at || t, admin_note: null });
      if (o.type === 'print') kick();
      break;
    case 'payment_missing':
      if (o.status !== 'payment_submitted') bad();
      setStatus(o.id, 'awaiting_payment', { admin_note: note || 'Payment not found. Please check the UTR / transaction ID and try again.' });
      break;
    case 'reject':
      if (FINAL.includes(o.status) || o.status === 'printing') bad();
      setStatus(o.id, 'rejected', { admin_note: note || null, done_at: t });
      purgeOrderFiles(o.id);
      break;
    case 'reprint':
      if (o.type !== 'print' || !['printed', 'failed'].includes(o.status)) bad();
      if (!db.prepare("SELECT 1 FROM files WHERE order_id = ? AND kind='print' AND purged = 0").get(o.id)) {
        throw new HttpError(409, 'purged', 'Files were already deleted for privacy');
      }
      resetStages(o.id);
      setStatus(o.id, 'queued', { verified_at: t, error: null });
      kick();
      break;
    case 'continue': // owner flipped the pages for a manual two-sided job
      if (o.status !== 'flip_needed') bad();
      continueAfterFlip(o);
      break;
    case 'top': {
      if (o.status !== 'queued') bad();
      const min = db.prepare("SELECT MIN(verified_at) m FROM orders WHERE status = 'queued'").get().m;
      setStatus(o.id, 'queued', { verified_at: (min ?? t) - 1 });
      break;
    }
    case 'cancel':
      if (!['queued', 'failed', 'in_progress', 'flip_needed'].includes(o.status)) bad();
      setStatus(o.id, 'cancelled', { admin_note: note || null, done_at: t });
      break;
    case 'complete':
      if (o.type !== 'design' || o.status !== 'in_progress') bad();
      setStatus(o.id, 'completed', { done_at: t });
      break;
    case 'printed': // owner confirms a failed/interrupted job actually came out fine
      if (o.status !== 'failed') bad();
      setStatus(o.id, 'printed', { done_at: t, error: null });
      break;
    default:
      throw new HttpError(400, 'bad_action', 'Unknown action');
  }
  audit('admin', action, o.id, `${o.code}${note ? ' — ' + note : ''}`);
  res.json(adminView(loadOrder(o.id)));
}));

r.delete('/orders/:id', (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) throw new HttpError(404, 'not_found', 'Order not found');
  if (o.status === 'printing') throw new HttpError(409, 'bad_state', 'Wait until printing finishes');
  purgeOrderFiles(o.id);
  db.prepare('DELETE FROM files WHERE order_id = ?').run(o.id);
  db.prepare('DELETE FROM orders WHERE id = ?').run(o.id);
  audit('admin', 'deleted', null, o.code);
  res.json({ ok: true });
});

r.get('/files/:fid', (req, res) => {
  const f = isId(req.params.fid) && db.prepare('SELECT * FROM files WHERE id = ? AND purged = 0').get(req.params.fid);
  if (!f) throw new HttpError(404, 'not_found', 'File not found or already deleted');
  res.set('Content-Type', f.mime);
  res.set('Content-Disposition', contentDisposition(fileName(f)));
  res.send(readStored(f.id));
});

const upload = multer({
  storage: multer.diskStorage({ destination: TMP_DIR, filename: (req, file, cb) => cb(null, randomId(12)) }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 10 },
});

r.post('/orders/:id/deliver', upload.array('files', 10), asyncH(async (req, res) => {
  try {
    const o = loadOrder(req.params.id);
    if (!o || o.type !== 'design') throw new HttpError(404, 'not_found', 'Design order not found');
    if (!['in_progress', 'completed'].includes(o.status)) throw new HttpError(409, 'bad_state', 'Verify the payment first');
    const files = req.files || [];
    if (!files.length) throw new HttpError(400, 'no_files', 'Choose files to deliver');
    const start = db.prepare("SELECT COUNT(*) n FROM files WHERE order_id = ? AND kind = 'delivery'").get(o.id).n;
    for (const [i, f] of files.entries()) storeFile(o.id, 'delivery', await processUpload(f, 'design'), start + i);
    audit('admin', 'delivered', o.id, `${o.code} (${files.length} files)`);
    res.json(adminView(loadOrder(o.id)));
  } finally {
    cleanupTmp(req);
  }
}));

// ---------- Printer & queue ----------
r.get('/printers', asyncH(async (req, res) => res.json(await listPrinters())));

r.post('/queue', (req, res) => {
  setSetting('queue_paused', req.body?.paused ? 1 : 0);
  audit('admin', req.body?.paused ? 'queue_paused' : 'queue_resumed');
  if (!req.body?.paused) kick();
  res.json({ paused: !!req.body?.paused });
});

r.post('/test-print', asyncH(async (req, res) => {
  const s = getSettings();
  await testPage(s.shop_name, s.printer_name);
  res.json({ ok: true });
}));

// ---------- Settings ----------
r.get('/settings', (req, res) => {
  const s = getSettings();
  res.json({
    shopName: s.shop_name,
    upiId: s.upi_id,
    payeeName: s.payee_name,
    priceBw: Number(s.price_bw) / 100,
    priceColor: Number(s.price_color) / 100,
    acceptingPrint: s.accepting_print === '1',
    acceptingDesign: s.accepting_design === '1',
    noticeEn: s.notice_en,
    noticeHi: s.notice_hi,
    printerName: s.printer_name,
    maxBanners: Number(s.max_banners),
    defaultLang: s.default_lang,
    printMode: config.printMode,
    retentionHours: config.fileRetentionHours,
    allPapers: ALL_PAPERS,
    paperSizes: s.paper_sizes.split(',').filter(Boolean),
    autoDuplex: s.auto_duplex === '1',
    flipReverse: s.flip_reverse === '1',
    flipTextEn: s.flip_text_en,
    flipTextHi: s.flip_text_hi,
  });
});

r.put('/settings', (req, res) => {
  const b = req.body || {};
  const set = (k, v) => v !== undefined && setSetting(k, v);
  if (b.shopName !== undefined) set('shop_name', cleanText(b.shopName, 60, { required: true, field: 'Shop name' }));
  if (b.upiId !== undefined) {
    const u = cleanText(b.upiId, 100);
    if (u && !/^[a-zA-Z0-9._-]{2,64}@[a-zA-Z0-9.-]{2,64}$/.test(u)) throw new HttpError(400, 'bad_upi', 'UPI ID looks wrong (example: name@okhdfcbank)');
    set('upi_id', u);
  }
  if (b.payeeName !== undefined) set('payee_name', cleanText(b.payeeName, 60));
  if (b.priceBw !== undefined) set('price_bw', rupeesToPaise(b.priceBw, 100000));
  if (b.priceColor !== undefined) set('price_color', rupeesToPaise(b.priceColor, 100000));
  if (b.acceptingPrint !== undefined) set('accepting_print', b.acceptingPrint ? 1 : 0);
  if (b.acceptingDesign !== undefined) set('accepting_design', b.acceptingDesign ? 1 : 0);
  if (b.noticeEn !== undefined) set('notice_en', cleanText(b.noticeEn, 200));
  if (b.noticeHi !== undefined) set('notice_hi', cleanText(b.noticeHi, 200));
  if (b.printerName !== undefined) set('printer_name', cleanText(b.printerName, 200));
  if (b.maxBanners !== undefined) set('max_banners', clampInt(b.maxBanners, 0, 10, 3));
  if (b.defaultLang !== undefined) set('default_lang', b.defaultLang === 'en' ? 'en' : 'hi');
  if (b.paperSizes !== undefined) {
    const list = (Array.isArray(b.paperSizes) ? b.paperSizes : []).filter((p) => ALL_PAPERS.includes(p));
    if (!list.length) throw new HttpError(400, 'bad_paper', 'Choose at least one paper size');
    set('paper_sizes', list.join(','));
  }
  if (b.autoDuplex !== undefined) set('auto_duplex', b.autoDuplex ? 1 : 0);
  if (b.flipReverse !== undefined) set('flip_reverse', b.flipReverse ? 1 : 0);
  if (b.flipTextEn !== undefined) set('flip_text_en', cleanText(b.flipTextEn, 400));
  if (b.flipTextHi !== undefined) set('flip_text_hi', cleanText(b.flipTextHi, 400));
  audit('admin', 'settings_changed');
  res.json({ ok: true });
});

// ---------- Packages & banners ----------
const THEMES = ['violet', 'coral', 'green', 'gold', 'blue'];
function packageFrom(b) {
  return [
    cleanText(b.name_en, 60, { required: true, field: 'Name (English)' }),
    cleanText(b.name_hi, 60),
    cleanText(b.desc_en, 200),
    cleanText(b.desc_hi, 200),
    rupeesToPaise(b.price ?? 0),
    b.active === false ? 0 : 1,
    clampInt(b.sort, 0, 999, 0),
  ];
}
function bannerFrom(b) {
  return [
    cleanText(b.title_en, 60, { required: true, field: 'Title (English)' }),
    cleanText(b.title_hi, 60),
    cleanText(b.text_en, 140),
    cleanText(b.text_hi, 140),
    THEMES.includes(b.theme) ? b.theme : 'violet',
    b.active === false ? 0 : 1,
    clampInt(b.sort, 0, 999, 0),
  ];
}

r.get('/packages', (req, res) => res.json(db.prepare('SELECT * FROM packages ORDER BY sort, id').all()));
r.post('/packages', (req, res) => {
  const { lastInsertRowid } = db.prepare('INSERT INTO packages (name_en, name_hi, desc_en, desc_hi, price, active, sort) VALUES (?,?,?,?,?,?,?)').run(...packageFrom(req.body || {}));
  audit('admin', 'package_added');
  res.json({ id: Number(lastInsertRowid) });
});
r.put('/packages/:id', (req, res) => {
  db.prepare('UPDATE packages SET name_en=?, name_hi=?, desc_en=?, desc_hi=?, price=?, active=?, sort=? WHERE id=?').run(...packageFrom(req.body || {}), clampInt(req.params.id, 1, 1e9, 0));
  res.json({ ok: true });
});
r.delete('/packages/:id', (req, res) => {
  db.prepare('DELETE FROM packages WHERE id = ?').run(clampInt(req.params.id, 1, 1e9, 0));
  res.json({ ok: true });
});

r.get('/banners', (req, res) => res.json(db.prepare('SELECT * FROM banners ORDER BY sort, id').all()));
r.post('/banners', (req, res) => {
  const { lastInsertRowid } = db.prepare('INSERT INTO banners (title_en, title_hi, text_en, text_hi, theme, active, sort) VALUES (?,?,?,?,?,?,?)').run(...bannerFrom(req.body || {}));
  audit('admin', 'banner_added');
  res.json({ id: Number(lastInsertRowid) });
});
r.put('/banners/:id', (req, res) => {
  db.prepare('UPDATE banners SET title_en=?, title_hi=?, text_en=?, text_hi=?, theme=?, active=?, sort=? WHERE id=?').run(...bannerFrom(req.body || {}), clampInt(req.params.id, 1, 1e9, 0));
  res.json({ ok: true });
});
r.delete('/banners/:id', (req, res) => {
  db.prepare('DELETE FROM banners WHERE id = ?').run(clampInt(req.params.id, 1, 1e9, 0));
  res.json({ ok: true });
});

// ---------- Shop QR & audit ----------
r.get('/shop-qr', asyncH(async (req, res) => {
  const url = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  res.json({ url, qr: await QRCode.toDataURL(url + '/', { margin: 1, width: 720, errorCorrectionLevel: 'Q' }) });
}));

r.get('/audit', (req, res) => {
  res.json(db.prepare('SELECT at, actor, action, order_id, detail FROM audit ORDER BY id DESC LIMIT 200').all());
});

export default r;
