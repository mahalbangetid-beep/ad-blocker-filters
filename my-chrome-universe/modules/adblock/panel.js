// Ad Blocker panel in the toolbar popup (formerly this module's own popup).
import { getModuleStates } from '../../core/modules.js';
import { loadStyles, addStyle, moduleSwitch, offNotice, messageLine } from '../../core/panel.js';

const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });
const number = new Intl.NumberFormat('id-ID');

const CSS = `
  .ab-panel { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
  .ab-panel .site { display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
  .ab-panel .site .text { flex: 1; min-width: 0; }
  .ab-panel .site .host { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ab-panel .site .state { font-size: 12px; color: var(--muted); }
  .ab-panel .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .ab-panel .stat { padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
  .ab-panel .stat strong { display: block; font-size: 22px; line-height: 1.2; font-variant-numeric: tabular-nums; }
  .ab-panel .stat span { font-size: 12px; color: var(--muted); }
  .ab-panel .notice { font-size: 12px; color: var(--muted); margin: 0; }
  .ab-panel .actions { display: flex; flex-direction: column; gap: 8px; }
`;

const MARKUP = `
  <div class="site" id="site-box">
    <div class="text">
      <div class="host" id="host"></div>
      <div class="state" id="state"></div>
    </div>
    <label class="switch" title="Blokir iklan di situs ini">
      <input type="checkbox" id="site-toggle" aria-label="Blokir iklan di situs ini"><span></span>
    </label>
  </div>
  <p class="notice" id="unsupported" hidden>Pemblokiran tidak berlaku di halaman ini.</p>

  <div class="stats">
    <div class="stat"><strong id="page-count">0</strong><span>diblokir di halaman ini</span></div>
    <div class="stat"><strong id="total-count">0</strong><span>diblokir sejak dipasang</span></div>
  </div>

  <div class="actions">
    <button class="btn" id="pick">Blokir elemen di halaman ini</button>
    <button class="btn" id="pause"></button>
  </div>
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

export async function render(root) {
  await loadStyles(new URL('./style.css', import.meta.url).href);
  addStyle('adblock', CSS);
  const enabled = (await getModuleStates()).adblock;

  const msg = messageLine();
  const { row } = moduleSwitch(enabled, async (on) => {
    const result = await send('core:setModule', { id: 'adblock', enabled: on });
    if (!root.isConnected) return; // panel closed meanwhile
    root.replaceChildren();
    await render(root);
    if (!result?.ok) root.querySelector('.mcu-msg').textContent = result?.error || 'Gagal menyimpan';
  });
  root.replaceChildren(row, msg);
  if (!enabled) return void root.append(offNotice());

  const main = document.createElement('div');
  main.className = 'ab-panel';
  main.innerHTML = MARKUP;
  root.append(main);

  const $ = (id) => main.querySelector(`#${id}`);
  const tab = await activeTab();

  async function update() {
    const state = await send('ab:getPopupState', { tabId: tab?.id });
    const supported = Boolean(state.host);

    $('site-box').hidden = !supported;
    $('unsupported').hidden = supported;
    const off = state.paused || state.disabled;
    $('pick').disabled = !supported || off || state.allowlisted;
    $('host').textContent = state.site || '';
    $('site-toggle').checked = !state.allowlisted && !off;
    $('site-toggle').disabled = off;
    $('state').textContent = state.disabled
      ? 'Ad Blocker nonaktif'
      : state.paused ? 'Pemblokiran dijeda di semua situs'
      : state.allowlisted ? 'Iklan diizinkan di situs ini' : 'Iklan diblokir di situs ini';

    $('page-count').textContent = number.format(state.pageBlocked);
    $('total-count').textContent = number.format(state.totalBlocked);
    $('pause').textContent = state.paused ? 'Lanjutkan pemblokiran' : 'Jeda di semua situs';
    $('pause').classList.toggle('primary', state.paused);
    return state;
  }

  let state = await update();

  $('site-toggle').addEventListener('change', async (e) => {
    await send('ab:setAllowlisted', { domain: state.site, allowlisted: !e.target.checked, tabId: tab.id });
    state = await update();
  });

  $('pause').addEventListener('click', async () => {
    await send('ab:setPaused', { paused: !state.paused, tabId: tab?.id });
    state = await update();
  });

  $('pick').addEventListener('click', async () => {
    await send('ab:startPicker', { tabId: tab.id });
    window.close();
  });

  // Keep the page counter live while the panel is open; stops once "←" removed it.
  const timer = setInterval(async () => {
    if (!main.isConnected) return clearInterval(timer);
    state = await update();
  }, 1000);
}
