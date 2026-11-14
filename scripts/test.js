// Automated self-test suite for e-Mitra Print Studio.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { db, getSettings, nextCode, setSetting } from '../server/db.js';
import { encryptBuffer, decryptBuffer, encryptJSON, decryptJSON, safeEqual } from '../server/crypto.js';
import { sniff } from '../server/files.js';
import { normalizeOptions, parseRange } from '../server/printopts.js';
import { orderEvents, emitOrderUpdate } from '../server/events.js';
import { backupDatabase } from '../server/maintenance.js';

console.log('\n=== Running e-Mitra Print Studio Test Suite ===\n');

// 1. Database & Settings
console.log('✔ Testing Database & Settings...');
const s = getSettings();
assert.ok(s.shop_name, 'Shop name should exist');
assert.ok(s.paper_tray_max !== undefined, 'Paper tray max setting should exist');
assert.ok(s.paper_tray_count !== undefined, 'Paper tray count setting should exist');
setSetting('test_key', 'test_val');
assert.equal(db.prepare("SELECT value FROM settings WHERE key='test_key'").get().value, 'test_val');
db.prepare("DELETE FROM settings WHERE key='test_key'").run();

// 2. Code Generator
console.log('✔ Testing Order Code Generator...');
const pCode = nextCode('print');
assert.match(pCode, /^P-\d{4}$/, 'Print code must match P-0000 format');
const dCode = nextCode('design');
assert.match(dCode, /^D-\d{4}$/, 'Design code must match D-0000 format');

// 3. Cryptography & Encryption
console.log('✔ Testing AES-256-GCM Encryption...');
const secretText = 'Customer Aadhaar Data & Private Phone Number';
const encryptedBuf = encryptBuffer(Buffer.from(secretText));
const decryptedBuf = decryptBuffer(encryptedBuf);
assert.equal(decryptedBuf.toString(), secretText, 'Decrypted buffer must match original');

const secretJson = { name: 'Ramesh Kumar', phone: '9876543210', utr: 'UTR123456789' };
const encryptedJson = encryptJSON(secretJson);
const decryptedJson = decryptJSON(encryptedJson);
assert.deepEqual(decryptedJson, secretJson, 'Decrypted JSON must match original');

assert.ok(safeEqual('same_string', 'same_string'), 'Timing-safe equality should match identical strings');
assert.ok(!safeEqual('string_a', 'string_b'), 'Timing-safe equality should reject different strings');

// 4. File Sniffer (Magic Bytes)
console.log('✔ Testing File Type Sniffer...');
assert.equal(sniff(Buffer.from('%PDF-1.7 header'))?.ext, 'pdf');
assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.ext, 'jpg');
assert.equal(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.ext, 'png');

// HEIC magic bytes: bytes 4-8 are 'ftyp' and brand is 'heic'
const heicBuf = Buffer.alloc(16);
heicBuf.write('ftyp', 4, 'latin1');
heicBuf.write('heic', 8, 'latin1');
assert.equal(sniff(heicBuf)?.ext, 'heic', 'Sniffer must detect HEIC format');

// 5. Print Options & Password Handling
console.log('✔ Testing Print Options & PDF Password Retention...');
const caps = { papers: ['A4', 'A5'], sides: ['single', 'manual'] };
const fileRow = { pages: 10, sel_pages: 10 };
const inputOpts = { range: '1-3, 5', color: 1, copies: 2, sides: 'single', password: 'RAME1992' };
const normalized = normalizeOptions(inputOpts, fileRow, caps, true);

assert.equal(normalized.copies, 2);
assert.equal(normalized.color, 1);
assert.equal(normalized.selPages, 4); // 1, 2, 3, 5 = 4 pages
assert.equal(normalized.opts.password, 'RAME1992', 'PDF Password must be preserved in options');
assert.equal(normalized.opts.encrypted, true, 'Encrypted flag must be set');

// 6. Admin View & Order Serializer
console.log('✔ Testing Admin Order View Serialization...');
const mockOrder = {
  id: 'ord_test_123',
  code: 'P-0001',
  type: 'print',
  status: 'payment_submitted',
  amount: 5000,
  created_at: Date.now(),
  updated_at: Date.now(),
  paid_at: Date.now(),
  verified_at: null,
  done_at: null,
  error: null,
  admin_note: null,
  customer_uid: null,
  pii: encryptJSON({ name: 'Harsh', phone: '9876543210', paymentMode: 'upi' }),
  meta: encryptJSON({ notes: 'Urgent' }),
};
const { adminView } = await import('../server/orders.js');
const av = adminView(mockOrder);
assert.equal(av.code, 'P-0001');
assert.equal(av.customer.name, 'Harsh');
assert.equal(av.paymentMode, 'upi');

// 7. Real-time Events (SSE Bus)
console.log('✔ Testing Real-time Event Bus...');
let eventReceived = false;
const testOrderId = 'test-order-999';
const testHandler = () => { eventReceived = true; };
orderEvents.once(`order:${testOrderId}`, testHandler);
emitOrderUpdate(testOrderId);
assert.ok(eventReceived, 'orderEvents must fire on emitOrderUpdate');

// 8. Automated Daily Database Backup
console.log('✔ Testing Database Backup Routine...');
backupDatabase();
const backupDir = path.resolve('data/backups');
assert.ok(fs.existsSync(backupDir), 'Backup directory should exist');
const backups = fs.readdirSync(backupDir).filter((f) => f.startsWith('app-') && f.endsWith('.db'));
assert.ok(backups.length > 0, 'At least one backup file should be generated');

// 9. Order Lookup by Code & Phone
console.log('✔ Testing Order Lookup Logic...');
const lookupId = 'lookup_test_999';
const lookupCode = 'D-9999';
const lookupPhone = '9876543210';
db.prepare("INSERT INTO orders (id, code, type, status, amount, pii, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
  .run(lookupId, lookupCode, 'design', 'completed', 25000, encryptJSON({ phone: lookupPhone, name: 'Suresh' }), Date.now(), Date.now());

const found = db.prepare('SELECT * FROM orders WHERE code = ?').get(lookupCode);
assert.ok(found, 'Order must be found by code');
const foundPii = decryptJSON(found.pii);
assert.equal(foundPii.phone, lookupPhone, 'Decrypted phone must match for authorization');
db.prepare('DELETE FROM orders WHERE id = ?').run(lookupId);

console.log('\n=========================================');
console.log('🎉 ALL TESTS PASSED SUCCESSFULLY! (9/9)');
console.log('=========================================\n');
