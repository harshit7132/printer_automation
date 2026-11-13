import {
  initPage, $, $$, esc, rupees, fmtSize, api, upload, toast, errorText, myOrders, validPhone, setFieldError, fileIcon, ICONS,
  mountSavePrompt, loadMe, saveMe,
} from './common.js';
import { t } from './i18n.js';

const cfg = await initPage();
const MAX_MB = cfg?.maxFileMb || 30;
const OK_EXT = ['pdf', 'jpg', 'jpeg', 'png'];

const state = { step: 1, local: [], order: null, opts: [] };
let savePrompt = { shouldSave: () => false };
mountSavePrompt($('#savePrompt'), { name: $('#name'), phone: $('#phone') }).then((p) => { savePrompt = p; });

function show(step) {
  state.step = step;
  $$('[data-step]').forEach((s) => s.classList.toggle('hidden', Number(s.dataset.step) !== step));
  const bar = Math.min(step, 2) - 1; // details=0, upload/options=1
  $$('#stepbar .s').forEach((s, i) => {
    s.classList.toggle('done', i < bar);
    s.classList.toggle('active', i === bar);
  });
  $('#bottomBar').classList.toggle('hidden', step !== 3);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

if (cfg && !cfg.accepting.print) {
  toast(t('e_closed_print'), 'bad');
  setTimeout(() => { location.href = '/'; }, 2500);
}

// ---------- Step 1 ----------
$('#detailsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#name');
  const phone = $('#phone');
  const badPhone = setFieldError(phone, !validPhone(phone.value));
  const badName = setFieldError(name, name.value.trim().length < 2);
  if (badName || badPhone) return;
  if (savePrompt.shouldSave()) saveMe({ name: name.value.trim(), phone: phone.value.trim() }).catch(() => {});
  show(2);
});
$$('[data-back]').forEach((b) => b.addEventListener('click', () => show(Number(b.dataset.back))));

// ---------- Step 2: choose files ----------
function renderLocal() {
  $('#dropSub').textContent = t('drop_sub_print', { mb: MAX_MB });
  $('#localList').innerHTML = state.local.map((f, i) => `
    <div class="file-item">
      ${fileIcon(f.name)}
      <div class="fmeta"><div class="fname">${esc(f.name)}</div><div class="fsub">${fmtSize(f.size)}</div></div>
      <button class="icon-btn" type="button" data-rm="${i}" aria-label="${esc(t('remove'))}">${ICONS.trash}</button>
    </div>`).join('');
  $('#uploadBtn').disabled = !state.local.length;
}

function addFiles(list) {
  for (const f of list) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (!OK_EXT.includes(ext)) { toast(t('err_file_type', { f: f.name }), 'bad'); continue; }
    if (f.size > MAX_MB * 1048576) { toast(t('err_file_size', { f: f.name, mb: MAX_MB }), 'bad'); continue; }
    if (state.local.length >= 20) break;
    if (!state.local.some((x) => x.name === f.name && x.size === f.size)) state.local.push(f);
  }
  renderLocal();
}

const input = $('#fileInput');
input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
const dz = $('#dropzone');
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); addFiles(e.dataTransfer.files); });
$('#localList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rm]');
  if (b) { state.local.splice(Number(b.dataset.rm), 1); renderLocal(); }
});

/** Turns server file rows into editable option objects, starting from the customer's saved preferences. */
async function buildOpts(order) {
  const caps = order.caps;
  const prefs = (await loadMe()).profile?.prefs || {};
  state.opts = order.files.map((f) => {
    let sides = caps.sides.includes(prefs.sides) ? prefs.sides : f.sides;
    if (sides === 'manual' && f.encrypted) sides = 'single';
    return {
      ...f,
      color: prefs.color ?? f.color,
      sides,
      paper: caps.papers.includes(prefs.paper) ? prefs.paper : f.paper,
      orientation: prefs.orientation || f.orientation,
      scale: prefs.scale || f.scale,
      rangeMode: f.range ? 'custom' : 'all',
      removed: false,
      open: false,
    };
  });
}

$('#uploadBtn').addEventListener('click', async () => {
  if (!state.local.length) return toast(t('err_no_files'), 'bad');
  const fd = new FormData();
  fd.append('name', $('#name').value.trim());
  fd.append('phone', $('#phone').value.trim());
  fd.append('notes', $('#notes').value.trim());
  state.local.forEach((f) => fd.append('files', f, f.name));

  const btn = $('#uploadBtn');
  btn.disabled = true;
  $('#uploadProgress').classList.remove('hidden');
  const setP = (p) => {
    $('#progressBar').style.width = p + '%';
    $('#progressText').textContent = p < 100 ? t('uploading', { p }) : t('processing');
  };
  setP(0);
  try {
    const order = await upload('/api/print-orders', fd, setP);
    state.order = order;
    await buildOpts(order);
    myOrders.add(order);
    renderOpts();
    show(3);
  } catch (err) {
    toast(errorText(err), 'bad');
  } finally {
    btn.disabled = false;
    $('#uploadProgress').classList.add('hidden');
  }
});

// ---------- Step 3: options ----------
/** Same rules as the server: "1-3, 5, 8-" -> page numbers, or null if invalid. */
function parseRange(str, max) {
  const s = String(str || '').replace(/\s+/g, '');
  if (!s || !/^[\d,-]+$/.test(s)) return null;
  const set = new Set();
  for (const part of s.split(',')) {
    if (!part) continue;
    const m = part.match(/^(\d+)(?:-(\d*))?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : m[2] === '' ? max : Number(m[2]);
    if (a < 1 || b < a || a > max) return null;
    for (let p = a; p <= Math.min(b, max); p++) set.add(p);
  }
  return set.size ? set.size : null;
}

function selPages(f) {
  if (f.rangeMode !== 'custom') return f.pages;
  return parseRange(f.range, f.pages) || 0;
}
const linePrice = (f) => selPages(f) * f.copies * (f.color ? state.order.prices.color : state.order.prices.bw);
const sideLabel = (s) => ({ single: t('sides_single'), long: t('sides_long'), short: t('sides_short'), manual: t('sides_manual') }[s]);

function renderTotal() {
  const kept = state.opts.filter((f) => !f.removed);
  const total = kept.reduce((s, f) => s + linePrice(f), 0);
  const invalid = kept.some((f) => f.rangeMode === 'custom' && !selPages(f));
  $('#totalAmt').textContent = rupees(total);
  $('#payBtn').disabled = !kept.length || invalid;
  for (const f of kept) {
    const line = $(`[data-line="${f.id}"]`);
    if (line) line.textContent = rupees(linePrice(f));
    const sel = $(`[data-sel="${f.id}"]`);
    if (sel) {
      const n = selPages(f);
      sel.textContent = n ? t('sel_pages', { n, total: f.pages }) : t('err_range', { max: f.pages });
      sel.classList.toggle('err-text', !n);
    }
  }
}

const seg = (act, items, cur, extraCls = () => '') => `<div class="seg" role="group">${items.map(([v, label]) =>
  `<button type="button" data-act="${act}" data-val="${v}" class="${v === cur ? `on ${extraCls(v)}` : ''}">${esc(label)}</button>`).join('')}</div>`;

function optCard(f, multi) {
  const caps = state.order.caps;
  const n = selPages(f);
  const sides = caps.sides.filter((s) => !(s === 'manual' && f.encrypted));
  const summary = [f.rangeMode === 'custom' ? f.range : t('o_all'), f.paper, t('o_' + f.orientation), t('o_' + f.scale)].join(' · ');
  return `
  <div class="opt-card" data-id="${esc(f.id)}">
    <div class="top">
      ${fileIcon(f.name)}
      <div class="fmeta" style="flex:1;min-width:0">
        <div class="fname" style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.name)}</div>
        <div class="fsub muted small">${f.pages === 1 ? t('page_1') : t('pages_n', { n: f.pages })}</div>
      </div>
      <button class="icon-btn" type="button" data-act="remove" aria-label="${esc(t('remove'))}">${ICONS.trash}</button>
    </div>
    <div class="controls" style="display:block">
      <div class="opt-row">
        ${seg('color', [['bw', t('bw_short')], ['color', t('colour_short')]], f.color ? 'color' : 'bw', (v) => (v === 'color' ? 'color-on' : ''))}
        ${n > 1 ? seg('sides', sides.map((s) => [s, sideLabel(s)]), f.sides) : ''}
      </div>
      ${f.sides === 'manual' && n > 1 ? `<p class="opt-hint">ℹ️ <span>${esc(t('manual_hint'))}</span></p>` : ''}
      ${f.encrypted && caps.sides.includes('manual') && f.pages > 1 ? `<p class="opt-hint">🔒 <span>${esc(t('enc_note'))}</span></p>` : ''}
      <div class="opt-row" style="margin-top:12px">
        <span class="lbl">${esc(t('copies'))}</span>
        <div class="stepper">
          <button type="button" data-act="minus" aria-label="-">−</button>
          <input type="number" min="1" max="100" value="${f.copies}" inputmode="numeric" data-copies aria-label="${esc(t('copies'))}">
          <button type="button" data-act="plus" aria-label="+">+</button>
        </div>
        <span class="line-price" data-line="${esc(f.id)}"></span>
      </div>
    </div>
    <details class="more" ${f.open ? 'open' : ''}>
      <summary>${esc(t('more_opts'))} <small>${esc(summary)}</small></summary>
      ${f.pages > 1 ? `<div class="grp"><span class="lbl">${esc(t('o_pages'))}</span>
        <div class="opt-row">
          ${seg('rangeMode', [['all', t('o_all')], ['custom', t('o_custom')]], f.rangeMode)}
          ${f.rangeMode === 'custom' ? `<input class="range-input" type="text" inputmode="numeric" data-range value="${esc(f.range)}" placeholder="${esc(t('range_ph'))}" aria-label="${esc(t('o_pages'))}">` : ''}
        </div>
        ${f.rangeMode === 'custom' ? `<p class="opt-hint" data-sel="${esc(f.id)}"></p>` : ''}
      </div>` : ''}
      ${caps.papers.length > 1 ? `<div class="grp"><span class="lbl">${esc(t('o_paper'))}</span>${seg('paper', caps.papers.map((p) => [p, p]), f.paper)}</div>` : ''}
      <div class="grp"><span class="lbl">${esc(t('o_orient'))}</span>${seg('orientation', caps.orientations.map((o) => [o, t('o_' + o)]), f.orientation)}</div>
      <div class="grp"><span class="lbl">${esc(t('o_scale'))}</span>${seg('scale', caps.scales.map((s) => [s, t('o_' + s)]), f.scale)}</div>
    </details>
    ${multi ? `<button class="link-btn apply-all" type="button" data-act="applyAll">⧉ ${esc(t('apply_all'))}</button>` : ''}
  </div>`;
}

function renderOpts() {
  const kept = state.opts.filter((f) => !f.removed);
  $('#optList').innerHTML = kept.map((f) => optCard(f, kept.length > 1)).join('');
  renderTotal();
}

const fileOf = (el) => state.opts.find((x) => x.id === el.closest('[data-id]').dataset.id);

$('#optList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const f = fileOf(btn);
  const v = btn.dataset.val;
  switch (btn.dataset.act) {
    case 'remove': f.removed = true; break;
    case 'color': f.color = v === 'color'; break;
    case 'sides': f.sides = v; break;
    case 'paper': f.paper = v; f.open = true; break;
    case 'orientation': f.orientation = v; f.open = true; break;
    case 'scale': f.scale = v; f.open = true; break;
    case 'rangeMode': f.rangeMode = v; f.open = true; break;
    case 'minus': f.copies = Math.max(1, f.copies - 1); break;
    case 'plus': f.copies = Math.min(100, f.copies + 1); break;
    case 'applyAll':
      for (const o of state.opts) {
        if (o === f || o.removed) continue;
        Object.assign(o, { color: f.color, copies: f.copies, paper: f.paper, orientation: f.orientation, scale: f.scale });
        o.sides = o.encrypted && f.sides === 'manual' ? 'single' : f.sides;
      }
      toast(t('applied'), 'ok');
      break;
  }
  renderOpts();
  if (btn.dataset.act === 'rangeMode' && v === 'custom') $(`[data-id="${CSS.escape(f.id)}"] [data-range]`)?.focus();
});
// typing in copies / page range: update prices without re-rendering (keeps the keyboard open)
$('#optList').addEventListener('input', (e) => {
  const f = fileOf(e.target);
  if (e.target.matches('[data-copies]')) f.copies = Math.min(100, Math.max(1, parseInt(e.target.value, 10) || 1));
  if (e.target.matches('[data-range]')) f.range = e.target.value;
  renderTotal();
});
$('#optList').addEventListener('toggle', (e) => {
  if (e.target.matches('details')) fileOf(e.target).open = e.target.open;
}, true);

$('#payBtn').addEventListener('click', async () => {
  const btn = $('#payBtn');
  btn.disabled = true;
  try {
    const kept = state.opts.filter((f) => !f.removed);
    const files = kept.map((f) => ({
      id: f.id, copies: f.copies, color: f.color, sides: f.sides, paper: f.paper, orientation: f.orientation, scale: f.scale,
      range: f.rangeMode === 'custom' ? f.range : '',
    }));
    const order = await api(`/api/orders/${encodeURIComponent(state.order.id)}/print-options`, { method: 'PUT', body: { files } });
    if (savePrompt.shouldSave()) {
      const f = kept[0];
      await saveMe({ prefs: { color: f.color, sides: f.sides, paper: f.paper, orientation: f.orientation, scale: f.scale } }).catch(() => {});
    }
    location.href = '/order?id=' + encodeURIComponent(order.id);
  } catch (err) {
    toast(errorText(err), 'bad');
    btn.disabled = false;
  }
});

$('#restartBtn').addEventListener('click', async () => {
  if (state.order) {
    api(`/api/orders/${encodeURIComponent(state.order.id)}/cancel`, { method: 'POST', body: {} }).catch(() => {});
  }
  state.order = null;
  state.opts = [];
  state.local = [];
  renderLocal();
  show(2);
});

window.addEventListener('langchange', () => {
  renderLocal();
  if (state.order) renderOpts();
});

renderLocal();
show(1);

// Coming back to an order whose options were never confirmed
const resume = new URLSearchParams(location.search).get('resume');
if (resume) {
  api('/api/orders/' + encodeURIComponent(resume)).then(async (order) => {
    if (order.status !== 'draft') { location.replace('/order?id=' + encodeURIComponent(order.id)); return; }
    state.order = order;
    await buildOpts(order);
    renderOpts();
    show(3);
  }).catch(() => {});
}
