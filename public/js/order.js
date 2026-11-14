import { initPage, $, esc, rupees, fmtSize, api, toast, errorText, myOrders, ICONS, fileIcon, ApiError } from './common.js';
import { t, getLang } from './i18n.js';

const sideLabel = (s) => ({ long: t('sides_long'), short: t('sides_short'), manual: t('sides_manual') }[s] || '');
function optsLine(f) {
  const bits = [
    f.selPages === f.pages ? (f.pages === 1 ? t('page_1') : t('pages_n', { n: f.pages })) : `${t('o_pages')} ${f.range} (${f.selPages})`,
    f.color ? t('colour_short') : t('bw_short'),
    sideLabel(f.sides),
    f.paper,
    f.orientation !== 'auto' ? t('o_' + f.orientation) : '',
    f.scale !== 'fit' ? t('o_' + f.scale) : '',
    t('copies_n', { n: f.copies }),
  ];
  return bits.filter(Boolean).join(' • ');
}

await initPage();
let id = new URLSearchParams(location.search).get('id') || '';
if (!id) {
  const recent = myOrders.list()[0]?.id;
  if (recent) {
    id = recent;
    history.replaceState(null, '', '?id=' + encodeURIComponent(id));
  }
}
const root = $('#root');
let order = null;
let lastSig = '';
let timer = null;

const FINAL = ['printed', 'completed', 'rejected', 'cancelled', 'expired'];
const TONE = {
  draft: 'info', awaiting_payment: 'warn', payment_submitted: 'info live', queued: 'info live', printing: 'info live', flip_needed: 'warn live',
  printed: 'ok', failed: 'warn', in_progress: 'info live', completed: 'ok', rejected: 'bad', cancelled: 'bad', expired: 'bad',
};
// how many timeline steps are complete, and which one is current
const PROGRESS = {
  awaiting_payment: 0, payment_submitted: 1, queued: 2, printing: 2, flip_needed: 2, failed: 2, in_progress: 2, printed: 4, completed: 4,
};

function timeline(o) {
  if (!(o.status in PROGRESS)) return '';
  const labels = [t('tl_paid'), t('tl_verified'), o.type === 'print' ? t('tl_printing') : t('tl_designing'), t('tl_done')];
  const done = PROGRESS[o.status];
  return `<div class="timeline">${labels.map((l, i) => `
    <div class="t ${i < done ? 'done' : i === done ? 'now' : ''}">
      <span class="dot">${i < done ? ICONS.check : ''}</span><span>${esc(l)}</span>
    </div>`).join('')}</div>`;
}

function payCard(o) {
  const p = o.payment || {};
  if (p.unavailable) return `<div class="card"><div class="alert warn">${ICONS.alert}<span>${esc(t('pay_unavailable'))}</span></div></div>`;
  const rawLink = p.link || '';
  const query = rawLink.includes('?') ? rawLink.slice(rawLink.indexOf('?') + 1) : '';
  return `
  <div class="card pay-card">
    ${o.note ? `<div class="alert warn">${ICONS.alert}<span><b>${esc(t('owner_note'))}</b> ${esc(o.note)}</span></div>` : ''}
    <h2>${esc(t('pay_title'))}</h2>
    <div class="pay-amount">${rupees(o.amount)}</div>
    <div class="qr-wrap"><img src="${p.qr}" alt="UPI QR code" width="240" height="240"></div>
    <p class="muted small" style="margin:6px 0 4px">${esc(t('pay_scan'))}</p>
    <div class="upi-apps">
      <a class="app-chip" href="phonepe://pay?${esc(query)}">PhonePe</a>
      <a class="app-chip" href="gpay://upi/pay?${esc(query)}">Google Pay</a>
      <a class="app-chip" href="paytmmp://pay?${esc(query)}">Paytm</a>
      <a class="app-chip" href="${esc(p.link)}">BHIM</a>
    </div>
    <div class="upi-id"><code>${esc(p.upiId)}</code><button class="btn btn-sm btn-ghost" type="button" id="copyUpi">${esc(t('copy'))}</button></div>
    <a class="btn btn-ghost btn-block" href="${esc(p.link)}" id="upiLink">${esc(t('pay_open_app'))}</a>
    <div class="divider">↓</div>
    <form id="utrForm" novalidate>
      <div class="field" style="text-align:left">
        <label for="utr">${esc(t('utr_label'))}</label>
        <input id="utr" class="utr-input" type="text" inputmode="numeric" autocomplete="off" maxlength="30" placeholder="${esc(t('utr_ph'))}">
        <span class="hint">${esc(t('utr_help'))}</span>
        <span class="err">${esc(t('err_utr'))}</span>
      </div>
      <button class="btn btn-primary btn-lg btn-block" type="submit">${ICONS.check} ${esc(t('utr_submit'))}</button>
    </form>
    <div style="margin-top:14px;border-top:1px dashed var(--line);padding-top:14px">
      <button class="btn btn-ghost btn-block" type="button" id="payCashBtn">${esc(t('pay_cash_btn'))}</button>
    </div>
  </div>`;
}

function flipCard(o) {
  const text = (getLang() === 'hi' && o.flip?.hi) || o.flip?.en || '';
  return `
  <div class="card status-hero warn flip-card">
    <div class="big-icon">${ICONS.printer}</div>
    <h2>${esc(t('h_flip_needed'))}</h2>
    ${o.flip?.file ? `<p class="muted small">${esc(t('flip_file', { f: o.flip.file }))}</p>` : ''}
    <div class="flip-steps">${esc(text)}</div>
    <button class="btn btn-primary btn-lg btn-block" type="button" id="flipBtn">${ICONS.check} ${esc(t('flip_btn'))}</button>
  </div>`;
}

function statusCard(o) {
  const s = o.status;
  if (s === 'flip_needed') return flipCard(o);
  if (s === 'payment_submitted' && o.paymentMode === 'cash') {
    return `
    <div class="card status-hero warn">
      <div class="big-icon">💵</div>
      <h2>${esc(t('h_cash_waiting'))}</h2>
      <p class="muted">${esc(t('cash_waiting', { amount: rupees(o.amount) }))}</p>
    </div>`;
  }
  const icon = { printed: ICONS.done, completed: ICONS.done, printing: ICONS.printer, queued: ICONS.printer, failed: ICONS.alert,
    rejected: ICONS.x, cancelled: ICONS.x, expired: ICONS.clock, in_progress: ICONS.palette }[s] || ICONS.clock;
  const tone = ['printed', 'completed'].includes(s) ? 'ok' : ['rejected', 'cancelled', 'expired'].includes(s) ? 'bad' : s === 'failed' ? 'warn' : '';
  let desc = t('d_' + s, { h: o.retentionHours });
  if (s === 'payment_submitted' && o.type === 'design') desc = t('d_payment_submitted_design');
  if (desc === 'd_' + s) desc = '';
  return `
  <div class="card status-hero ${tone}">
    <div class="big-icon">${s === 'payment_submitted' ? ICONS.loader : icon}</div>
    <h2>${esc(t('h_' + s))}</h2>
    ${s === 'queued' ? `<div class="muted small">${esc(t('d_queued'))}</div><div class="queue-num">#${o.queuePosition}</div>` : `<p class="muted">${esc(desc)}</p>`}
    ${s === 'rejected' && o.note ? `<div class="alert bad">${ICONS.alert}<span><b>${esc(t('owner_note'))}</b> ${esc(o.note)}</span></div>` : ''}
  </div>`;
}

function filesCard(o) {
  if (o.type === 'print') {
    if (!o.files.length) return '';
    return `<div class="card"><h2>${esc(t('your_files'))}</h2><div class="file-list">${o.files.map((f) => `
      <div class="file-item">${fileIcon(f.name)}
        <div class="fmeta"><div class="fname">${esc(f.name)}</div>
          <div class="fsub">${esc(optsLine(f))}</div>
        </div></div>`).join('')}</div>
      <div class="summary-list" style="margin-top:14px"><div class="ln total"><span>${esc(t('total'))}</span><span>${rupees(o.amount)}</span></div></div></div>`;
  }
  const d = o.design || {};
  return `
    ${o.deliveries.length ? `<div class="card"><h2>${esc(t('downloads'))}</h2><div class="file-list">${o.deliveries.map((f) => `
      <div class="file-item">${fileIcon(f.name)}
        <div class="fmeta"><div class="fname">${esc(f.name)}</div><div class="fsub">${fmtSize(f.size)}</div></div>
        <a class="btn btn-primary btn-sm" href="/api/orders/${encodeURIComponent(o.id)}/download/${encodeURIComponent(f.id)}" download>${ICONS.download} ${esc(t('download'))}</a>
      </div>`).join('')}</div></div>` : ''}
    <div class="card"><h2>${esc(t('summary'))}</h2>
      <div class="summary-list">
        <div class="ln"><span>${esc(t('service'))}</span><span>${esc(d.service ? t('svc_' + d.service) : '—')}</span></div>
        <div class="ln"><span>${esc(t('package'))}</span><span>${esc((getLang() === 'hi' && d.packageNameHi) || d.packageName || '—')}</span></div>
        <div class="ln"><span>${esc(t('f_title'))}</span><span>${esc(d.title || '—')}</span></div>
        <div class="ln"><span>${esc(t('files_title'))}</span><span>${o.uploads.length}</span></div>
        <div class="ln total"><span>${esc(t('total'))}</span><span>${rupees(o.amount)}</span></div>
      </div>
    </div>`;
}

function render() {
  const o = order;
  if (o.status === 'draft') {
    location.replace('/print?resume=' + encodeURIComponent(o.id));
    return;
  }
  root.innerHTML = `
    <div class="order-head">
      <div>
        <div class="muted small">${esc(o.firstName ? t('hello', { name: o.firstName }) : t('order'))}</div>
        <div class="order-code">${esc(o.code)}</div>
      </div>
      <span class="pill ${TONE[o.status] || ''}">${esc(t('st_' + o.status))}</span>
    </div>
    ${timeline(o)}
    <div style="margin-top:16px">${o.status === 'awaiting_payment' ? payCard(o) : statusCard(o)}</div>
    ${filesCard(o)}
    <p class="footer-note">${ICONS.shield}<span>${esc(t('save_link'))}</span></p>
    <div class="btn-row" style="margin-top:12px">
      ${o.status === 'awaiting_payment' ? `<button class="btn btn-bad" type="button" id="cancelBtn">${esc(t('cancel_order'))}</button>` : ''}
      <a class="btn btn-ghost" href="/">${esc(t('new_order'))}</a>
    </div>`;
  bind();
}

function bind() {
  $('#copyUpi')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(order.payment.upiId);
      toast(t('copied'), 'ok');
    } catch { /* clipboard blocked */ }
  });
  $('#utrForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#utr');
    const utr = input.value.replace(/[\s-]/g, '');
    const bad = !/^[A-Za-z0-9]{6,30}$/.test(utr);
    input.closest('.field').classList.toggle('invalid', bad);
    if (bad) return input.focus();
    const btn = e.submitter || $('#utrForm button');
    btn.disabled = true;
    try {
      update(await api(`/api/orders/${encodeURIComponent(id)}/payment`, { method: 'POST', body: { utr } }));
    } catch (err) {
      toast(errorText(err), 'bad');
      btn.disabled = false;
      if (err.code === 'bad_state') load();
    }
  });
  $('#payCashBtn')?.addEventListener('click', async () => {
    if (!confirm(t('pay_cash_confirm', { amount: rupees(order.amount) }))) return;
    try {
      update(await api(`/api/orders/${encodeURIComponent(id)}/cash`, { method: 'POST', body: {} }));
      toast(t('cash_waiting', { amount: rupees(order.amount) }), 'ok');
    } catch (err) {
      toast(errorText(err), 'bad');
    }
  });
  $('#flipBtn')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      update(await api(`/api/orders/${encodeURIComponent(id)}/continue`, { method: 'POST', body: {} }));
    } catch (err) {
      toast(errorText(err), 'bad');
      load();
    }
  });
  $('#cancelBtn')?.addEventListener('click', async () => {
    if (!confirm(t('confirm_cancel'))) return;
    try {
      update(await api(`/api/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }));
    } catch (err) {
      toast(errorText(err), 'bad');
    }
  });
}

let es = null;
function setupEvents() {
  if (!('EventSource' in window) || !id) return;
  if (es) { es.close(); es = null; }
  try {
    es = new EventSource('/api/orders/' + encodeURIComponent(id) + '/events');
    es.addEventListener('order', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data?.id) update(data);
      } catch { /* ignore */ }
    });
    es.onerror = () => {
      /* EventSource auto-retries, timer fallback continues */
    };
  } catch {
    /* EventSource unavailable */
  }
}

function update(o) {
  const prev = order?.status;
  if (!order) myOrders.add(o);
  order = o;
  const sig = [o.status, o.queuePosition, o.note, o.deliveries.length].join('|');
  if (sig !== lastSig) {
    lastSig = sig;
    render();
    if (prev && prev !== o.status && ['printed', 'completed'].includes(o.status)) navigator.vibrate?.([120, 60, 120]);
  }
  if (FINAL.includes(order.status) && es) {
    es.close();
    es = null;
  }
  schedule();
}

function schedule() {
  clearTimeout(timer);
  if (FINAL.includes(order.status)) return;
  const wait = { payment_submitted: 5000, queued: 3000, printing: 3000, flip_needed: 4000, awaiting_payment: 10000 }[order.status] || 20000;
  timer = setTimeout(load, wait);
}

async function load() {
  try {
    update(await api('/api/orders/' + encodeURIComponent(id)));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return notFound();
    toast(errorText(err), 'bad');
    timer = setTimeout(load, 8000);
  }
}

window.addEventListener('langchange', () => order && render());
document.addEventListener('visibilitychange', () => { if (!document.hidden && order && !FINAL.includes(order.status)) load(); });

function notFound() {
  root.innerHTML = `<div class="card status-hero bad" style="margin-top:24px"><div class="big-icon">${ICONS.x}</div><h2>${esc(t('not_found'))}</h2><a class="btn btn-primary" href="/">${esc(t('new_order'))}</a></div>`;
}

if (id) {
  load();
  setupEvents();
} else {
  notFound();
}
