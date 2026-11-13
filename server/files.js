// File validation (by content, not extension), image→PDF conversion, encrypted storage.
import fs from 'node:fs';
import path from 'node:path';
import pdfLib from 'pdf-lib';
import { config } from './config.js';
import { db } from './db.js';
import { encryptBuffer, decryptBuffer, encryptJSON, decryptJSON, randomId } from './crypto.js';
import { HttpError, isId } from './util.js';

const { PDFDocument } = pdfLib;
const FILES_DIR = path.join(config.dataDir, 'files');
export const TMP_DIR = path.join(config.dataDir, 'tmp');
export const MAX_PAGES_PER_FILE = 500;
export const MAX_FILE_MB = 30;

const PRINT_OK = new Set(['pdf', 'jpg', 'png']);
const DESIGN_OK = new Set(['pdf', 'jpg', 'png', 'webp', 'gif', 'psd', 'zip']);

export function sniff(buf) {
  const head = (n) => buf.subarray(0, n).toString('latin1');
  if (buf.subarray(0, 1024).indexOf('%PDF-') !== -1) return { ext: 'pdf', mime: 'application/pdf' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (head(4) === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (head(6) === 'GIF87a' || head(6) === 'GIF89a') return { ext: 'gif', mime: 'image/gif' };
  if (head(4) === '8BPS') return { ext: 'psd', mime: 'image/vnd.adobe.photoshop' };
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return { ext: 'zip', mime: 'application/zip' };
  return null;
}

export function fixName(n) {
  let s = String(n || 'file');
  // Browsers send UTF-8 names; busboy may decode them as latin1. Re-decode when that happened.
  if (/^[\x00-\xff]*$/.test(s)) {
    const u = Buffer.from(s, 'latin1').toString('utf8');
    if (!u.includes('�')) s = u;
  }
  s = s.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').trim();
  if (s.length > 120) s = s.slice(-120);
  return s || 'file';
}

async function imageToPdf(buf, ext, name) {
  const doc = await PDFDocument.create();
  let img;
  try {
    img = ext === 'png' ? await doc.embedPng(buf) : await doc.embedJpg(buf);
  } catch {
    throw new HttpError(400, 'bad_image', `Could not read image "${name}"`, { file: name });
  }
  const A4 = [595.28, 841.89];
  const [pw, ph] = img.width > img.height ? [A4[1], A4[0]] : A4;
  const page = doc.addPage([pw, ph]);
  const m = 18;
  const scale = Math.min((pw - 2 * m) / img.width, (ph - 2 * m) / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  return Buffer.from(await doc.save());
}

/** Validates an uploaded temp file. For print, always returns a PDF with its page count. */
export async function processUpload(file, purpose) {
  const name = fixName(file.originalname);
  const buf = await fs.promises.readFile(file.path);
  const type = sniff(buf);
  const allowed = purpose === 'print' ? PRINT_OK : DESIGN_OK;
  if (!type || !allowed.has(type.ext)) {
    throw new HttpError(400, purpose === 'print' ? 'bad_file_print' : 'bad_file_design', `"${name}" is not a supported file type`, { file: name });
  }
  if (purpose !== 'print') return { buf, name, mime: type.mime, size: buf.length, pages: 0 };

  if (type.ext === 'pdf') {
    let pages = 0;
    try {
      const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
      pages = doc.getPageCount();
    } catch {
      throw new HttpError(400, 'bad_pdf', `Could not read PDF "${name}"`, { file: name });
    }
    if (!pages) throw new HttpError(400, 'bad_pdf', `"${name}" has no pages`, { file: name });
    if (pages > MAX_PAGES_PER_FILE) throw new HttpError(400, 'too_many_pages', `"${name}" has more than ${MAX_PAGES_PER_FILE} pages`, { file: name });
    return { buf, name, mime: 'application/pdf', size: buf.length, pages };
  }
  const pdf = await imageToPdf(buf, type.ext, name);
  return { buf: pdf, name, mime: 'application/pdf', size: buf.length, pages: 1 };
}

const storedPath = (id) => {
  if (!isId(id)) throw new Error('bad file id');
  return path.join(FILES_DIR, id + '.bin');
};

export function storeFile(orderId, kind, p, sort = 0) {
  const id = randomId(16);
  fs.writeFileSync(storedPath(id), encryptBuffer(p.buf), { mode: 0o600 });
  db.prepare('INSERT INTO files (id, order_id, kind, name, mime, size, pages, sort, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, orderId, kind, encryptJSON(p.name), p.mime, p.size, p.pages, sort, Date.now());
  return id;
}

export const readStored = (id) => decryptBuffer(fs.readFileSync(storedPath(id)));

export function purgeFile(row) {
  fs.rmSync(storedPath(row.id), { force: true });
  db.prepare('UPDATE files SET purged = 1 WHERE id = ?').run(row.id);
}

export function deleteFileRow(row) {
  fs.rmSync(storedPath(row.id), { force: true });
  db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
}

export function purgeOrderFiles(orderId) {
  for (const row of db.prepare('SELECT id FROM files WHERE order_id = ? AND purged = 0').all(orderId)) purgeFile(row);
}

export const fileName = (row) => decryptJSON(row.name) || 'file';

export function tmpFilesOf(req) {
  if (!req.files) return [];
  return Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
}

export function cleanupTmp(req) {
  for (const f of tmpFilesOf(req)) fs.rm(f.path, { force: true }, () => {});
}
