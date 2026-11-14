// Customer print options: validation, page-range parsing, and what the printer can actually do.
import { HttpError, clampInt } from './util.js';

export const ALL_PAPERS = ['A4', 'A5', 'A6', 'Letter', 'Legal'];
// SumatraPDF paper names (passed through pdf-to-printer as paper=<name>)
export const SUMATRA_PAPER = { A4: 'A4', A5: 'A5', A6: 'A6', Letter: 'letter', Legal: 'legal' };
const ORIENT = ['auto', 'portrait', 'landscape'];
const SCALE = ['fit', 'shrink', 'noscale'];

/** What the shop's printer supports, from admin settings. */
export function capabilities(s) {
  const papers = String(s.paper_sizes || 'A4').split(',').map((x) => x.trim()).filter((x) => ALL_PAPERS.includes(x));
  const autoDuplex = s.auto_duplex === '1';
  return {
    papers: papers.length ? papers : ['A4'],
    sides: autoDuplex ? ['single', 'long', 'short'] : ['single', 'manual'],
    orientations: ORIENT,
    scales: SCALE,
  };
}

/** "1-3, 5,8-10" -> sorted unique page numbers within 1..max. Empty string = all pages. */
export function parseRange(input, max) {
  const str = String(input ?? '').replace(/\s+/g, '');
  if (!str) return Array.from({ length: max }, (_, i) => i + 1);
  if (str.length > 200 || !/^[\d,-]+$/.test(str)) throw new HttpError(400, 'bad_range', 'Invalid page range');
  const set = new Set();
  for (const part of str.split(',')) {
    if (!part) continue;
    const m = part.match(/^(\d+)(?:-(\d*))?$/);
    if (!m) throw new HttpError(400, 'bad_range', 'Invalid page range');
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : m[2] === '' ? max : Number(m[2]);
    if (a < 1 || b < a || a > max) throw new HttpError(400, 'bad_range', `Pages must be between 1 and ${max}`, { max });
    for (let p = a; p <= Math.min(b, max); p++) set.add(p);
  }
  if (!set.size) throw new HttpError(400, 'bad_range', 'Invalid page range');
  return [...set].sort((x, y) => x - y);
}

/** [1,2,3,5,8,9,10] -> "1-3,5,8-10" */
export function compactRange(pages) {
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    const start = pages[i];
    while (i + 1 < pages.length && pages[i + 1] === pages[i] + 1) i++;
    out.push(start === pages[i] ? `${start}` : `${start}-${pages[i]}`);
  }
  return out.join(',');
}

/**
 * Validates one file's options against the shop's capabilities.
 * @returns {{ opts, copies, color, selPages, duplex }}
 */
export function normalizeOptions(input, fileRow, caps, encrypted = false) {
  const w = input || {};
  const pages = parseRange(w.range, fileRow.pages);
  const all = pages.length === fileRow.pages;
  let sides = caps.sides.includes(w.sides) ? w.sides : 'single';
  if (pages.length === 1) sides = 'single';
  // Manual two-sided rebuilds the PDF; encrypted PDFs can't be rebuilt reliably.
  if (sides === 'manual' && encrypted) sides = 'single';
  const opts = {
    sides,
    range: all ? '' : compactRange(pages),
    paper: caps.papers.includes(w.paper) ? w.paper : caps.papers[0],
    orientation: ORIENT.includes(w.orientation) ? w.orientation : 'auto',
    scale: SCALE.includes(w.scale) ? w.scale : 'fit',
  };
  if (encrypted) opts.encrypted = true;
  if (typeof w.password === 'string' && w.password.trim()) opts.password = w.password.trim();
  return {
    opts,
    copies: clampInt(w.copies, 1, 100, 1),
    color: w.color ? 1 : 0,
    selPages: pages.length,
    duplex: sides === 'single' ? 0 : 1,
  };
}

export function readOpts(row) {
  try {
    return { sides: 'single', range: '', paper: 'A4', orientation: 'auto', scale: 'fit', password: '', ...JSON.parse(row.opts || '{}') };
  } catch {
    return { sides: 'single', range: '', paper: 'A4', orientation: 'auto', scale: 'fit', password: '' };
  }
}

/** Pages actually charged for a file. */
export const chargedPages = (row) => (row.sel_pages || row.pages);
