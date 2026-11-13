import { $, $$, esc, rupees, fmtSize, api, upload, toast, ApiError } from './common.js';

const A = (path, opts) => api('/api/admin' + path, opts);

const SERVICE = { logo: 'Logo', visiting: 'Visiting card', wedding: 'Wedding / invitation', banner: 'Banner / flex', poster: 'Poster / pamphlet', social: 'Social media post', biodata: 'Resume / biodata', other: 'Other' };
const STATUS = {
  draft: ['Choosing options', ''], awaiting_payment: ['Awaiting payment', 'warn'], payment_submitted: ['Verify payment', 'warn live'],
  queued: ['Queued', 'info'], printing: ['Printing', 'info live'], flip_needed: ['Waiting for page flip', 'warn live'], printed: ['Printed', 'ok'], failed: ['Print failed', 'bad'],
  in_progress: ['Designing', 'info'], completed: ['Delivered', 'ok'], rejected: ['Rejected', 'bad'], cancelled: ['Cancelled', 'bad'], expired: ['Expired', ''],
};
const TABS = [
  { id: 'pending', ico: '💰', label: 'Verify payments', count: (s) => s.pending },
  { id: 'queue', ico: '🖨️', label: 'Print queue', count: (s) => s.queued + s.failed },
  { id: 'design', ico: '🎨', label: 'Design orders', count: (s) => s.design },
  { id: 'history', ico: '📋', label: 'All orders' },
  { id: 'offers', ico: '🏷️', label: 'Offers & packages' },
  { id: 'settings', ico: '⚙️', label: 'Settings' },
  { id: 'qr', ico: '🔳', label: 'Shop QR poster' },
  { id: 'activity', ico: '🛡️', label: 'Security log' },
];
const LIVE = ['pending', 'queue', 'design'];

let current = TABS.some((t) => t.id === location.hash.slice(1)) ? location.hash.slice(1) : 'pending';
let summary = null;
let lastPending = -1;
let pollTimer = null;
let historyQuery = '';

const when = (ms) => (ms ? new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');

// ---------- auth ----------
function showLogin() {
  clearInterval(pollTimer);
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
  $('#u').focus();
}

async function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  renderTabs();
  await refreshSummary();
  renderTab();
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, 8000);
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}

function handleErr(e) {
  if (e instanceof ApiError && e.status === 401) return showLogin();
  toast(e.message || 'Something went wrong', 'bad');
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    await A('/login', { method: 'POST', body: { username: $('#u').value, password: $('#p').value } });
    $('#p').value = '';
    showApp();
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    btn.disabled = false;
  }
});

$$('[data-logout]').forEach((b) => b.addEventListener('click', async () => {
  await A('/logout', { method: 'POST', body: {} }).catch(() => {});
  showLogin();
}));

// ---------- shell ----------
function renderTabs() {
  const html = TABS.map((t) => `
    <button class="tab-btn ${t.id === current ? 'on' : ''}" type="button" data-tab="${t.id}">
      <span class="ico">${t.ico}</span>${esc(t.label)}<span class="count" data-count="${t.id}"></span>
    </button>`).join('');
  $('#sideTabs').innerHTML = html;
  $('#mobileTabs').innerHTML = html;
  updateCounts();
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  current = b.dataset.tab;
  history.replaceState(null, '', '#' + current);
  $$('[data-tab]').forEach((x) => x.classList.toggle('on', x.dataset.tab === current));
  renderTab();
});

function updateCounts() {
  if (!summary) return;
  for (const t of TABS) {
    const n = t.count ? t.count(summary) : 0;
    $$(`[data-count="${t.id}"]`).forEach((el) => { el.textContent = n ? String(n) : ''; });
  }
  document.title = summary.pending ? `(${summary.pending}) Owner dashboard` : 'Owner dashboard';
}

async function refreshSummary() {
  summary = await A('/summary');
  $('#stats').innerHTML = `
    <div class="stat hl"><small>Collected today</small><b>${rupees(summary.revenueToday)}</b></div>
    <div class="stat"><small>Orders today</small><b>${summary.ordersToday}</b></div>
    <div class="stat"><small>Waiting for you</small><b>${summary.pending}</b></div>
    <div class="stat"><small>Print queue${summary.queuePaused ? ' (paused)' : ''}</small><b>${summary.queued}${summary.failed ? ` <span style="color:var(--bad);font-size:.9rem">+${summary.failed} failed</span>` : ''}</b></div>`;
  updateCounts();
  if (lastPending >= 0 && summary.pending > lastPending) alertNew(summary.pending - lastPending);
  lastPending = summary.pending;
}

function alertNew(n) {
  toast(`💰 ${n} new payment${n > 1 ? 's' : ''} to verify`, 'ok');
  try {
    const ctx = new AudioContext();
    [0, 0.18].forEach((d) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.2, ctx.currentTime + d);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + d + 0.15);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + d);
      o.stop(ctx.currentTime + d + 0.16);
    });
  } catch { /* no audio */ }
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    new Notification('New payment to verify', { body: `${n} order(s) waiting`, icon: '/img/icon.svg' });
  }
}

async function poll() {
  try {
    await refreshSummary();
    const typing = document.activeElement?.closest('#tab') && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (LIVE.includes(current) && !typing) renderTab(true);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) showLogin();
  }
}

async function renderTab(silent = false) {
  const tab = $('#tab');
  const tabAtStart = current;
  if (!silent) tab.innerHTML = '<div class="loader"><svg class="spin" viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg></div>';
  try {
    const html = await VIEWS[current]();
    if (current !== tabAtStart) return;
    tab.innerHTML = html;
    AFTER[current]?.();
  } catch (e) {
    handleErr(e);
  }
}

// ---------- order cards ----------
function fileRow(f) {
  const sides = { long: '2-sided', short: '2-sided (short edge)', manual: '2-sided (manual flip)' }[f.sides];
  const opts = f.kind === 'print'
    ? [
      f.range ? `pages ${f.range} (${f.selPages}/${f.pages})` : `${f.pages}p`,
      `× ${f.copies}`, f.color ? 'Colour' : 'B/W', sides, f.paper,
      f.orientation !== 'auto' ? f.orientation : '', f.scale !== 'fit' ? { shrink: 'shrink only', noscale: 'actual size' }[f.scale] : '',
    ].filter(Boolean).join(' • ')
    : fmtSize(f.size);
  return `<div class="ofile">
    <span class="tag">${esc(f.kind)}</span>
    <span class="n" title="${esc(f.name)}">${esc(f.name)}</span>
    <span class="o">${esc(opts)}</span>
    ${f.purged ? '<span class="o">deleted</span>' : `<a href="/api/admin/files/${encodeURIComponent(f.id)}" download>Download</a>`}
  </div>`;
}

function actionsFor(o, ctx) {
  const b = (act, label, cls = 'btn-ghost') => `<button class="btn btn-sm ${cls}" type="button" data-act="${act}" data-id="${esc(o.id)}">${label}</button>`;
  const acts = [];
  switch (o.status) {
    case 'payment_submitted':
      acts.push(b('verify', '✓ Payment received — start', 'btn-ok'), b('payment_missing', 'Not received'), b('reject', 'Reject', 'btn-bad'));
      break;
    case 'awaiting_payment':
      acts.push(b('verify', 'Mark as paid (cash)', 'btn-ok'), b('reject', 'Reject', 'btn-bad'));
      break;
    case 'queued':
      acts.push(b('top', '⬆ Print next'), b('cancel', 'Cancel', 'btn-bad'));
      break;
    case 'flip_needed':
      acts.push(b('continue', '▶ Pages flipped — print backs', 'btn-ok'), b('cancel', 'Cancel', 'btn-bad'));
      break;
    case 'failed':
      acts.push(b('reprint', '↻ Reprint', 'btn-primary'), b('printed', 'It printed fine'), b('cancel', 'Cancel', 'btn-bad'));
      break;
    case 'printed':
      acts.push(b('reprint', '↻ Reprint'));
      break;
    case 'in_progress':
      acts.push(b('complete', '✓ Mark delivered', 'btn-ok'), b('cancel', 'Cancel', 'btn-bad'));
      break;
  }
  if (ctx === 'history' && o.status !== 'printing') acts.push(b('delete', '🗑 Delete', 'btn-ghost'));
  return acts.join('');
}

function deliverBox(o) {
  if (o.type !== 'design' || !['in_progress', 'completed'].includes(o.status)) return '';
  return `<div class="toolbar" style="margin:12px 0 0">
    <input type="file" id="dl-${esc(o.id)}" multiple class="grow" style="padding:8px">
    <button class="btn btn-sm btn-primary" type="button" data-act="deliver" data-id="${esc(o.id)}">⬆ Send design to customer</button>
  </div>`;
}

function briefBox(o) {
  const b = o.brief;
  if (!b) return '';
  const row = (k, v) => (v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : '');
  return `<div class="brief"><dl>
    ${row('Service', SERVICE[b.service] || b.service)}${row('Package', b.packageName)}${row('Title', b.title)}
    ${row('Description', b.description)}${row('Text on design', b.textContent)}
    ${row('Size', [b.size, b.customSize].filter(Boolean).join(' — '))}${row('Colours', b.colors)}${row('Needed by', b.deadline)}
  </dl></div>`;
}

function orderCard(o, ctx) {
  const c = o.customer || {};
  const [label, tone] = STATUS[o.status] || [o.status, ''];
  const files = o.files.filter((f) => f.kind !== 'delivery');
  const delivered = o.files.filter((f) => f.kind === 'delivery');
  return `<article class="ocard ${o.status === 'payment_submitted' ? 'attn' : ''}">
    <div class="oh">
      <span class="code">${esc(o.code)}</span>
      <span class="type">${o.type}</span>
      ${o.account ? `<span class="type" title="Customer account">👤 ${esc({ 'google.com': 'Google', password: 'Email', anonymous: 'Guest' }[o.account] || o.account)}</span>` : ''}
      <span class="pill ${tone}">${esc(label)}${o.queuePosition ? ` #${o.queuePosition}` : ''}</span>
      <span class="amt">${rupees(o.amount)}</span>
    </div>
    <div class="who">
      <span><b>${esc(c.name || '(erased)')}</b></span>
      ${c.phone ? `<a href="tel:+91${esc(c.phone)}">📞 ${esc(c.phone)}</a> <a href="https://wa.me/91${esc(c.phone)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>` : ''}
      ${c.email ? `<span>${esc(c.email)}</span>` : ''}
      <span>Created ${when(o.createdAt)}</span>
      ${o.paidAt ? `<span>Paid ${when(o.paidAt)}</span>` : ''}
    </div>
    ${c.utr ? `<div class="utr-box"><small>UTR — match with your bank SMS</small><code>${esc(c.utr)}</code><span class="muted small">for ${rupees(o.amount)}</span></div>` : ''}
    ${c.notes ? `<div class="muted small">📝 ${esc(c.notes)}</div>` : ''}
    ${o.error ? `<div class="oerr">⚠ ${esc(o.error)}</div>` : ''}
    ${o.adminNote ? `<div class="muted small">Your note: ${esc(o.adminNote)}</div>` : ''}
    ${briefBox(o)}
    ${files.length ? `<div class="ofiles">${files.map(fileRow).join('')}</div>` : ''}
    ${delivered.length ? `<div class="muted small" style="margin-top:8px">Delivered files:</div><div class="ofiles">${delivered.map(fileRow).join('')}</div>` : ''}
    ${deliverBox(o)}
    <div class="oacts">${actionsFor(o, ctx)}</div>
  </article>`;
}

const empty = (e, msg) => `<div class="empty"><div class="e">${e}</div>${esc(msg)}</div>`;

$('#tab').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || !btn.dataset.id) return;
  const { act, id } = btn.dataset;
  const card = btn.closest('.ocard');
  const code = card?.querySelector('.code')?.textContent;
  const amt = card?.querySelector('.amt')?.textContent;
  let note = '';

  if (act === 'verify' && !confirm(`Confirm you received ${amt} for ${code}?\nCheck the amount and UTR in your bank SMS first.`)) return;
  if (['reject', 'payment_missing', 'cancel'].includes(act)) {
    const n = prompt(act === 'payment_missing' ? 'Message to customer (optional):' : `Reason for ${act === 'reject' ? 'rejecting' : 'cancelling'} ${code} (optional):`, '');
    if (n === null) return;
    note = n;
  }
  if (act === 'delete' && !confirm(`Permanently delete ${code} and its files?`)) return;

  btn.disabled = true;
  try {
    if (act === 'delete') {
      await A('/orders/' + encodeURIComponent(id), { method: 'DELETE' });
    } else if (act === 'deliver') {
      const input = $(`#dl-${CSS.escape(id)}`);
      if (!input.files.length) { toast('Choose the design files first', 'bad'); btn.disabled = false; return; }
      const fd = new FormData();
      [...input.files].forEach((f) => fd.append('files', f, f.name));
      await upload(`/api/admin/orders/${encodeURIComponent(id)}/deliver`, fd, (p) => { btn.textContent = `Uploading ${p}%`; });
      toast('Files uploaded. Press "Mark delivered" when everything is ready.', 'ok');
    } else {
      await A(`/orders/${encodeURIComponent(id)}/action`, { method: 'POST', body: { action: act, note } });
      toast(act === 'verify' ? '✓ Verified — processing started' : 'Done', 'ok');
    }
    await refreshSummary();
    renderTab(true);
  } catch (err) {
    handleErr(err);
    btn.disabled = false;
  }
});

// ---------- offers editor rows ----------
const THEMES = ['violet', 'coral', 'green', 'gold', 'blue'];
const rowActions = (item) => `<div class="row-acts"><label class="switch"><input type="checkbox" name="active" ${item.active !== 0 ? 'checked' : ''}> Show to customers</label><span class="sp"></span>
  ${item.id ? '<button class="btn btn-sm btn-bad" type="button" data-del>Delete</button>' : ''}<button class="btn btn-sm btn-primary" type="submit">Save</button></div>`;

const pkgRow = (p) => `<form class="edit-row" data-kind="packages" data-id="${p.id ?? 'new'}">
  <label>Name (English)<input name="name_en" value="${esc(p.name_en)}" required maxlength="60"></label>
  <label>Name (Hindi)<input name="name_hi" value="${esc(p.name_hi)}" maxlength="60"></label>
  <label>Description (English)<input name="desc_en" value="${esc(p.desc_en)}" maxlength="200"></label>
  <label>Description (Hindi)<input name="desc_hi" value="${esc(p.desc_hi)}" maxlength="200"></label>
  <label>Price (₹)<input name="price" type="number" min="0" step="1" value="${(p.price ?? 0) / 100}"></label>
  <label>Order<input name="sort" type="number" min="0" value="${p.sort ?? 0}"></label>
  ${rowActions(p)}
</form>`;

const bannerRow = (b) => `<form class="edit-row" data-kind="banners" data-id="${b.id ?? 'new'}">
  <div class="full banner theme-${esc(b.theme || 'violet')}" style="min-height:0;padding:14px 16px"><h3 style="margin:0">${esc(b.title_en || 'New offer')}</h3><p>${esc(b.text_en || '')}</p></div>
  <label>Title (English)<input name="title_en" value="${esc(b.title_en)}" required maxlength="60"></label>
  <label>Title (Hindi)<input name="title_hi" value="${esc(b.title_hi)}" maxlength="60"></label>
  <label>Text (English)<input name="text_en" value="${esc(b.text_en)}" maxlength="140"></label>
  <label>Text (Hindi)<input name="text_hi" value="${esc(b.text_hi)}" maxlength="140"></label>
  <label>Colour<select name="theme">${THEMES.map((t) => `<option ${t === b.theme ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
  <label>Order<input name="sort" type="number" min="0" value="${b.sort ?? 0}"></label>
  ${rowActions(b)}
</form>`;

// Registered once (the #tab element persists across re-renders).
$('#tab').addEventListener('submit', async (e) => {
  const form = e.target.closest('.edit-row');
  if (!form) return;
  e.preventDefault();
  const body = Object.fromEntries(new FormData(form).entries());
  body.active = form.querySelector('[name=active]').checked;
  const { kind, id } = form.dataset;
  try {
    if (id === 'new') await A('/' + kind, { method: 'POST', body });
    else await A(`/${kind}/${id}`, { method: 'PUT', body });
    toast('Saved', 'ok');
    renderTab(true);
  } catch (err) { handleErr(err); }
});
$('#tab').addEventListener('click', async (e) => {
  if (!e.target.matches('[data-del]')) return;
  const form = e.target.closest('.edit-row');
  if (form.dataset.id === 'new') return form.remove();
  if (!confirm('Delete this item?')) return;
  try {
    await A(`/${form.dataset.kind}/${form.dataset.id}`, { method: 'DELETE' });
    renderTab(true);
  } catch (err) { handleErr(err); }
});

// ---------- views ----------
const VIEWS = {
  async pending() {
    const list = await A('/orders?view=pending');
    const submitted = list.filter((o) => o.status === 'payment_submitted');
    const waiting = list.filter((o) => o.status === 'awaiting_payment');
    return `<h1>Verify payments</h1>
      <p class="muted">Match the UTR and amount with the SMS from your bank, then press <b>Payment received</b>. Printing starts automatically.</p>
      ${!summary.upiReady ? '<div class="alert warn">⚠ <span>Add your UPI ID in <b>Settings</b> so customers can pay.</span></div>' : ''}
      <div class="orders">${submitted.map((o) => orderCard(o, 'pending')).join('') || empty('✅', 'No payments waiting for verification.')}</div>
      ${waiting.length ? `<h2 style="margin-top:28px;font-size:1.1rem">Not paid yet (${waiting.length})</h2>
        <p class="muted small">Customers who started but haven't entered a UTR. Unpaid orders expire after 24 hours.</p>
        <div class="orders">${waiting.map((o) => orderCard(o, 'pending')).join('')}</div>` : ''}`;
  },

  async queue() {
    const list = await A('/orders?view=queue');
    const p = summary.queuePaused;
    return `<h1>Print queue</h1>
      <div class="toolbar">
        <span class="muted grow">Printer: <b>${esc(summary.printerName)}</b> • Mode: <b>${esc(summary.worker.mode)}</b>${summary.worker.busy ? ` • Printing <b>${esc(summary.worker.current)}</b>` : ''}</span>
        <button class="btn btn-sm ${p ? 'btn-ok' : 'btn-ghost'}" type="button" id="pauseBtn">${p ? '▶ Resume printing' : '⏸ Pause printing'}</button>
      </div>
      ${p ? '<div class="alert warn">⏸ <span>Printing is paused. Verified orders wait in the queue until you resume.</span></div>' : ''}
      <div class="orders">${list.map((o) => orderCard(o, 'queue')).join('') || empty('🖨️', 'Queue is empty.')}</div>`;
  },

  async design() {
    const list = await A('/orders?view=design');
    return `<h1>Design orders</h1>
      <p class="muted">Paid design work. Upload the finished files, then press <b>Mark delivered</b> — the customer downloads them from their order page.</p>
      <div class="orders">${list.map((o) => orderCard(o, 'design')).join('') || empty('🎨', 'No design work in progress.')}</div>`;
  },

  async history() {
    const list = await A('/orders?view=history&q=' + encodeURIComponent(historyQuery));
    return `<h1>All orders</h1>
      <div class="toolbar"><input type="search" id="histSearch" class="grow" placeholder="Search code, name, phone or UTR" value="${esc(historyQuery)}"></div>
      <div class="orders">${list.map((o) => orderCard(o, 'history')).join('') || empty('📋', 'No orders found.')}</div>`;
  },

  async offers() {
    const [pkgs, banners] = await Promise.all([A('/packages'), A('/banners')]);
    return `<h1>Offers & packages</h1>
      <h2 style="font-size:1.1rem;margin-top:8px">Offer banners</h2>
      <p class="muted small">Shown on the home page. Only the first few active banners are shown (limit in Settings).</p>
      <div id="bannerRows">${banners.map(bannerRow).join('')}</div>
      <button class="btn btn-ghost" type="button" id="addBanner" style="margin-top:12px">+ Add banner</button>
      <h2 style="font-size:1.1rem;margin-top:32px">Design packages</h2>
      <div id="pkgRows">${pkgs.map(pkgRow).join('')}</div>
      <button class="btn btn-ghost" type="button" id="addPkg" style="margin-top:12px">+ Add package</button>`;
  },

  async settings() {
    const [s, printers] = await Promise.all([A('/settings'), A('/printers')]);
    const sw = (name, label) => `<label class="switch"><input type="checkbox" name="${name}" ${s[name] ? 'checked' : ''}> ${label}</label>`;
    const names = printers.map((p) => p.name);
    const printerPapers = (printers.find((p) => p.name === s.printerName) || printers[0])?.paperSizes || [];
    if (s.printerName && !names.includes(s.printerName)) names.unshift(s.printerName);
    return `<h1>Settings</h1>
      <form id="settingsForm">
      <div class="settings-grid">
        <div class="card"><h2>Payments (UPI)</h2>
          <div class="field"><label>Shop name</label><input name="shopName" value="${esc(s.shopName)}" maxlength="60" required></div>
          <div class="field"><label>Your UPI ID</label><input name="upiId" value="${esc(s.upiId)}" placeholder="yourname@okhdfcbank" autocapitalize="none"><span class="hint">Customers' QR codes pay this ID with the exact order amount.</span></div>
          <div class="field"><label>Name shown in UPI app</label><input name="payeeName" value="${esc(s.payeeName)}" maxlength="60"></div>
        </div>
        <div class="card"><h2>Print prices</h2>
          <div class="row2">
            <div class="field"><label>B/W per page (₹)</label><input name="priceBw" type="number" min="0" step="0.5" value="${s.priceBw}"></div>
            <div class="field"><label>Colour per page (₹)</label><input name="priceColor" type="number" min="0" step="0.5" value="${s.priceColor}"></div>
          </div>
          <p class="muted small">Two-sided printing is charged per printed side.</p>
          <h2 style="margin-top:12px">Availability</h2>
          <div style="display:flex;flex-direction:column;gap:12px">${sw('acceptingPrint', 'Accept print orders')}${sw('acceptingDesign', 'Accept design orders')}</div>
        </div>
        <div class="card"><h2>Home page</h2>
          <div class="field"><label>Notice (English)</label><input name="noticeEn" value="${esc(s.noticeEn)}" maxlength="200"></div>
          <div class="field"><label>Notice (Hindi)</label><input name="noticeHi" value="${esc(s.noticeHi)}" maxlength="200"></div>
          <div class="row2">
            <div class="field"><label>Max offer banners</label><input name="maxBanners" type="number" min="0" max="10" value="${s.maxBanners}"></div>
            <div class="field"><label>Default language</label><select name="defaultLang"><option value="hi" ${s.defaultLang === 'hi' ? 'selected' : ''}>हिंदी</option><option value="en" ${s.defaultLang === 'en' ? 'selected' : ''}>English</option></select></div>
          </div>
        </div>
        <div class="card"><h2>Printer</h2>
          <div class="field"><label>Printer</label><select name="printerName"><option value="">Windows default printer</option>${names.map((n) => `<option ${n === s.printerName ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
          <p class="muted small">Mode: <b>${esc(s.printMode)}</b>${s.printMode === 'simulate' ? ' — nothing is really printed. Set PRINT_MODE=auto in .env.' : ''}<br>Files are deleted ${s.retentionHours} hours after an order finishes.</p>
          <button class="btn btn-ghost" type="button" id="testPrint">🖨️ Print test page</button>
        </div>
        <div class="card" style="grid-column:1/-1"><h2>What customers can choose</h2>
          <p class="muted small">Sent to the printer driver: page range, copies, colour/B&W, paper size, orientation, fit/actual size, two-sided. Print quality and paper type use the defaults you set in the Windows printer preferences.</p>
          <div class="field"><label>Paper sizes you stock</label>
            <div class="chips" id="paperChips">${s.allPapers.map((p) => `<label class="chip"><input type="checkbox" name="paperSizes" value="${p}" ${s.paperSizes.includes(p) ? 'checked' : ''}><span>${p}</span></label>`).join('')}</div>
            ${printerPapers.length ? `<span class="hint">Your printer reports: ${esc(printerPapers.slice(0, 12).join(', '))}</span>` : ''}
          </div>
          <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:14px">
            ${sw('autoDuplex', 'Printer has automatic two-sided printing (duplex unit)')}
            <span class="muted small" style="margin-top:-6px">Off for Brother DCP-T430W: customers get "Both sides (you flip)" — fronts print, they turn the stack over and tap Continue, then backs print.</span>
            ${sw('flipReverse', 'Print back pages in reverse order (turn on if backs come out mismatched in your test)')}
          </div>
          <div class="row2">
            <div class="field"><label>Flip instructions (English)</label><textarea name="flipTextEn" maxlength="400" style="min-height:90px">${esc(s.flipTextEn)}</textarea></div>
            <div class="field"><label>Flip instructions (Hindi)</label><textarea name="flipTextHi" maxlength="400" style="min-height:90px">${esc(s.flipTextHi)}</textarea></div>
          </div>
          <p class="muted small">Test once with a 4-page PDF using "Both sides (you flip)" and adjust the instructions to match how your printer feeds paper.</p>
        </div>
      </div>
      <div style="margin-top:18px"><button class="btn btn-primary btn-lg" type="submit">Save settings</button></div>
      </form>`;
  },

  async qr() {
    const { url, qr } = await A('/shop-qr');
    const local = /localhost|127\.0\.0\.1|192\.168\.|10\.\d/.test(url);
    return `<h1>Shop QR poster</h1>
      ${local ? '<div class="alert warn">⚠ <span>This QR points to a local address and will only work on your shop Wi-Fi. Set <b>PUBLIC_URL</b> in .env to your tunnel address so customers can use mobile data (see README).</span></div>' : ''}
      <div class="card poster">
        <p class="p-title">Scan to Print & Design</p>
        <p class="p-sub">प्रिंट और डिज़ाइन के लिए स्कैन करें</p>
        <img src="${qr}" alt="Shop QR code">
        <div class="p-steps"><span>① Details / जानकारी</span><span>② Upload / अपलोड</span><span>③ UPI Pay / भुगतान</span><span>④ Collect / प्रिंट लें</span></div>
        <p class="muted small" style="margin-top:14px">${esc(url)}</p>
        <button class="btn btn-primary no-print" type="button" id="printPoster">🖨️ Print poster</button>
      </div>`;
  },

  async activity() {
    const rows = await A('/audit');
    return `<h1>Security log</h1>
      <p class="muted">Logins, failed login attempts and every action on orders. Kept for 180 days.</p>
      <div class="table-wrap"><table class="table"><thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td style="white-space:nowrap">${when(r.at)}</td><td>${esc(r.actor)}</td><td>${r.action === 'login_failed' ? '<b style="color:var(--bad)">login failed</b>' : esc(r.action.replace(/_/g, ' '))}</td><td>${esc(r.detail || '')}</td></tr>`).join('')}
      </tbody></table></div>`;
  },
};

// ---------- view wiring ----------
const AFTER = {
  queue() {
    $('#pauseBtn').addEventListener('click', async () => {
      try {
        await A('/queue', { method: 'POST', body: { paused: !summary.queuePaused } });
        await refreshSummary();
        renderTab(true);
      } catch (e) { handleErr(e); }
    });
  },
  history() {
    let t;
    const input = $('#histSearch');
    input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        historyQuery = input.value.trim();
        await renderTab(true);
        const again = $('#histSearch');
        again.focus();
        again.setSelectionRange(again.value.length, again.value.length);
      }, 350);
    });
  },
  offers() {
    $('#addPkg').addEventListener('click', () => $('#pkgRows').insertAdjacentHTML('beforeend', pkgRow({ name_en: '', name_hi: '', desc_en: '', desc_hi: '', price: 0, sort: 0 })));
    $('#addBanner').addEventListener('click', () => $('#bannerRows').insertAdjacentHTML('beforeend', bannerRow({ title_en: '', title_hi: '', text_en: '', text_hi: '', theme: 'violet', sort: 0 })));
  },
  settings() {
    $('#settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = Object.fromEntries(new FormData(f).entries());
      body.acceptingPrint = f.acceptingPrint.checked;
      body.acceptingDesign = f.acceptingDesign.checked;
      body.autoDuplex = f.autoDuplex.checked;
      body.flipReverse = f.flipReverse.checked;
      body.paperSizes = [...f.querySelectorAll('[name=paperSizes]:checked')].map((x) => x.value);
      try {
        await A('/settings', { method: 'PUT', body });
        toast('Settings saved', 'ok');
        await refreshSummary();
      } catch (err) { handleErr(err); }
    });
    $('#testPrint').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await A('/test-print', { method: 'POST', body: {} });
        toast('Test page sent to printer', 'ok');
      } catch (err) { handleErr(err); } finally { e.target.disabled = false; }
    });
  },
  qr() {
    $('#printPoster').addEventListener('click', () => window.print());
  },
};

// ---------- boot ----------
A('/me').then(showApp).catch((e) => (e instanceof ApiError && e.status === 401 ? showLogin() : handleErr(e)));
