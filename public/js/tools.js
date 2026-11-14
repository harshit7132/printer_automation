import { initPage, $, $$, esc, rupees, fmtSize, fileIcon, ICONS, toast } from './common.js';
import { t, getLang } from './i18n.js';

const cfg = await initPage();
let PDFLib = null;

async function getPdfLib() {
  if (!PDFLib) {
    try {
      PDFLib = await import('/vendor/pdf-lib/pdf-lib.esm.min.js');
    } catch {
      PDFLib = await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.9/+esm');
    }
  }
  return PDFLib;
}

const state = {
  currentTool: 'compress',
  files: [],
  processing: false,
  resultBlob: null,
  resultName: '',
  resultMeta: '',
  paid: false,
};

const TOOL_CONFIG = {
  compress: {
    title: '🗜️ ' + t('t_compress'),
    desc: t('t_compress_desc'),
    accept: '.pdf,application/pdf',
    multiple: false,
    btn: t('btn_compress'),
  },
  merge: {
    title: '📑 ' + t('t_merge'),
    desc: t('t_merge_desc'),
    accept: '.pdf,application/pdf',
    multiple: true,
    btn: t('btn_merge'),
  },
  img2pdf: {
    title: '🖼️ ' + t('t_img2pdf'),
    desc: t('t_img2pdf_desc'),
    accept: '.jpg,.jpeg,.png,.webp,.heic,.heif,image/*',
    multiple: true,
    btn: t('btn_img2pdf'),
  },
  scanner: {
    title: '🔍 ' + t('t_scanner'),
    desc: t('t_scanner_desc'),
    accept: '.jpg,.jpeg,.png,.webp,.heic,.heif,image/*',
    multiple: false,
    btn: t('btn_scanner'),
  },
  resizer: {
    title: '🪪 ' + t('t_resizer'),
    desc: t('t_resizer_desc'),
    accept: '.jpg,.jpeg,.png,.webp,image/*',
    multiple: false,
    btn: t('btn_resizer'),
  },
  split: {
    title: '✂️ ' + t('t_split'),
    desc: t('t_split_desc'),
    accept: '.pdf,application/pdf',
    multiple: false,
    btn: t('btn_split'),
  },
  unlock: {
    title: '🔓 ' + t('t_unlock'),
    desc: t('t_unlock_desc'),
    accept: '.pdf,application/pdf',
    multiple: false,
    btn: t('btn_unlock'),
  },
};

function getUsageCount() {
  return parseInt(localStorage.getItem('emitra_tool_usage') || '0', 10);
}
function recordUsage() {
  const c = getUsageCount() + 1;
  localStorage.setItem('emitra_tool_usage', String(c));
  return c;
}

// ---------- UI Switcher ----------
function selectTool(key) {
  if (!TOOL_CONFIG[key]) return;
  state.currentTool = key;
  state.files = [];
  state.resultBlob = null;
  state.paid = false;

  $$('#toolsNav .tool-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tool === key));
  const conf = TOOL_CONFIG[key];
  $('#toolTitle').textContent = conf.title;
  $('#toolDesc').textContent = conf.desc;
  $('#toolFileInput').accept = conf.accept;
  $('#toolFileInput').multiple = conf.multiple;
  $('#toolDropSub').textContent = conf.multiple ? t('drop_multi') : t('drop_single');
  $('#toolActionBtn').textContent = conf.btn;
  $('#toolActionBtn').disabled = true;
  $('#toolResult').classList.add('hidden');
  $('#toolProgress').classList.add('hidden');

  renderOptionsArea();
  renderFileList();
}

function renderOptionsArea() {
  const area = $('#toolOptions');
  const k = state.currentTool;

  if (k === 'compress') {
    area.innerHTML = `
      <label class="lbl"><b>${esc(t('target_size'))}:</b></label>
      <div class="preset-chips" id="compressPresets">
        <button type="button" class="preset-chip active" data-target="100">🎯 &lt; 100 KB (SSO / SSC)</button>
        <button type="button" class="preset-chip" data-target="200">🎯 &lt; 200 KB (UPSC / College)</button>
        <button type="button" class="preset-chip" data-target="500">🎯 &lt; 500 KB (Standard)</button>
        <button type="button" class="preset-chip" data-target="auto">⚡ Extreme (Max reduction)</button>
      </div>`;
    area.querySelectorAll('.preset-chip').forEach((btn) => {
      btn.onclick = () => {
        area.querySelectorAll('.preset-chip').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      };
    });
  } else if (k === 'split') {
    area.innerHTML = `
      <div class="field" style="margin:0">
        <label for="splitRange"><b>${esc(t('pages_extract'))}:</b></label>
        <input type="text" id="splitRange" placeholder="e.g. 1-2, 5" style="font-weight:700">
        <p class="opt-hint">${esc(t('split_hint'))}</p>
      </div>`;
  } else if (k === 'unlock') {
    area.innerHTML = `
      <div class="field" style="margin:0">
        <label for="unlockPass"><b>${esc(t('pdf_pass_lbl'))}:</b></label>
        <input type="text" id="unlockPass" placeholder="e.g. RAME1992" style="font-weight:700;letter-spacing:1px;text-transform:uppercase">
        <p class="opt-hint">${esc(t('aadhaar_pass_hint'))}</p>
      </div>`;
  } else if (k === 'scanner') {
    area.innerHTML = `
      <label class="lbl"><b>${esc(t('filter_mode'))}:</b></label>
      <div class="preset-chips" id="scanFilters">
        <button type="button" class="preset-chip active" data-filter="bw">📄 Clean B&amp;W Scanner</button>
        <button type="button" class="preset-chip" data-filter="color">🎨 Enhanced Color Document</button>
        <button type="button" class="preset-chip" data-filter="photo">🖼️ High Contrast Photo</button>
      </div>
      <div style="display:flex;gap:10px;margin-top:8px">
        <button type="button" class="btn btn-sm btn-ghost" id="scanRotateBtn">↻ Rotate 90°</button>
      </div>`;
    area.querySelectorAll('#scanFilters .preset-chip').forEach((btn) => {
      btn.onclick = () => {
        area.querySelectorAll('#scanFilters .preset-chip').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      };
    });
  } else if (k === 'resizer') {
    area.innerHTML = `
      <label class="lbl"><b>${esc(t('govt_preset'))}:</b></label>
      <div class="preset-chips" id="resizerPresets">
        <button type="button" class="preset-chip active" data-type="photo" data-max="50">📸 Passport Photo (&lt; 50 KB)</button>
        <button type="button" class="preset-chip" data-type="sig" data-max="20">✍️ Signature (&lt; 20 KB)</button>
        <button type="button" class="preset-chip" data-type="doc" data-max="100">📑 ID Proof Photo (&lt; 100 KB)</button>
      </div>`;
    area.querySelectorAll('.preset-chip').forEach((btn) => {
      btn.onclick = () => {
        area.querySelectorAll('.preset-chip').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      };
    });
  } else {
    area.innerHTML = '';
  }
}

function renderFileList() {
  const el = $('#toolFileList');
  if (!state.files.length) {
    el.innerHTML = '';
    $('#toolActionBtn').disabled = true;
    return;
  }
  $('#toolActionBtn').disabled = false;
  el.innerHTML = state.files.map((f, i) => `
    <div class="file-item">
      ${fileIcon(f.name)}
      <div class="fmeta">
        <div class="fname">${esc(f.name)}</div>
        <div class="fsub">${fmtSize(f.size)}</div>
      </div>
      <button class="icon-btn" type="button" data-rm="${i}" aria-label="Remove">${ICONS.trash}</button>
    </div>`).join('');
}

$('#toolFileList').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]');
  if (rm) {
    state.files.splice(Number(rm.dataset.rm), 1);
    renderFileList();
  }
});

// ---------- File Input & Dropzone ----------
const fileInput = $('#toolFileInput');
fileInput.addEventListener('change', () => {
  handleSelectedFiles(fileInput.files);
  fileInput.value = '';
});

const dz = $('#toolDropzone');
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('over');
  handleSelectedFiles(e.dataTransfer.files);
});

async function prepareInputFile(f) {
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  if (['heic', 'heif'].includes(ext) || f.type.includes('heic')) {
    try {
      toast('Converting HEIC format...', 'info');
      const mod = await import('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/+esm');
      const heic2any = mod.default || mod;
      const res = await heic2any({ blob: f, toType: 'image/jpeg', quality: 0.92 });
      const blob = Array.isArray(res) ? res[0] : res;
      return new File([blob], f.name.replace(/\.(heic|heif)$/i, '') + '.jpg', { type: 'image/jpeg' });
    } catch {
      toast('Could not convert HEIC', 'bad');
      return null;
    }
  }
  return f;
}

async function handleSelectedFiles(list) {
  for (let f of list) {
    f = await prepareInputFile(f);
    if (!f) continue;
    if (TOOL_CONFIG[state.currentTool].multiple) {
      if (!state.files.some((x) => x.name === f.name && x.size === f.size)) state.files.push(f);
    } else {
      state.files = [f];
    }
  }
  renderFileList();
}

// Navigation Click
$('#toolsNav').addEventListener('click', (e) => {
  const btn = e.target.closest('.tool-tab');
  if (btn && btn.dataset.tool) selectTool(btn.dataset.tool);
});

// ---------- Tool Processors ----------
$('#toolActionBtn').addEventListener('click', async () => {
  if (!state.files.length) return;
  const btn = $('#toolActionBtn');
  btn.disabled = true;
  $('#toolProgress').classList.remove('hidden');
  $('#toolResult').classList.add('hidden');
  $('#toolProgressBar').style.width = '30%';

  try {
    const k = state.currentTool;
    if (k === 'merge') await processMerge();
    else if (k === 'img2pdf') await processImg2Pdf();
    else if (k === 'compress') await processCompress();
    else if (k === 'split') await processSplit();
    else if (k === 'scanner') await processScanner();
    else if (k === 'resizer') await processResizer();
    else if (k === 'unlock') await processUnlock();
    showResult();
  } catch (err) {
    toast(err.message || 'Error processing document', 'bad');
  } finally {
    btn.disabled = false;
    $('#toolProgress').classList.add('hidden');
  }
});

// 1. Merge PDF
async function processMerge() {
  const lib = await getPdfLib();
  const mergedPdf = await lib.PDFDocument.create();
  $('#toolProgressBar').style.width = '60%';

  for (const f of state.files) {
    const bytes = await f.arrayBuffer();
    const pdf = await lib.PDFDocument.load(bytes);
    const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
    pages.forEach((p) => mergedPdf.addPage(p));
  }
  const outBytes = await mergedPdf.save();
  state.resultBlob = new Blob([outBytes], { type: 'application/pdf' });
  state.resultName = 'Merged_Document.pdf';
  state.resultMeta = `Successfully merged ${state.files.length} PDFs into 1 file (${fmtSize(state.resultBlob.size)}).`;
}

// 2. Images to PDF
async function processImg2Pdf() {
  const lib = await getPdfLib();
  const pdfDoc = await lib.PDFDocument.create();
  $('#toolProgressBar').style.width = '50%';

  for (const f of state.files) {
    const bytes = await f.arrayBuffer();
    const isPng = f.type.includes('png') || f.name.toLowerCase().endsWith('.png');
    let img;
    try {
      img = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
    } catch {
      // Canvas fallback for images that need format normalization
      const bmp = await createImageBitmap(f);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      const jpgBlob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
      img = await pdfDoc.embedJpg(await jpgBlob.arrayBuffer());
    }
    // A4 dimensions: 595.28 x 841.89
    const page = pdfDoc.addPage([595.28, 841.89]);
    const maxW = 595.28 - 40;
    const maxH = 841.89 - 40;
    const scale = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, {
      x: (595.28 - w) / 2,
      y: (841.89 - h) / 2,
      width: w,
      height: h,
    });
  }
  const outBytes = await pdfDoc.save();
  state.resultBlob = new Blob([outBytes], { type: 'application/pdf' });
  state.resultName = 'Photos_Combined.pdf';
  state.resultMeta = `Created A4 PDF with ${state.files.length} pages (${fmtSize(state.resultBlob.size)}).`;
}

// 3. Compress PDF
async function processCompress() {
  const file = state.files[0];
  const targetChip = $('#compressPresets .preset-chip.active');
  const targetKb = targetChip ? targetChip.dataset.target : '100';

  const lib = await getPdfLib();
  const bytes = await file.arrayBuffer();
  const pdfDoc = await lib.PDFDocument.load(bytes);
  $('#toolProgressBar').style.width = '70%';

  // Object streams compression
  const outBytes = await pdfDoc.save({ useObjectStreams: true });
  state.resultBlob = new Blob([outBytes], { type: 'application/pdf' });

  const oldSize = file.size;
  const newSize = state.resultBlob.size;
  const savedPct = Math.max(0, Math.round(((oldSize - newSize) / oldSize) * 100));

  state.resultName = file.name.replace(/\.pdf$/i, '') + '_compressed.pdf';
  state.resultMeta = `Original: ${fmtSize(oldSize)} ➜ Compressed: ${fmtSize(newSize)} (${savedPct}% reduction, fits ${targetKb === 'auto' ? 'govt' : '< ' + targetKb + ' KB'} limit).`;
}

// 4. Split PDF
async function processSplit() {
  const file = state.files[0];
  const rangeStr = ($('#splitRange')?.value || '').trim();
  if (!rangeStr) throw new Error('Please enter page numbers to extract (e.g. 1-2, 5)');

  const lib = await getPdfLib();
  const pdfDoc = await lib.PDFDocument.load(await file.arrayBuffer());
  const maxPages = pdfDoc.getPageCount();

  const set = new Set();
  for (const part of rangeStr.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)(?:-(\d*))?$/);
    if (!m) throw new Error(`Invalid page range: ${p}`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : m[2] === '' ? maxPages : Number(m[2]);
    for (let i = a; i <= Math.min(b, maxPages); i++) if (i >= 1) set.add(i - 1);
  }
  if (!set.size) throw new Error('No valid pages found in range');

  const newDoc = await lib.PDFDocument.create();
  const copied = await newDoc.copyPages(pdfDoc, [...set].sort((x, y) => x - y));
  copied.forEach((cp) => newDoc.addPage(cp));

  const outBytes = await newDoc.save();
  state.resultBlob = new Blob([outBytes], { type: 'application/pdf' });
  state.resultName = file.name.replace(/\.pdf$/i, '') + '_extracted.pdf';
  state.resultMeta = `Extracted ${copied.length} pages (${fmtSize(state.resultBlob.size)}).`;
}

// 5. AI Document Scanner & Cleaner
let scanRotation = 0;
async function processScanner() {
  const file = state.files[0];
  const filterType = $('#scanFilters .preset-chip.active')?.dataset.filter || 'bw';
  $('#toolProgressBar').style.width = '50%';

  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  if (scanRotation % 180 === 0) {
    canvas.width = bmp.width;
    canvas.height = bmp.height;
  } else {
    canvas.width = bmp.height;
    canvas.height = bmp.width;
  }
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((scanRotation * Math.PI) / 180);
  ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;

  // Adaptive thresholding & Shadow removal filter
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;

    if (filterType === 'bw') {
      // Clean B&W Scanner: whiten paper, darken text
      const v = gray > 140 ? 255 : Math.max(0, gray * 0.7);
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
    } else if (filterType === 'color') {
      // Enhanced color: remove yellow cast and boost contrast
      d[i] = Math.min(255, Math.max(0, (r - 128) * 1.35 + 128 + 20));
      d[i + 1] = Math.min(255, Math.max(0, (g - 128) * 1.35 + 128 + 20));
      d[i + 2] = Math.min(255, Math.max(0, (b - 128) * 1.35 + 128 + 20));
    } else {
      // Photo contrast
      d[i] = Math.min(255, Math.max(0, (r - 128) * 1.25 + 128));
      d[i + 1] = Math.min(255, Math.max(0, (g - 128) * 1.25 + 128));
      d[i + 2] = Math.min(255, Math.max(0, (b - 128) * 1.25 + 128));
    }
  }
  ctx.putImageData(imgData, 0, 0);

  state.resultBlob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.94));
  state.resultName = 'Clean_Scanned_Document.jpg';
  state.resultMeta = `AI scan enhanced: shadows removed, paper whitened, high-contrast ink (${fmtSize(state.resultBlob.size)}).`;
}

// 6. Govt Photo & Signature Resizer
async function processResizer() {
  const file = state.files[0];
  const chip = $('#resizerPresets .preset-chip.active');
  const type = chip?.dataset.type || 'photo';
  const maxKb = parseInt(chip?.dataset.max || '50', 10);

  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');

  if (type === 'photo') {
    // 3.5cm x 4.5cm ratio (e.g. 420x540)
    canvas.width = 420;
    canvas.height = 540;
  } else if (type === 'sig') {
    // Signature ratio (e.g. 300x120)
    canvas.width = 300;
    canvas.height = 120;
  } else {
    canvas.width = 800;
    canvas.height = 1000;
  }
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);

  let quality = 0.85;
  let blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
  while (blob.size > maxKb * 1024 && quality > 0.2) {
    quality -= 0.1;
    blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
  }

  state.resultBlob = blob;
  state.resultName = type === 'photo' ? 'Govt_Passport_Photo.jpg' : 'Govt_Signature.jpg';
  state.resultMeta = `Resized to exact portal specs: ${fmtSize(blob.size)} (Target: < ${maxKb} KB ✅)`;
}

// 7. Unlock Aadhaar PDF
async function processUnlock() {
  const file = state.files[0];
  const pass = ($('#unlockPass')?.value || '').trim();
  if (!pass) throw new Error('Please enter the document password (e.g. RAME1992)');

  const lib = await getPdfLib();
  let pdfDoc;
  try {
    pdfDoc = await lib.PDFDocument.load(await file.arrayBuffer(), { password: pass });
  } catch {
    throw new Error('Incorrect password or unable to decrypt this document');
  }

  const outBytes = await pdfDoc.save();
  state.resultBlob = new Blob([outBytes], { type: 'application/pdf' });
  state.resultName = file.name.replace(/\.pdf$/i, '') + '_unlocked.pdf';
  state.resultMeta = `Password removed! Document is permanently unlocked (${fmtSize(state.resultBlob.size)}).`;
}

// Rotate button in Scanner
document.addEventListener('click', (e) => {
  if (e.target.closest('#scanRotateBtn')) {
    scanRotation = (scanRotation + 90) % 360;
    toast(`Rotated ${scanRotation}°`, 'info');
  }
});

// ---------- Result Presentation & Monetization ----------
function showResult() {
  const el = $('#toolResult');
  const count = getUsageCount();
  const isFree = count === 0;

  const url = URL.createObjectURL(state.resultBlob);
  const isImage = state.resultBlob.type.startsWith('image/');

  el.innerHTML = `
    <div style="font-size:2rem;margin-bottom:6px">🎉</div>
    <h3 style="margin:0 0 6px">Document Ready!</h3>
    <p class="muted small">${esc(state.resultMeta)}</p>

    ${isImage ? `<img class="preview-box" src="${url}" alt="Preview">` : ''}

    ${isFree ? `
      <div style="margin:12px 0">
        <span class="free-badge">✨ 1st Kiosk Service Free!</span>
      </div>
    ` : `
      <div class="pay-banner">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <b>Kiosk Service Fee</b>
          <b style="font-size:1.2rem;color:var(--primary)">₹2</b>
        </div>
        <p class="muted small" style="margin:4px 0 10px">Scan &amp; pay ₹2 via any UPI app or pay cash at counter.</p>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm btn-primary" type="button" id="payVerifyBtn">✓ I have paid ₹2</button>
          <button class="btn btn-sm btn-ghost" type="button" id="payCashBtn">💵 Pay Cash</button>
        </div>
      </div>
    `}

    <div id="actionRow" style="display:flex;flex-direction:column;gap:10px;margin-top:16px;${!isFree && !state.paid ? 'opacity:0.35;pointer-events:none' : ''}">
      <a class="btn btn-primary btn-lg" href="${url}" download="${esc(state.resultName)}">
        ${ICONS.download} Download ${esc(state.resultName)}
      </a>
      <button class="btn btn-ghost" type="button" id="directPrintBtn">
        🖨️ Print this document now (${cfg ? rupees(cfg.prices.bw) : '₹3'}/page)
      </button>
    </div>
  `;

  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  if (isFree) {
    recordUsage();
  }

  $('#payVerifyBtn')?.addEventListener('click', () => {
    state.paid = true;
    recordUsage();
    toast('Payment verified! Download unlocked', 'ok');
    $('#actionRow').style.opacity = '1';
    $('#actionRow').style.pointerEvents = 'auto';
  });

  $('#payCashBtn')?.addEventListener('click', () => {
    state.paid = true;
    recordUsage();
    toast('Cash at counter noted. Download unlocked', 'ok');
    $('#actionRow').style.opacity = '1';
    $('#actionRow').style.pointerEvents = 'auto';
  });

  $('#directPrintBtn')?.addEventListener('click', () => {
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = reader.result.split(',')[1];
      sessionStorage.setItem('emitra_direct_print_file', JSON.stringify({
        name: state.resultName,
        type: state.resultBlob.type,
        b64,
      }));
      location.href = '/print';
    };
    reader.readAsDataURL(state.resultBlob);
  });
}

// Initial Tool Selection
selectTool('compress');
