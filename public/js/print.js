import { initPage, $, $$, esc, rupees, fmtSize, api, upload, toast, errorText, myOrders, validPhone, setFieldError, fileIcon, ICONS } from './common.js';
import { t } from './i18n.js';

const cfg = await initPage();
const MAX_MB = cfg?.maxFileMb || 30;
const OK_EXT = ['pdf', 'jpg', 'jpeg', 'png'];

const state = { step: 1, local: [], order: null, opts: [] };

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
  if (!badName && !badPhone) show(2);
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
    state.opts = order.files.map((f) => ({ ...f, removed: false }));
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
const linePrice = (f) => f.pages * f.copies * (f.color ? state.order.prices.color : state.order.prices.bw);

function renderTotal() {
  const kept = state.opts.filter((f) => !f.removed);
  const total = kept.reduce((s, f) => s + linePrice(f), 0);
  $('#totalAmt').textContent = rupees(total);
  $('#payBtn').disabled = !kept.length;
  for (const f of state.opts) {
    const el = $(`[data-line="${f.id}"]`);
    if (el) el.textContent = rupees(linePrice(f));
  }
}

function renderOpts() {
  $('#optList').innerHTML = state.opts.filter((f) => !f.removed).map((f) => `
    <div class="opt-card" data-id="${esc(f.id)}">
      <div class="top">
        ${fileIcon(f.name)}
        <div class="fmeta" style="flex:1;min-width:0">
          <div class="fname" style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.name)}</div>
          <div class="fsub muted small">${f.pages === 1 ? t('page_1') : t('pages_n', { n: f.pages })}</div>
        </div>
        <button class="icon-btn" type="button" data-act="remove" aria-label="${esc(t('remove'))}">${ICONS.trash}</button>
      </div>
      <div class="controls">
        <div class="seg" role="group">
          <button type="button" data-act="bw" class="${f.color ? '' : 'on'}">${esc(t('bw_short'))}</button>
          <button type="button" data-act="color" class="${f.color ? 'on color-on' : ''}">${esc(t('colour_short'))}</button>
        </div>
        ${f.pages > 1 ? `
        <div class="seg" role="group">
          <button type="button" data-act="single" class="${f.duplex ? '' : 'on'}">${esc(t('sides_single'))}</button>
          <button type="button" data-act="double" class="${f.duplex ? 'on' : ''}">${esc(t('sides_double'))}</button>
        </div>` : ''}
        <div style="display:flex;align-items:center">
          <span class="lbl">${esc(t('copies'))}</span>
          <div class="stepper">
            <button type="button" data-act="minus" aria-label="-">−</button>
            <input type="number" min="1" max="100" value="${f.copies}" inputmode="numeric" aria-label="${esc(t('copies'))}">
            <button type="button" data-act="plus" aria-label="+">+</button>
          </div>
        </div>
        <span class="line-price" data-line="${esc(f.id)}"></span>
      </div>
    </div>`).join('');
  renderTotal();
}

$('#optList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const f = state.opts.find((x) => x.id === btn.closest('[data-id]').dataset.id);
  switch (btn.dataset.act) {
    case 'remove': f.removed = true; break;
    case 'bw': f.color = false; break;
    case 'color': f.color = true; break;
    case 'single': f.duplex = false; break;
    case 'double': f.duplex = true; break;
    case 'minus': f.copies = Math.max(1, f.copies - 1); break;
    case 'plus': f.copies = Math.min(100, f.copies + 1); break;
  }
  renderOpts();
});
$('#optList').addEventListener('input', (e) => {
  if (e.target.type !== 'number') return;
  const f = state.opts.find((x) => x.id === e.target.closest('[data-id]').dataset.id);
  f.copies = Math.min(100, Math.max(1, parseInt(e.target.value, 10) || 1));
  renderTotal();
});

$('#payBtn').addEventListener('click', async () => {
  const btn = $('#payBtn');
  btn.disabled = true;
  try {
    const files = state.opts.filter((f) => !f.removed).map(({ id, copies, color, duplex }) => ({ id, copies, color, duplex }));
    const order = await api(`/api/orders/${encodeURIComponent(state.order.id)}/print-options`, { method: 'PUT', body: { files } });
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
  api('/api/orders/' + encodeURIComponent(resume)).then((order) => {
    if (order.status !== 'draft') { location.replace('/order?id=' + encodeURIComponent(order.id)); return; }
    state.order = order;
    state.opts = order.files.map((f) => ({ ...f, removed: false }));
    renderOpts();
    show(3);
  }).catch(() => {});
}
