import {
  initPage, $, esc, rupees, api, toast, errorText, validPhone, setFieldError, ICONS,
  accountsOn, loadMe, saveMe, openSignIn,
} from './common.js';
import { t } from './i18n.js';
import { currentUser, signOutUser, deleteFirebaseUser, authErrorKey } from './auth.js';

const cfg = await initPage();
const root = $('#root');
const caps = cfg?.caps || { papers: ['A4'], sides: ['single'], orientations: ['auto'], scales: ['fit'] };
const sideLabel = (s) => ({ single: t('sides_single'), long: t('sides_long'), short: t('sides_short'), manual: t('sides_manual') }[s]);

const select = (name, items, cur) => `<select name="${name}">${items.map(([v, l]) =>
  `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

async function render() {
  if (!(await accountsOn())) {
    root.innerHTML = `<div class="card" style="margin-top:24px"><p>${esc(t('acc_off'))}</p><a class="btn btn-ghost" href="/">${esc(t('back'))}</a></div>`;
    return;
  }
  const u = currentUser();
  if (!u) {
    root.innerHTML = `<div class="card status-hero" style="margin-top:24px">
      <div class="big-icon">${ICONS.user.replace('width="18" height="18"', 'width="42" height="42"')}</div>
      <h2>${esc(t('acc_title'))}</h2><p class="muted">${esc(t('acc_signin_needed'))}</p>
      <button class="btn btn-primary btn-lg" type="button" id="siBtn">${esc(t('signin_btn'))}</button></div>`;
    $('#siBtn').addEventListener('click', () => openSignIn());
    return;
  }

  const [me, orders] = await Promise.all([loadMe(), api('/api/me/orders').catch(() => [])]);
  const p = me.profile || { prefs: {} };
  const pr = p.prefs || {};
  const via = t('acc_via', { p: t('p_' + (me.user?.provider || 'password').replace('.com', '')) });

  root.innerHTML = `
    <div class="order-head">
      <div><div class="muted small">${esc(via)}</div><div class="order-code" style="font-size:1.6rem">${esc(t('acc_title'))}</div></div>
    </div>
    ${u.isAnonymous ? `<div class="save-card"><div class="save-ico">${ICONS.save}</div>
      <div class="grow"><b>${esc(t('si_upgrade_title'))}</b><span>${esc(t('si_guest_note'))}</span></div>
      <button class="btn btn-sm btn-primary" type="button" id="upBtn">${esc(t('si_create'))}</button></div>` : ''}

    <form class="card" id="profileForm" novalidate>
      <h2>${esc(t('acc_profile'))}</h2>
      <div class="field"><label for="pName">${esc(t('f_name'))}</label><input id="pName" type="text" maxlength="60" autocomplete="name" value="${esc(p.name)}"><span class="err">${esc(t('err_name'))}</span></div>
      <div class="field"><label for="pPhone">${esc(t('f_phone'))}</label><input id="pPhone" type="tel" inputmode="numeric" maxlength="14" autocomplete="tel" value="${esc(p.phone)}"><span class="err">${esc(t('err_phone'))}</span></div>
      <div class="field"><label for="pEmail">${esc(t('si_email'))}</label><input id="pEmail" type="email" maxlength="120" autocomplete="email" value="${esc(p.email)}"></div>
      <button class="btn btn-primary" type="submit">${esc(t('acc_save'))}</button>
    </form>

    <form class="card" id="prefsForm">
      <h2>${esc(t('acc_prefs'))}</h2>
      <p class="muted small">${esc(t('acc_prefs_sub'))}</p>
      <div class="row2">
        <div class="field"><label>${esc(t('color'))}</label>${select('color', [['bw', t('bw')], ['color', t('color')]], pr.color ? 'color' : 'bw')}</div>
        <div class="field"><label>${esc(t('sides_single'))} / ${esc(t('sides_long'))}</label>${select('sides', caps.sides.map((s) => [s, sideLabel(s)]), pr.sides || 'single')}</div>
        <div class="field"><label>${esc(t('o_paper'))}</label>${select('paper', caps.papers.map((x) => [x, x]), pr.paper || caps.papers[0])}</div>
        <div class="field"><label>${esc(t('o_orient'))}</label>${select('orientation', caps.orientations.map((o) => [o, t('o_' + o)]), pr.orientation || 'auto')}</div>
        <div class="field"><label>${esc(t('o_scale'))}</label>${select('scale', caps.scales.map((s) => [s, t('o_' + s)]), pr.scale || 'fit')}</div>
      </div>
      <button class="btn btn-primary" type="submit">${esc(t('acc_save'))}</button>
    </form>

    <div class="card">
      <h2>${esc(t('acc_orders'))}</h2>
      ${orders.length ? `<div class="recent">${orders.map((o) => `
        <a href="/order?id=${encodeURIComponent(o.id)}">
          <span>${esc(o.code)} <span class="muted small">· ${esc(t('st_' + o.status))}</span></span>
          <span class="muted small">${rupees(o.amount)} · ${new Date(o.createdAt).toLocaleDateString()}</span>
        </a>`).join('')}</div>` : `<p class="muted">${esc(t('acc_no_orders'))}</p>`}
    </div>

    <div class="btn-row" style="margin-top:18px">
      <button class="btn btn-ghost" type="button" id="outBtn">${esc(t('acc_signout'))}</button>
      <button class="btn btn-bad" type="button" id="delBtn">${esc(t('acc_delete'))}</button>
    </div>`;

  $('#upBtn')?.addEventListener('click', () => openSignIn());
  $('#profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = $('#pPhone');
    if ($('#pName').value.trim().length < 2 && setFieldError($('#pName'), true)) return;
    if (phone.value.trim() && setFieldError(phone, !validPhone(phone.value))) return;
    try {
      await saveMe({ name: $('#pName').value.trim(), phone: phone.value.trim(), email: $('#pEmail').value.trim() });
      toast(t('acc_saved'), 'ok');
    } catch (err) { toast(errorText(err), 'bad'); }
  });
  $('#prefsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await saveMe({ prefs: { color: f.color.value === 'color', sides: f.sides.value, paper: f.paper.value, orientation: f.orientation.value, scale: f.scale.value } });
      toast(t('acc_saved'), 'ok');
    } catch (err) { toast(errorText(err), 'bad'); }
  });
  $('#outBtn').addEventListener('click', async () => {
    await signOutUser();
    location.href = '/';
  });
  $('#delBtn').addEventListener('click', async () => {
    if (!confirm(t('acc_delete_confirm'))) return;
    try {
      await api('/api/me', { method: 'DELETE' });
      await deleteFirebaseUser().catch(async (e) => {
        if (e?.code === 'auth/requires-recent-login') await signOutUser(); // server data is gone; just sign out
        else throw e;
      });
      toast(t('acc_deleted'), 'ok');
      setTimeout(() => { location.href = '/'; }, 1200);
    } catch (err) {
      toast(err?.code ? t(authErrorKey(err)) : errorText(err), 'bad');
    }
  });
}

render();
window.addEventListener('userchange', render);
window.addEventListener('langchange', render);
