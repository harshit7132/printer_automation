import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

for (const d of ['', 'files', 'tmp']) fs.mkdirSync(path.join(config.dataDir, d), { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'app.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,              -- print | design
    status TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0, -- paise
    pii TEXT,                        -- encrypted JSON: name, phone, email, notes, utr
    meta TEXT,                       -- encrypted JSON: design brief
    error TEXT,
    admin_note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    paid_at INTEGER,
    verified_at INTEGER,
    done_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, verified_at);
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,              -- print | resource | reference | delivery
    name TEXT NOT NULL,              -- encrypted
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    pages INTEGER NOT NULL DEFAULT 0,
    copies INTEGER NOT NULL DEFAULT 1,
    color INTEGER NOT NULL DEFAULT 0,
    duplex INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    purged INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_files_order ON files(order_id);

  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_en TEXT NOT NULL, name_hi TEXT NOT NULL DEFAULT '',
    desc_en TEXT NOT NULL DEFAULT '', desc_hi TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS banners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title_en TEXT NOT NULL, title_hi TEXT NOT NULL DEFAULT '',
    text_en TEXT NOT NULL DEFAULT '', text_hi TEXT NOT NULL DEFAULT '',
    theme TEXT NOT NULL DEFAULT 'violet',
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
    order_id TEXT, detail TEXT
  );

  -- Customer accounts (Firebase Authentication uid). Profile is encrypted.
  CREATE TABLE IF NOT EXISTS customers (
    uid TEXT PRIMARY KEY,
    provider TEXT NOT NULL,          -- anonymous | password | google.com
    profile TEXT,                    -- encrypted JSON: name, phone, email, prefs
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
`);

// ---- migrations for databases created by earlier versions ----
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('orders', 'customer_uid', 'TEXT');
addColumn('files', 'opts', 'TEXT');                       // JSON print options (not sensitive)
addColumn('files', 'sel_pages', 'INTEGER NOT NULL DEFAULT 0'); // pages selected by the page range
addColumn('files', 'stage', 'INTEGER NOT NULL DEFAULT 0');     // 0 waiting, 1 fronts printed (manual 2-sided), 2 done
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_uid, created_at)');

const DEFAULTS = {
  shop_name: 'e-Mitra Print & Design',
  upi_id: '',
  payee_name: '',
  price_bw: 200, // paise
  price_color: 1000,
  accepting_print: 1,
  accepting_design: 1,
  notice_en: 'Self-service on weekdays: scan, upload, pay by UPI and collect your prints.',
  notice_hi: 'सोमवार से शुक्रवार सेल्फ़-सर्विस: स्कैन करें, अपलोड करें, UPI से भुगतान करें और प्रिंट ले जाएं।',
  printer_name: '',
  queue_paused: 0,
  max_banners: 3,
  default_lang: 'hi',
  // Print capabilities (defaults suit a Brother DCP-T430W: no automatic duplex, no A3)
  paper_sizes: 'A4,A5,Legal',
  auto_duplex: 0,
  flip_reverse: 0,
  flip_text_en: 'Take the printed pages from the output tray without changing their order. Turn the stack over and put it back in the paper tray, printed side up, top edge first. Then tap Continue.',
  flip_text_hi: 'छपे हुए पेज आउटपुट ट्रे से बिना क्रम बदले निकालें। पूरी गड्डी को पलटें और छपी तरफ़ ऊपर, ऊपरी किनारा पहले रखते हुए पेपर ट्रे में वापस रखें। फिर "आगे बढ़ें" दबाएं।',
  counter_print: 0,
  counter_design: 0,
  paper_tray_count: 0,
  paper_tray_max: 150,
  seeded: 0,
};
const insDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULTS)) insDefault.run(k, String(v));

if (db.prepare("SELECT value FROM settings WHERE key='seeded'").get().value === '0') {
  const p = db.prepare('INSERT INTO packages (name_en, name_hi, desc_en, desc_hi, price, sort) VALUES (?,?,?,?,?,?)');
  p.run('Basic', 'बेसिक', '1 design concept • 1 revision • JPG + PDF', '1 डिज़ाइन • 1 बदलाव • JPG + PDF', 19900, 1);
  p.run('Standard', 'स्टैंडर्ड', '2 concepts • 3 revisions • print-ready files', '2 डिज़ाइन विकल्प • 3 बदलाव • प्रिंट-रेडी फ़ाइलें', 49900, 2);
  p.run('Premium', 'प्रीमियम', '3 concepts • unlimited revisions • source files', '3 डिज़ाइन विकल्प • असीमित बदलाव • सोर्स फ़ाइलें', 99900, 3);
  const b = db.prepare('INSERT INTO banners (title_en, title_hi, text_en, text_hi, theme, sort) VALUES (?,?,?,?,?,?)');
  b.run('Wedding season offer', 'शादी सीज़न ऑफ़र', '20% off on all invitation card designs', 'सभी निमंत्रण कार्ड डिज़ाइन पर 20% छूट', 'coral', 1);
  b.run('Colour prints', 'कलर प्रिंट', 'Bright, sharp colour prints in minutes', 'मिनटों में चमकदार, साफ़ कलर प्रिंट', 'violet', 2);
  db.prepare("UPDATE settings SET value='1' WHERE key='seeded'").run();
}

export function getSettings() {
  const o = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) o[r.key] = r.value;
  return o;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function nextCode(type) {
  const key = type === 'print' ? 'counter_print' : 'counter_design';
  db.prepare('UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = ?').run(key);
  const n = Number(db.prepare('SELECT value FROM settings WHERE key = ?').get(key).value);
  return (type === 'print' ? 'P-' : 'D-') + String(n).padStart(4, '0');
}

export function audit(actor, action, orderId = null, detail = null) {
  db.prepare('INSERT INTO audit (at, actor, action, order_id, detail) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), actor, action, orderId, detail == null ? null : String(detail).slice(0, 300));
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
