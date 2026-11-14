// Print queue worker: one order at a time, all of a customer's files printed together,
// so bulk orders from different customers never get mixed in the tray.
//
// Options sent to the Windows driver (via SumatraPDF): page range, copies, colour/mono,
// paper size, orientation, fit/shrink/actual size, automatic duplex (if the printer has it).
// Manual two-sided (for printers without duplex, e.g. Brother DCP-T430W): we print the fronts,
// pause the queue while the customer flips the stack, then print the backs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pdfLib from 'pdf-lib';
import { config } from './config.js';
import { db, getSettings, audit } from './db.js';
import { readStored } from './files.js';
import { setStatus } from './orders.js';
import { notifyOwner } from './notify.js';
import { readOpts, parseRange, SUMATRA_PAPER } from './printopts.js';

const execFileAsync = promisify(execFile);

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
  if (config.printMode === 'simulate') return [{ name: 'Simulated Printer', paperSizes: ['A4', 'A5', 'Legal', 'Letter'] }];
  const p = await driver();
  if (!p) return [];
  try {
    return (await p.getPrinters()).map((x) => ({ name: x.name, paperSizes: Array.isArray(x.paperSizes) ? x.paperSizes : [] }));
  } catch (e) {
    console.warn('Could not list printers:', e.message);
    return [];
  }
}

/** Sends one PDF to the printer. `settings` are pdf-to-printer options. */
export async function printPdf(buf, settings = {}, label = '') {
  if (config.printMode === 'simulate') {
    console.log(`[simulate] ${label} ->`, JSON.stringify(settings), `(${buf.length} bytes)`);
    await new Promise((r) => setTimeout(r, 1200));
    return;
  }
  const p = await driver();
  if (!p) throw new Error('Printer driver not available (Windows only). Set PRINT_MODE=simulate to test on other systems.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emitra-'));
  const file = path.join(dir, 'job.pdf');
  try {
    fs.writeFileSync(file, buf, { mode: 0o600 });
    const sumatraExe = path.resolve(config.root, 'node_modules/pdf-to-printer/dist/SumatraPDF-3.4.6-32.exe');
    if (settings.password && fs.existsSync(sumatraExe)) {
      const args = [];
      if (settings.printer) args.push('-print-to', settings.printer);
      else args.push('-print-to-default');
      args.push('-silent');
      args.push('-pwd', settings.password);
      const printSettings = [];
      if (settings.pages) printSettings.push(settings.pages);
      if (settings.orientation) printSettings.push(settings.orientation);
      if (settings.scale) printSettings.push(settings.scale);
      if (settings.monochrome) printSettings.push('monochrome');
      else if (settings.monochrome === false) printSettings.push('color');
      if (settings.side) printSettings.push(settings.side);
      if (settings.paperSize) printSettings.push(`paper=${settings.paperSize}`);
      if (settings.copies) printSettings.push(`${settings.copies}x`);
      if (printSettings.length) args.push('-print-settings', printSettings.join(','));
      args.push(file);
      await execFileAsync(sumatraExe, args);
    } else {
      await p.print(file, { silent: true, ...settings });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); // decrypted copy never stays on disk
  }
}

function driverSettings(o, f, printer, extra = {}) {
  const s = {
    printer: printer || undefined,
    monochrome: !f.color,
    scale: o.scale,
    paperSize: SUMATRA_PAPER[o.paper] || 'A4',
    ...extra,
  };
  if (o.password) s.password = o.password;
  if (o.orientation !== 'auto') s.orientation = o.orientation;
  return s;
}

/**
 * Manual two-sided: build one PDF with the selected pages, each copy padded to an even page count,
 * then split into fronts (1,3,5…) and backs (2,4,6…). Sheets stay aligned across copies.
 */
async function manualDuplexParts(buf, f, o, reverseBacks) {
  const src = await PDFDocument.load(buf);
  const pages = parseRange(o.range, src.getPageCount()).map((p) => p - 1);
  const doc = await PDFDocument.create();
  const copied = await doc.copyPages(src, pages);
  for (let c = 0; c < f.copies; c++) {
    for (const pg of c === 0 ? copied : await doc.copyPages(src, pages)) doc.addPage(pg);
    if (pages.length % 2) {
      const last = src.getPage(pages[pages.length - 1]);
      doc.addPage([last.getWidth(), last.getHeight()]); // blank back for the last sheet
    }
  }
  const total = doc.getPageCount();
  const pick = async (idx) => {
    const out = await PDFDocument.create();
    for (const pg of await out.copyPages(doc, idx)) out.addPage(pg);
    return Buffer.from(await out.save());
  };
  const fronts = [];
  const backs = [];
  for (let i = 0; i < total; i += 2) {
    fronts.push(i);
    backs.push(i + 1);
  }
  if (reverseBacks) backs.reverse();
  return { fronts: await pick(fronts), backs: await pick(backs), sheets: fronts.length };
}

export async function testPage(shopName, printer) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText('Printer test page', { x: 60, y: 760, size: 28, font, color: rgb(0.36, 0.24, 0.96) });
  page.drawText(shopName.replace(/[^\x20-\x7E]/g, ''), { x: 60, y: 720, size: 16, font });
  page.drawText(new Date().toLocaleString('en-IN'), { x: 60, y: 695, size: 12, font });
  page.drawText('If you can read this, printing works.', { x: 60, y: 660, size: 14, font });
  await printPdf(Buffer.from(await doc.save()), { printer: printer || undefined }, 'test page');
}

export function workerStatus() {
  return { busy, current, mode: config.printMode };
}

/** Prints the order's remaining files. Returns 'done' or 'flip' (waiting for the customer to flip pages). */
async function runOrder(order, s) {
  const files = db.prepare("SELECT * FROM files WHERE order_id = ? AND kind = 'print' AND purged = 0 ORDER BY sort").all(order.id);
  if (!files.length) throw new Error('No files left to print (they may have been deleted).');
  const setStage = db.prepare('UPDATE files SET stage = ? WHERE id = ?');

  for (const f of files) {
    if (f.stage >= 2) continue;
    const o = readOpts(f);
    const label = `${order.code}/${f.sort + 1}`;
    const buf = readStored(f.id);

    if (o.sides === 'manual') {
      const parts = await manualDuplexParts(buf, f, o, s.flip_reverse === '1');
      if (f.stage === 0) {
        await printPdf(parts.fronts, driverSettings(o, f, s.printer_name), `${label} fronts (${parts.sheets} sheets)`);
        setStage.run(1, f.id);
        return 'flip';
      }
      await printPdf(parts.backs, driverSettings(o, f, s.printer_name), `${label} backs`);
    } else {
      const side = o.sides === 'long' ? 'duplexlong' : o.sides === 'short' ? 'duplexshort' : 'simplex';
      const extra = { side, copies: f.copies };
      if (o.range) extra.pages = o.range;
      await printPdf(buf, driverSettings(o, f, s.printer_name, extra), label);
    }
    setStage.run(2, f.id);
  }
  return 'done';
}

async function tick() {
  if (busy) return;
  const s = getSettings();
  if (s.queue_paused === '1') return;
  // Paper for a manual two-sided job is sitting in the tray: nobody else may print until it's flipped.
  if (db.prepare("SELECT 1 FROM orders WHERE status = 'flip_needed'").get()) return;
  const order = db.prepare("SELECT * FROM orders WHERE type='print' AND status='queued' ORDER BY verified_at ASC LIMIT 1").get();
  if (!order) return;

  busy = true;
  current = order.code;
  setStatus(order.id, 'printing', { error: null });
  try {
    const result = await runOrder(order, s);
    if (result === 'flip') {
      setStatus(order.id, 'flip_needed');
      audit('printer', 'flip_needed', order.id, order.code);
    } else {
      setStatus(order.id, 'printed', { done_at: Date.now() });
      audit('printer', 'printed', order.id, order.code);
      try {
        const pFiles = db.prepare("SELECT * FROM files WHERE order_id = ? AND kind = 'print' AND purged = 0").all(order.id);
        let sheets = 0;
        for (const f of pFiles) {
          const o = readOpts(f);
          const pgs = f.sel_pages || f.pages || 1;
          const perCopy = o.sides === 'single' ? pgs : Math.ceil(pgs / 2);
          sheets += perCopy * (f.copies || 1);
        }
        const curCount = Number(db.prepare("SELECT value FROM settings WHERE key='paper_tray_count'").get()?.value || 0);
        const maxCount = Number(db.prepare("SELECT value FROM settings WHERE key='paper_tray_max'").get()?.value || 150);
        const nextCount = curCount + sheets;
        db.prepare("UPDATE settings SET value = ? WHERE key = 'paper_tray_count'").run(String(nextCount));
        if (curCount < Math.floor(maxCount * 0.8) && nextCount >= Math.floor(maxCount * 0.8)) {
          notifyOwner(`⚠️ Paper tray running low: ${nextCount}/${maxCount} sheets used. Please refill paper.`);
        }
      } catch (err) {
        console.warn('Tray counter error:', err.message);
      }
    }
  } catch (e) {
    console.error(`Print failed for ${order.code}:`, e.message);
    const msg = String(e.message || '');
    const userMsg = msg.toLowerCase().includes('password') || msg.toLowerCase().includes('pwd') ? 'Incorrect PDF password' : msg.slice(0, 300);
    setStatus(order.id, 'failed', { error: userMsg });
    audit('printer', 'failed', order.id, e.message);
    notifyOwner(`⚠️ Print failed: ${order.code}\n${userMsg}`);
  } finally {
    busy = false;
    current = null;
  }
}

/** Customer (or owner) has flipped the pages: resume this order before anything else. */
export function continueAfterFlip(order) {
  const min = db.prepare("SELECT MIN(verified_at) m FROM orders WHERE status = 'queued'").get().m;
  setStatus(order.id, 'queued', { verified_at: Math.min(min ?? order.verified_at, order.verified_at) - 1 });
  kick();
}

export const resetStages = (orderId) => db.prepare("UPDATE files SET stage = 0 WHERE order_id = ? AND kind = 'print'").run(orderId);

export const kick = () => setImmediate(() => tick().catch((e) => console.error(e)));

export function startWorker() {
  // If the app stopped mid-print we can't know what came out — let the owner decide.
  db.prepare("UPDATE orders SET status='failed', error='Interrupted: app restarted while printing. Check the tray, then Reprint.', updated_at=? WHERE status='printing'")
    .run(Date.now());
  setInterval(() => tick().catch((e) => console.error(e)), 3000);
}
