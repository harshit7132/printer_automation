import { t, apply, setLang, getLang, hasSavedLang } from './i18n.js';
import {
  initAuth, authReady, getToken, currentUser, onUserChange, setAuthLang, signInGoogle, signInEmail, registerEmail,
  signInGuest, resetPassword, authErrorKey, isCancel,
} from './auth.js';

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function rupees(paise) {
  const n = (Number(paise) || 0) / 100;
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

export function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || 'Request failed');
    this.status = status;
    this.code = body?.error?.code || 'server_error';
    this.data = body?.error || {};
  }
}

/** Translate an API error to the current language when we know the code. */
export function errorText(e) {
  if (!(e instanceof ApiError)) return t('e_net');
  const key = 'e_' + e.code;
  const tr = t(key, e.data);
  return tr === key ? e.message : tr;
}

async function authHeader() {
  const token = await getToken().catch(() => null);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'emitra-admin',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(path.startsWith('/api/admin') ? {} : await authHeader()),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: { code: 'net', message: 'Network error' } });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/** multipart upload with progress (fetch can't report upload progress) */
export async function upload(path, formData, onProgress) {
  const auth = path.startsWith('/api/admin') ? {} : await authHeader();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.setRequestHeader('X-Requested-With', 'emitra-admin');
    if (auth.Authorization) xhr.setRequestHeader('Authorization', auth.Authorization);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data));
    };
    xhr.onerror = () => reject(new ApiError(0, { error: { code: 'net' } }));
    xhr.send(formData);
  });
}

let toastWrap;
export function toast(msg, type = '') {
  if (!toastWrap) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'toast-wrap';
    toastWrap.setAttribute('role', 'status');
    document.body.append(toastWrap);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  toastWrap.append(el);
  setTimeout(() => el.remove(), type === 'bad' ? 5000 : 2800);
}

export const myOrders = {
  list() {
    try { return JSON.parse(localStorage.getItem('myOrders') || '[]'); } catch { return []; }
  },
  add(o) {
    try {
      const list = this.list().filter((x) => x.id !== o.id);
      list.unshift({ id: o.id, code: o.code, type: o.type, at: Date.now() });
      localStorage.setItem('myOrders', JSON.stringify(list.slice(0, 8)));
    } catch { /* ignore */ }
  },
};

export function validPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d);
}

export function setFieldError(input, bad) {
  input.closest('.field')?.classList.toggle('invalid', bad);
  if (bad) input.focus();
  return bad;
}

let configPromise;
export function loadConfig() {
  configPromise ??= api('/api/config');
  return configPromise;
}

/** Shared page setup: shop name, language toggle, translations, customer sign-in. */
export async function initPage() {
  apply();
  const btn = $('#langToggle');
  btn?.addEventListener('click', () => {
    setLang(getLang() === 'hi' ? 'en' : 'hi');
    setAuthLang(getLang());
  });
  let cfg = null;
  try {
    cfg = await loadConfig();
    if (!hasSavedLang() && cfg.defaultLang) setLang(cfg.defaultLang, false);
    $$('[data-shop-name]').forEach((el) => { el.textContent = cfg.shopName; });
    document.title = document.title.replace('e-Mitra', cfg.shopName);
  } catch {
    toast(t('e_net'), 'bad');
  }
  apply();
  if (cfg?.accounts) {
    // Don't block the page on the sign-in SDK; the account button appears when it's ready.
    initAuth(cfg.accounts, getLang()).then((auth) => {
      if (!auth) return;
      renderAccountBtn();
      onUserChange(() => {
        mePromise = null;
        renderAccountBtn();
        window.dispatchEvent(new Event('userchange'));
      });
    });
    window.addEventListener('langchange', renderAccountBtn);
  }
  return cfg;
}

// ---------- customer account ----------
let mePromise = null;
/** { user, profile } for the signed-in customer, or { user: null }. */
export async function loadMe() {
  await authReady();
  if (!currentUser()) return { user: null };
  mePromise ??= api('/api/me').catch(() => ({ user: null }));
  return mePromise;
}
export const accountsOn = async () => !!(await authReady());

export async function saveMe(patch) {
  mePromise = null;
  return api('/api/me', { method: 'PUT', body: patch });
}

function renderAccountBtn() {
  const btn = $('#accountBtn');
  if (!btn) return;
  const u = currentUser();
  btn.classList.remove('hidden');
  if (!u) {
    btn.innerHTML = `${ICONS.user}<span>${esc(t('signin_btn'))}</span>`;
    btn.onclick = () => openSignIn();
    return;
  }
  const label = u.isAnonymous ? t('guest') : (u.displayName || u.email || t('account')).split(/[\s@]/)[0];
  btn.innerHTML = `<span class="avatar">${esc(label.slice(0, 1).toUpperCase())}</span><span>${esc(label)}</span>`;
  btn.onclick = () => { location.href = '/account'; };
}

const GOOGLE_G = '<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

/**
 * Sign-in sheet: Google, email/password (sign in / create account / reset), or guest.
 * Resolves true when the customer is signed in, false if they closed it.
 */
export function openSignIn({ reason = '' } = {}) {
  return new Promise((resolve) => {
    const isGuest = currentUser()?.isAnonymous;
    let mode = 'signin';
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="siTitle">
        <button class="icon-btn modal-x" type="button" data-close aria-label="Close">${ICONS.x}</button>
        <h2 id="siTitle">${esc(isGuest ? t('si_upgrade_title') : t('si_title'))}</h2>
        <p class="muted">${esc(reason || t('si_why'))}</p>
        <button class="btn btn-ghost btn-block google-btn" type="button" data-google>${GOOGLE_G}<span>${esc(t('si_google'))}</span></button>
        <div class="divider">${esc(t('or'))}</div>
        <form data-email novalidate>
          <div class="field"><label for="siEmail">${esc(t('si_email'))}</label><input id="siEmail" type="email" autocomplete="email" required></div>
          <div class="field"><label for="siPass">${esc(t('si_password'))}</label><input id="siPass" type="password" autocomplete="current-password" minlength="6" required></div>
          <button class="btn btn-primary btn-block" type="submit" data-submit>${esc(t('si_signin'))}</button>
          <div class="si-links">
            <button class="link-btn" type="button" data-mode>${esc(t('si_new'))}</button>
            <button class="link-btn" type="button" data-reset>${esc(t('si_forgot'))}</button>
          </div>
        </form>
        ${isGuest ? '' : `<div class="divider">${esc(t('or'))}</div>
        <button class="btn btn-ghost btn-block" type="button" data-guest>${ICONS.user}<span>${esc(t('si_guest'))}</span></button>
        <p class="muted small center">${esc(t('si_guest_note'))}</p>`}
      </div>`;
    document.body.append(wrap);
    document.body.classList.add('no-scroll');
    const $m = (s) => wrap.querySelector(s);
    const busy = (on) => wrap.querySelectorAll('button').forEach((b) => { b.disabled = on; });

    const close = (ok) => {
      wrap.remove();
      document.body.classList.remove('no-scroll');
      document.removeEventListener('keydown', onKey);
      resolve(ok);
    };
    const onKey = (e) => e.key === 'Escape' && close(false);
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(false); });

    const run = async (fn) => {
      busy(true);
      try {
        await fn();
        mePromise = null;
        toast(t('si_done'), 'ok');
        close(true);
        // Upgrading a guest keeps the same Firebase user, so no auth-state event fires: refresh ourselves.
        renderAccountBtn();
        window.dispatchEvent(new Event('userchange'));
      } catch (e) {
        if (!isCancel(e)) toast(t(authErrorKey(e)), 'bad');
        busy(false);
      }
    };

    $m('[data-google]').addEventListener('click', () => run(signInGoogle));
    $m('[data-guest]')?.addEventListener('click', () => run(signInGuest));
    $m('[data-mode]').addEventListener('click', () => {
      mode = mode === 'signin' ? 'register' : 'signin';
      $m('[data-submit]').textContent = t(mode === 'signin' ? 'si_signin' : 'si_create');
      $m('[data-mode]').textContent = t(mode === 'signin' ? 'si_new' : 'si_have');
      $m('#siPass').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
      $m('[data-reset]').classList.toggle('hidden', mode !== 'signin');
    });
    $m('[data-reset]').addEventListener('click', async () => {
      const email = $m('#siEmail').value.trim();
      if (!email) { toast(t('ae_email'), 'bad'); $m('#siEmail').focus(); return; }
      try {
        await resetPassword(email);
        toast(t('si_reset_sent'), 'ok');
      } catch (e) { toast(t(authErrorKey(e)), 'bad'); }
    });
    $m('[data-email]').addEventListener('submit', (e) => {
      e.preventDefault();
      const email = $m('#siEmail').value.trim();
      const pass = $m('#siPass').value;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast(t('ae_email'), 'bad'); return; }
      if (pass.length < 6) { toast(t('ae_weak'), 'bad'); return; }
      run(() => (mode === 'signin' ? signInEmail(email, pass) : registerEmail(email, pass)));
    });
    setTimeout(() => $m('[data-google]').focus(), 50);
  });
}

/**
 * The "save your details" card above a details form.
 * fields: { name, phone, email? } input elements. Returns { shouldSave() }.
 */
export async function mountSavePrompt(el, fields) {
  if (!el || !(await accountsOn())) return { shouldSave: () => false };
  let saveBox = null;
  const fill = async () => {
    const me = await loadMe();
    const p = me.profile || {};
    for (const [k, input] of Object.entries(fields)) if (input && !input.value && p[k]) input.value = p[k];
    return me;
  };
  const render = async () => {
    const me = await fill();
    const u = currentUser();
    if (!u) {
      el.innerHTML = `<div class="save-card">
        <div class="save-ico">${ICONS.save}</div>
        <div class="grow"><b>${esc(t('sp_title'))}</b><span>${esc(t('sp_sub'))}</span></div>
        <button class="btn btn-sm btn-primary" type="button" data-si>${esc(t('signin_btn'))}</button></div>`;
      el.querySelector('[data-si]').addEventListener('click', () => openSignIn());
      saveBox = null;
      return;
    }
    const who = u.isAnonymous ? t('guest') : (me.profile?.email || u.email || t('account'));
    el.innerHTML = `<div class="save-card ok">
      <div class="save-ico">${ICONS.check}</div>
      <div class="grow"><b>${esc(t('sp_in', { who }))}</b>
        <label class="check"><input type="checkbox" checked data-save> ${esc(t('sp_save'))}</label>
        ${u.isAnonymous ? `<button class="link-btn" type="button" data-up>${esc(t('sp_guest_up'))}</button>` : ''}</div></div>`;
    saveBox = el.querySelector('[data-save]');
    el.querySelector('[data-up]')?.addEventListener('click', () => openSignIn());
  };
  await render();
  window.addEventListener('userchange', render);
  window.addEventListener('langchange', render);
  return { shouldSave: () => !!(currentUser() && saveBox?.checked) };
}

export const ICONS = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  printer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/></svg>',
  done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17v.5"/></svg>',
  palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.9 1.2-1.8-.5-1-.1-2.2 1.1-2.2H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7" r="1.2"/><circle cx="15.5" cy="7.5" r="1.2"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z"/><path d="m9 12 2 2 4-4"/></svg>',
  loader: '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>',
  user: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  save: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
};

export function fileIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const cls = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext) ? 'img' : ext === 'pdf' ? '' : 'other';
  return `<div class="ficon ${cls}">${esc(ext.slice(0, 4).toUpperCase() || 'FILE')}</div>`;
}
