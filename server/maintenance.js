// Privacy housekeeping: expire unpaid orders, delete finished files, erase old personal data.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { purgeOrderFiles, TMP_DIR } from './files.js';
import { setStatus } from './orders.js';

const HOUR = 3600e3;

export function runMaintenance() {
  const now = Date.now();

  for (const o of db.prepare("SELECT id FROM orders WHERE status IN ('draft','awaiting_payment') AND updated_at < ?").all(now - 24 * HOUR)) {
    purgeOrderFiles(o.id);
    setStatus(o.id, 'expired');
  }

  const finished = db.prepare(`
    SELECT DISTINCT o.id FROM orders o JOIN files f ON f.order_id = o.id AND f.purged = 0
    WHERE o.status IN ('printed','completed','rejected','cancelled','expired') AND o.updated_at < ?`)
    .all(now - config.fileRetentionHours * HOUR);
  for (const o of finished) purgeOrderFiles(o.id);

  db.prepare(`UPDATE orders SET pii = NULL, meta = NULL
    WHERE pii IS NOT NULL AND status IN ('printed','completed','rejected','cancelled','expired') AND updated_at < ?`)
    .run(now - config.piiRetentionDays * 24 * HOUR);

  db.prepare('DELETE FROM audit WHERE at < ?').run(now - 180 * 24 * HOUR);

  for (const name of fs.readdirSync(TMP_DIR)) {
    const p = path.join(TMP_DIR, name);
    try {
      if (fs.statSync(p).mtimeMs < now - HOUR) fs.rmSync(p, { force: true });
    } catch { /* ignore */ }
  }
}

export function startMaintenance() {
  runMaintenance();
  setInterval(() => {
    try { runMaintenance(); } catch (e) { console.error('Maintenance error:', e); }
  }, HOUR / 2);
}
