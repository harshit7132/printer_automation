// Print queue worker: one order at a time, all of a customer's files printed together,
// so bulk orders from different customers never get mixed in the tray.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pdfLib from 'pdf-lib';
import { config } from './config.js';
import { db, getSettings, audit } from './db.js';
import { readStored } from './files.js';
import { setStatus } from './orders.js';
import { notifyOwner } from './notify.js';

const { PDFDocument, StandardFonts, rgb } = pdfLib;
let ptp; // pdf-to-printer module, false if unavailable
let busy = false;
let current = null;

async function driver() {
  if (ptp !== undefined) return ptp;
  if (process.platform !== 'win32') return (ptp = false);
  try {
    const m = await import('pdf-to-printer');
    ptp = m.default || m;
  } catch (e) {
    console.warn('pdf-to-printer not available:', e.message);
    ptp = false;
  }
  return ptp;
}

export async function listPrinters() {
  if (config.printMode === 'simulate') return [{ name: 'Simulated Printer' }];
  const p = await driver();
  if (!p) return [];
  try {
    return (await p.getPrinters()).map((x) => ({ name: x.name }));
  } catch (e) {
    console.warn('Could not list printers:', e.message);
    return [];
  }
}

export async function printPdf(buf, { printer, copies = 1, color = false, duplex = false, label = '' } = {}) {
  if (config.printMode === 'simulate') {
    console.log(`[simulate] printing ${label} copies=${copies} ${color ? 'colour' : 'b/w'} ${duplex ? 'duplex' : 'single'} (${buf.length} bytes) on "${printer || 'default'}"`);
    await new Promise((r) => setTimeout(r, 1500));
    return;
  }
  const p = await driver();
  if (!p) throw new Error('Printer driver not available (Windows only). Set PRINT_MODE=simulate to test on other systems.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emitra-'));
  const file = path.join(dir, 'job.pdf');
  try {
    fs.writeFileSync(file, buf, { mode: 0o600 });
    await p.print(file, {
      printer: printer || undefined,
      copies,
      monochrome: !color,
      side: duplex ? 'duplex' : 'simplex',
      scale: 'fit',
      silent: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); // decrypted copy never stays on disk
  }
}

export async function testPage(shopName, printer) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText('Printer test page', { x: 60, y: 760, size: 28, font, color: rgb(0.36, 0.24, 0.96) });
  page.drawText(shopName.replace(/[^\x20-\x7E]/g, ''), { x: 60, y: 720, size: 16, font });
  page.drawText(new Date().toLocaleString('en-IN'), { x: 60, y: 695, size: 12, font });
  page.drawText('If you can read this, printing works.', { x: 60, y: 660, size: 14, font });
  await printPdf(Buffer.from(await doc.save()), { printer, label: 'test page' });
}

export function workerStatus() {
  return { busy, current, mode: config.printMode };
}

async function tick() {
  if (busy) return;
  const s = getSettings();
  if (s.queue_paused === '1') return;
  const order = db.prepare("SELECT * FROM orders WHERE type='print' AND status='queued' ORDER BY verified_at ASC LIMIT 1").get();
  if (!order) return;

  busy = true;
  current = order.code;
  setStatus(order.id, 'printing', { error: null });
  try {
    const files = db.prepare("SELECT * FROM files WHERE order_id = ? AND kind = 'print' AND purged = 0 ORDER BY sort").all(order.id);
    if (!files.length) throw new Error('No files left to print (they may have been deleted).');
    for (const f of files) {
      await printPdf(readStored(f.id), {
        printer: s.printer_name, copies: f.copies, color: !!f.color, duplex: !!f.duplex, label: `${order.code}/${f.sort + 1}`,
      });
    }
    setStatus(order.id, 'printed', { done_at: Date.now() });
    audit('printer', 'printed', order.id, order.code);
  } catch (e) {
    console.error(`Print failed for ${order.code}:`, e.message);
    setStatus(order.id, 'failed', { error: String(e.message).slice(0, 300) });
    audit('printer', 'failed', order.id, e.message);
    notifyOwner(`⚠️ Print failed: ${order.code}\n${e.message}`);
  } finally {
    busy = false;
    current = null;
  }
}

export const kick = () => setImmediate(() => tick().catch((e) => console.error(e)));

export function startWorker() {
  // If the app stopped mid-print we can't know what came out — let the owner decide.
  db.prepare("UPDATE orders SET status='failed', error='Interrupted: app restarted while printing. Check the tray, then Reprint.', updated_at=? WHERE status='printing'")
    .run(Date.now());
  setInterval(() => tick().catch((e) => console.error(e)), 3000);
}
