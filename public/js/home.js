import { initPage, $, esc, rupees, myOrders } from './common.js';
import { t, pick, getLang } from './i18n.js';

const cfg = await initPage();

function render() {
  if (!cfg) return;
  const notice = cfg.notice[getLang()] || cfg.notice.en;
  $('#notice').classList.toggle('hidden', !notice);
  $('#noticeText').textContent = notice;

  $('#priceBw').textContent = rupees(cfg.prices.bw);
  $('#priceColor').textContent = rupees(cfg.prices.color);
  $('#privacyNote').textContent = t('privacy_note', { h: cfg.retentionHours });

  for (const [id, open] of [['#cardPrint', cfg.accepting.print], ['#cardDesign', cfg.accepting.design]]) {
    const card = $(id);
    card.classList.toggle('disabled', !open);
    card.querySelector('.closed-tag').classList.toggle('hidden', open);
  }

  $('#offersSection').classList.toggle('hidden', !cfg.banners.length);
  $('#banners').innerHTML = cfg.banners.map((b) => `
    <div class="banner theme-${esc(b.theme)}">
      <h3>${esc(pick(b, 'title'))}</h3>
      <p>${esc(pick(b, 'text'))}</p>
    </div>`).join('');

  $('#pkgSection').classList.toggle('hidden', !cfg.packages.length || !cfg.accepting.design);
  $('#packages').innerHTML = cfg.packages.map((p) => `
    <a class="pkg" href="/design?pkg=${p.id}">
      <span class="name">${esc(pick(p, 'name'))}</span>
      <span class="price">${rupees(p.price)}</span>
      <span class="desc">${esc(pick(p, 'desc'))}</span>
    </a>`).join('');

  const recent = myOrders.list();
  $('#recentSection').classList.toggle('hidden', !recent.length);
  $('#recent').innerHTML = recent.slice(0, 4).map((o) => `
    <a href="/order?id=${encodeURIComponent(o.id)}">
      <span>${t('order')} ${esc(o.code)}</span>
      <span class="muted small">${new Date(o.at).toLocaleDateString()}</span>
    </a>`).join('');
}

render();
window.addEventListener('langchange', render);
