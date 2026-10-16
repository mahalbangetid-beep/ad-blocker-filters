// Ad Blocker panel in the toolbar popup: ring with this page's count, site switch, totals,
// block-element picker, pause, and a link to the filter lists.
import { getModuleStates } from '../../core/modules.js';
import { loadStyles, offNotice, favTile } from '../../core/panel.js';
import { hydrateIcons, ic } from '../../ui/icons.js';
import { countUp, toast } from '../../ui/motion.js';

const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });
const number = new Intl.NumberFormat('id-ID');
const RING = 327; // circumference of the ring (r = 52)

const MARKUP = `
  <div class="ab-hero" id="ab-hero" style="--i:0">
    <div class="ring-stat">
      <svg viewBox="0 0 120 120" aria-hidden="true"><circle class="bg" cx="60" cy="60" r="52"/><circle class="fg" id="ab-ring" cx="60" cy="60" r="52"/></svg>
      <div><b id="page-count">0</b><span>di halaman ini</span></div>
    </div>
    <div class="grow">
      <div class="site-row" id="site-box">
        <span id="site-fav"></span>
        <div class="grow2"><b id="host"></b><span id="state"></span></div>
        <label class="sw" title="Blokir iklan di situs ini"><input type="checkbox" id="site-toggle" aria-label="Blokir iklan di situs ini"><span class="track"><span class="knob"></span></span></label>
      </div>
      <p class="ab-unsupported" id="unsupported" hidden>Pemblokiran tidak berlaku di halaman ini.</p>
      <dl class="stats2">
        <div><dt>Total diblokir</dt><dd id="total-count">0</dd></div>
        <div><dt>Aturan aktif</dt><dd id="rule-count">0</dd></div>
      </dl>
    </div>
  </div>
  <button class="btn block rp" type="button" id="pick" style="--i:1"><i data-ic="crosshair"></i>Blokir elemen di halaman ini</button>
  <button class="btn ghost block rp" type="button" id="pause" style="--i:2"></button>
  <button class="btn ghost block sm rp" type="button" id="ab-settings" style="--i:3"><i data-ic="sliders"></i>Atur daftar filter</button>
`;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

export async function status() {
  if (!(await getModuleStates()).adblock) return 'nonaktif';
  const tab = await activeTab();
  const state = await send('ab:getPopupState', { tabId: tab?.id });
  if (state.paused) return 'dijeda';
  return state.host ? `aktif · ${number.format(state.pageBlocked)}` : 'aktif';
}

// Home hero: the active site and what was blocked on it; null when off or not a website.
export async function hero() {
  if (!(await getModuleStates()).adblock) return null;
  const tab = await activeTab();
  if (!tab) return null;
  const state = await send('ab:getPopupState', { tabId: tab.id });
  if (!state?.ok || !state.host) return null;
  const subtitle = state.paused ? 'Pemblokiran dijeda di semua situs'
    : state.allowlisted ? 'Iklan diizinkan di situs ini' : 'Iklan diblokir di halaman ini';
  return { title: state.site, subtitle, value: state.pageBlocked, favUrl: tab.url };
}

// Fill of the ring: grows with the count and saturates (there is no "total requests" to divide by).
const ringFill = (n) => n / (n + 12);

export async function render(root) {
  await loadStyles(new URL('./panel.css', import.meta.url).href);
  if (!(await getModuleStates()).adblock) return void root.replaceChildren(offNotice());

  const tab = await activeTab();
  const [first, options] = await Promise.all([
    send('ab:getPopupState', { tabId: tab?.id }),
    send('ab:getOptions').catch(() => null),
  ]);
  if (!root.isConnected) return;

  const template = document.createElement('template');
  template.innerHTML = MARKUP;
  hydrateIcons(template.content);
  root.replaceChildren(template.content);
  const $ = (id) => root.querySelector(`#${id}`);

  if (first.host) $('site-fav').replaceWith(favTile(tab.url, first.site));
  const enabledLists = new Set(options?.settings?.enabledLists || []);
  const rules = (options?.lists || []).filter((l) => enabledLists.has(l.id)).reduce((n, l) => n + (l.ruleCount || 0), 0);
  $('rule-count').textContent = number.format(rules);

  let shown = null; // last state drawn, to animate only what changed
  function draw(state) {
    const supported = Boolean(state.host);
    const off = state.paused || state.disabled;
    const blocking = supported && !off && !state.allowlisted;

    $('site-box').hidden = !supported;
    $('unsupported').hidden = supported;
    $('ab-hero').classList.toggle('ab-off-state', !blocking);
    $('pick').disabled = !supported || off || state.allowlisted;
    $('host').textContent = state.site || '';
    $('host').title = state.site || '';
    $('site-toggle').checked = !state.allowlisted && !off;
    $('site-toggle').disabled = off;
    $('state').textContent = state.disabled
      ? 'Ad Blocker nonaktif'
      : state.paused ? 'Dijeda di semua situs'
      : state.allowlisted ? 'Iklan diizinkan di situs ini' : 'Iklan diblokir di situs ini';

    if (!shown) {
      countUp($('page-count'), state.pageBlocked, 900);
      countUp($('total-count'), state.totalBlocked, 1300);
    } else {
      if (shown.pageBlocked !== state.pageBlocked) $('page-count').textContent = number.format(state.pageBlocked);
      if (shown.totalBlocked !== state.totalBlocked) $('total-count').textContent = number.format(state.totalBlocked);
    }
    const ring = $('ab-ring');
    const offset = String(RING * (1 - (blocking ? ringFill(state.pageBlocked) : 0)));
    if (!shown && !document.hidden) requestAnimationFrame(() => requestAnimationFrame(() => { ring.style.strokeDashoffset = offset; }));
    else ring.style.strokeDashoffset = offset;

    if (shown?.paused !== state.paused) {
      $('pause').innerHTML = `${ic(state.paused ? 'play' : 'pause')}<span>${state.paused ? 'Lanjutkan pemblokiran' : 'Jeda di semua situs'}</span>`;
      $('pause').classList.toggle('primary', state.paused);
      $('pause').classList.toggle('ghost', !state.paused);
    }
    shown = state;
    return state;
  }

  async function update() {
    const state = await send('ab:getPopupState', { tabId: tab?.id });
    return root.isConnected ? draw(state) : state;
  }

  let state = draw(first);

  $('site-toggle').addEventListener('change', async (e) => {
    const allow = !e.target.checked;
    await send('ab:setAllowlisted', { domain: state.site, allowlisted: allow, tabId: tab.id });
    state = await update();
    toast(allow ? `${state.site} ditambahkan ke situs yang diizinkan` : `Pemblokiran aktif lagi di ${state.site}`, { icon: allow ? 'info' : 'shield' });
  });

  $('pause').addEventListener('click', async () => {
    await send('ab:setPaused', { paused: !state.paused, tabId: tab?.id });
    state = await update();
    toast(state.paused ? 'Pemblokiran dijeda di semua situs' : 'Pemblokiran dilanjutkan', { icon: state.paused ? 'pause' : 'shield' });
  });

  $('pick').addEventListener('click', async () => {
    await send('ab:startPicker', { tabId: tab.id });
    window.close();
  });

  $('ab-settings').addEventListener('click', async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('options.html#adblock') });
    window.close();
  });

  // Keep the page counter live while the panel is open; stops once "←" removed it.
  const timer = setInterval(async () => {
    if (!root.isConnected) return clearInterval(timer);
    state = await update();
  }, 1000);
}
