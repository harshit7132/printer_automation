import {
  initPage, $, $$, esc, rupees, fmtSize, upload, toast, errorText, myOrders, validPhone, setFieldError, fileIcon, ICONS,
  mountSavePrompt, saveMe,
} from './common.js';
import { t, pick, apply } from './i18n.js';

const cfg = await initPage();
const MAX_MB = cfg?.maxFileMb || 30;
const state = { step: 1, res: [], ref: [] };
const preselect = new URLSearchParams(location.search).get('pkg');
let savePrompt = { shouldSave: () => false };
mountSavePrompt($('#savePrompt'), { name: $('#name'), phone: $('#phone'), email: $('#email') }).then((p) => {
  savePrompt = p;
  loadDraft();
});

const DESIGN_DRAFT_KEY = 'emitra_design_draft';
const CUSTOMER_STORAGE_KEY = 'emitra_customer_details';

function saveDraft() {
  try {
    const val = (id) => ($('#' + id)?.value || '').trim();
    const draft = {
      name: val('name'),
      phone: val('phone'),
      email: val('email'),
      service: $('input[name=service]:checked')?.value || '',
      pkg: $('input[name=pkg]:checked')?.value || '',
      title: val('title'),
      desc: val('desc'),
      textContent: val('textContent'),
      size: $('#size')?.value || 'A4',
      customSize: val('customSize'),
      colors: val('colors'),
      deadline: val('deadline'),
      step: state.step || 1,
    };
    localStorage.setItem(DESIGN_DRAFT_KEY, JSON.stringify(draft));
    if (draft.name || draft.phone) {
      localStorage.setItem(CUSTOMER_STORAGE_KEY, JSON.stringify({ name: draft.name, phone: draft.phone, notes: '' }));
    }
  } catch { /* ignore */ }
}

function loadDraft() {
  try {
    let draft = null;
    const raw = localStorage.getItem(DESIGN_DRAFT_KEY);
    if (raw) draft = JSON.parse(raw);
    const custRaw = localStorage.getItem(CUSTOMER_STORAGE_KEY);
    const cust = custRaw ? JSON.parse(custRaw) : {};

    const name = draft?.name || cust?.name || '';
    const phone = draft?.phone || cust?.phone || '';
    const email = draft?.email || '';

    const nameEl = $('#name');
    const phoneEl = $('#phone');
    const emailEl = $('#email');
    if (name && nameEl && !nameEl.value) nameEl.value = name;
    if (phone && phoneEl && !phoneEl.value) phoneEl.value = phone;
    if (email && emailEl && !emailEl.value) emailEl.value = email;

    if (draft) {
      if (draft.title && $('#title') && !$('#title').value) $('#title').value = draft.title;
      if (draft.desc && $('#desc') && !$('#desc').value) $('#desc').value = draft.desc;
      if (draft.textContent && $('#textContent') && !$('#textContent').value) $('#textContent').value = draft.textContent;
      if (draft.size && $('#size')) $('#size').value = draft.size;
      if (draft.customSize && $('#customSize') && !$('#customSize').value) $('#customSize').value = draft.customSize;
      if (draft.colors && $('#colors') && !$('#colors').value) $('#colors').value = draft.colors;
      if (draft.deadline && $('#deadline') && !$('#deadline').value) $('#deadline').value = draft.deadline;
      return draft;
    }
  } catch { /* ignore */ }
  return null;
}

if (cfg && !cfg.accepting.design) {
  toast(t('e_closed_design'), 'bad');
  setTimeout(() => { location.href = '/'; }, 2500);
}

function show(step) {
  state.step = step;
  saveDraft();
  $$('[data-step]').forEach((s) => s.classList.toggle('hidden', Number(s.dataset.step) !== step));
  $$('#stepbar .s').forEach((s, i) => {
    s.classList.toggle('done', i < step - 1);
    s.classList.toggle('active', i === step - 1);
  });
  if (step === 3) renderSummary();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$$('[data-back]').forEach((b) => b.addEventListener('click', () => show(Number(b.dataset.back))));

function renderChoices(savedPkg, savedSvc) {
  const checkedSvc = $('input[name=service]:checked')?.value || savedSvc;
  $('#services').innerHTML = (cfg?.services || []).map((s) => `
    <label class="chip"><input type="radio" name="service" value="${esc(s)}" ${s === checkedSvc ? 'checked' : ''}><span>${esc(t('svc_' + s))}</span></label>`).join('');

  const checkedPkg = $('input[name=pkg]:checked')?.value || savedPkg || preselect;
  $('#pkgPick').innerHTML = (cfg?.packages || []).map((p) => `
    <label class="pkg-opt">
      <input type="radio" name="pkg" value="${p.id}" ${String(p.id) === String(checkedPkg) ? 'checked' : ''}>
      <span class="box">
        <span class="radio"></span>
        <span class="info"><b>${esc(pick(p, 'name'))}</b><small>${esc(pick(p, 'desc'))}</small></span>
        <span class="amt">${rupees(p.price)}</span>
      </span>
    </label>`).join('');
}

// Step 1
$('#detailsForm').addEventListener('input', saveDraft);
$('#detailsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const badPhone = setFieldError($('#phone'), !validPhone($('#phone').value));
  const badName = setFieldError($('#name'), $('#name').value.trim().length < 2);
  if (badName || badPhone) return;
  saveDraft();
  if (savePrompt.shouldSave()) {
    saveMe({ name: $('#name').value.trim(), phone: $('#phone').value.trim(), email: $('#email').value.trim() }).catch(() => {});
  }
  show(2);
});

// Step 2
$('#briefForm').addEventListener('input', saveDraft);
$('#briefForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const bad = [
    setFieldError($('#desc'), !$('#desc').value.trim()),
    setFieldError($('#title'), !$('#title').value.trim()),
  ];
  const noPkg = !$('input[name=pkg]:checked');
  $('#pkgField').classList.toggle('invalid', noPkg);
  const noSvc = !$('input[name=service]:checked');
  $('#serviceField').classList.toggle('invalid', noSvc);
  if (noSvc || noPkg) $('#serviceField').scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (!bad.some(Boolean) && !noPkg && !noSvc) {
    saveDraft();
    show(3);
  }
});
$('#briefForm').addEventListener('change', (e) => {
  if (e.target.name === 'service') $('#serviceField').classList.remove('invalid');
  if (e.target.name === 'pkg') $('#pkgField').classList.remove('invalid');
  saveDraft();
  if (state.step === 3) renderSummary();
});

async function prepareFile(f) {
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  if (['heic', 'heif'].includes(ext) || f.type === 'image/heic' || f.type === 'image/heif') {
    try {
      toast(t('converting_heic'), 'info');
      const mod = await import('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/+esm');
      const heic2any = mod.default || mod;
      const res = await heic2any({ blob: f, toType: 'image/jpeg', quality: 0.92 });
      const blob = Array.isArray(res) ? res[0] : res;
      const cleanName = f.name.replace(/\.(heic|heif)$/i, '') + '.jpg';
      return new File([blob], cleanName, { type: 'image/jpeg' });
    } catch {
      toast(t('err_heic', { f: f.name }), 'bad');
      return null;
    }
  }
  return f;
}

// Step 3: files
function renderFiles(key) {
  $(`#${key}List`).innerHTML = state[key].map((f, i) => `
    <div class="file-item">
      ${fileIcon(f.name)}
      <div class="fmeta"><div class="fname">${esc(f.name)}</div><div class="fsub">${fmtSize(f.size)}</div></div>
      <button class="icon-btn" type="button" data-rm="${i}" aria-label="${esc(t('remove'))}">${ICONS.trash}</button>
    </div>`).join('');
}
for (const [key, max] of [['res', 12], ['ref', 6]]) {
  const input = $(`#${key}Input`);
  input.addEventListener('change', async () => {
    for (let f of input.files) {
      f = await prepareFile(f);
      if (!f) continue;
      if (f.size > MAX_MB * 1048576) { toast(t('err_file_size', { f: f.name, mb: MAX_MB }), 'bad'); continue; }
      if (state[key].length < max && !state[key].some((x) => x.name === f.name && x.size === f.size)) state[key].push(f);
    }
    input.value = '';
    renderFiles(key);
  });
  $(`#${key}List`).addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]');
    if (b) { state[key].splice(Number(b.dataset.rm), 1); renderFiles(key); }
  });
}

function selectedPkg() {
  const id = $('input[name=pkg]:checked')?.value;
  return cfg?.packages.find((p) => String(p.id) === id);
}

function renderSummary() {
  const pkg = selectedPkg();
  const svc = $('input[name=service]:checked')?.value;
  $('#summary').innerHTML = `
    <div class="ln"><span>${esc(t('service'))}</span><span>${esc(svc ? t('svc_' + svc) : '—')}</span></div>
    <div class="ln"><span>${esc(t('package'))}</span><span>${esc(pkg ? pick(pkg, 'name') : '—')}</span></div>
    <div class="ln"><span>${esc(t('f_title'))}</span><span>${esc($('#title').value.trim())}</span></div>
    <div class="ln total"><span>${esc(t('total'))}</span><span>${pkg ? rupees(pkg.price) : '—'}</span></div>`;
  $('#submitBtn').textContent = `${t('submit_pay')} ${pkg ? rupees(pkg.price) : ''}`;
}

$('#submitBtn').addEventListener('click', async () => {
  const fd = new FormData();
  const val = (id) => $('#' + id).value.trim();
  fd.append('name', val('name'));
  fd.append('phone', val('phone'));
  fd.append('email', val('email'));
  fd.append('service', $('input[name=service]:checked')?.value || '');
  fd.append('packageId', $('input[name=pkg]:checked')?.value || '');
  for (const k of ['title', 'textContent', 'size', 'customSize', 'colors', 'deadline']) fd.append(k, val(k));
  fd.append('description', val('desc'));
  state.res.forEach((f) => fd.append('resources', f, f.name));
  state.ref.forEach((f) => fd.append('references', f, f.name));

  const btn = $('#submitBtn');
  btn.disabled = true;
  $('#uploadProgress').classList.remove('hidden');
  const setP = (p) => {
    $('#progressBar').style.width = p + '%';
    $('#progressText').textContent = p < 100 ? t('uploading', { p }) : t('processing');
  };
  setP(0);
  try {
    const order = await upload('/api/design-orders', fd, setP);
    localStorage.removeItem(DESIGN_DRAFT_KEY);
    myOrders.add(order);
    location.href = '/order?id=' + encodeURIComponent(order.id);
  } catch (err) {
    toast(errorText(err), 'bad');
    btn.disabled = false;
    $('#uploadProgress').classList.add('hidden');
  }
});

window.addEventListener('langchange', () => {
  const d = loadDraft();
  renderChoices(d?.pkg, d?.service);
  renderFiles('res');
  renderFiles('ref');
  renderSummary();
  apply();
});

const savedDraft = loadDraft();
renderChoices(savedDraft?.pkg, savedDraft?.service);

const validDetails = ($('#name')?.value || '').trim().length >= 2 && validPhone($('#phone')?.value);
const validBrief = ($('#title')?.value || '').trim() && ($('#desc')?.value || '').trim() && $('input[name=pkg]:checked') && $('input[name=service]:checked');

if (savedDraft?.step === 3 && validDetails && validBrief) {
  show(3);
} else if (savedDraft?.step === 2 && validDetails) {
  show(2);
} else {
  show(1);
}
