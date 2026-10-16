// Toolbar popup: a hero for the active site and one card per module (from the registry);
// a card opens that module's panel, which slides in over the home view; "←" returns.
import { guardPage } from './core/page-guard.js';
import { MODULES, getModuleStates, onModuleStatesChanged } from './core/modules.js';
import { favTile } from './core/panel.js';
import { initAppearance } from './ui/appearance.js';
import { hydrateIcons, icon } from './ui/icons.js';
import { installEffects, countUp, toast } from './ui/motion.js';

await guardPage('popup');
await initAppearance();
hydrateIcons();
installEffects();

const $ = (id) => document.getElementById(id);
const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });
const loadPanel = (module) => import(`./${module.panel}`);
const NF = new Intl.NumberFormat('id-ID');
const HOME_TITLE = 'My Chrome Universe';

// What the popup itself puts in <head> and on <html>; closing a panel restores exactly this,
// so a module's stylesheet never leaks into the home view. The appearance attributes are
// kept live by initAppearance (theme changed in Settings while open) and are left alone.
const LIVE_ATTRS = new Set(['data-ui', 'data-motion', 'data-accent']);
const baseHead = new Set(document.head.children);
const baseAttrs = [...document.documentElement.attributes].filter((a) => !LIVE_ATTRS.has(a.name)).map((a) => [a.name, a.value]);

function restoreBase() {
  for (const node of [...document.head.children]) if (!baseHead.has(node)) node.remove();
  const html = document.documentElement;
  for (const name of html.getAttributeNames()) if (!LIVE_ATTRS.has(name)) html.removeAttribute(name);
  for (const [name, value] of baseAttrs) html.setAttribute(name, value);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------- Module cards ----------

const cards = new Map(); // id -> { card, open, status, input, seq }

for (const module of MODULES) {
  const card = el('div', 'mcu-card tilt');
  card.dataset.id = module.id;
  const open = el('button', 'mcu-card-open rp');
  open.type = 'button';
  const ic = el('span', 'mcu-card-ic');
  ic.append(icon(module.icon));
  const text = el('span', 'mcu-card-text');
  const status = el('span', 'mcu-card-status');
  text.append(el('b', 'mcu-card-name', module.name), status);
  open.append(ic, text, icon('chevronRight', 'mcu-card-go'));
  open.addEventListener('click', () => openPanel(module));

  const sw = el('label', 'sw');
  sw.title = `${module.name} aktif`;
  const input = Object.assign(el('input'), { type: 'checkbox' });
  input.dataset.mod = module.id;
  input.setAttribute('aria-label', `${module.name} aktif`);
  const track = el('span', 'track');
  track.append(el('span', 'knob'));
  sw.append(input, track);
  input.addEventListener('change', () => onSwitch(module, input));

  card.append(open, sw);
  cards.set(module.id, { card, open, status, input, seq: 0 });
}
$('mcu-cards').append(...[...cards.values()].map((c) => c.card));

function refreshStatus(module) {
  const entry = cards.get(module.id);
  const seq = ++entry.seq; // a slower, older answer never overwrites a newer one
  loadPanel(module)
    .then((panel) => panel.status())
    .then((text) => { if (seq === entry.seq) entry.status.textContent = text; })
    .catch(() => { if (seq === entry.seq) entry.status.textContent = ''; });
}

const errorText = (result) => (result?.error === 'locked' ? 'Browser sedang terkunci.' : result?.error || 'Gagal menyimpan');

async function onSwitch(module, input) {
  const on = input.checked;
  if (module.id === 'lock') {
    // Turning the lock off needs the current password: open its panel with the form.
    if (!on) {
      input.checked = true; // stays on until the password is confirmed
      openPanel(module, { disable: true });
      return;
    }
    const result = await send('lock:setEnabled', { enabled: true });
    if (result?.ok) toast('Browser Lock diaktifkan', { icon: 'lock' });
    else toast(errorText(result), { icon: 'info' });
  } else {
    const result = await send('core:setModule', { id: module.id, enabled: on });
    if (result?.ok) toast(`${module.name} ${on ? 'diaktifkan' : 'dimatikan'}`, { icon: on ? 'check' : 'pause' });
    else toast(errorText(result), { icon: 'info' });
  }
  syncHome(await getModuleStates());
}

// Cards, footer, header status and hero follow the stored states (changed here, in Settings, ...).
let states = {};
function syncHome(next) {
  states = next;
  for (const module of MODULES) {
    const { card, input } = cards.get(module.id);
    input.checked = next[module.id] !== false;
    card.classList.toggle('off', next[module.id] === false);
    refreshStatus(module);
  }
  $('mcu-open-tabs').hidden = next.tabs === false;
  $('mcu-lock-now').hidden = next.lock === false;
  refreshHeadStatus();
  refreshHero();
}
onModuleStatesChanged(syncHome);

async function refreshHeadStatus() {
  const state = await send('lock:getState').catch(() => null);
  const line = $('mcu-status');
  const live = el('i', 'live');
  if (!state?.enabled) {
    live.classList.add('off');
    line.replaceChildren(live, 'Browser Lock nonaktif');
    return;
  }
  const idle = state.settings?.idleMinutes || 0;
  line.replaceChildren(live, `Terbuka · kunci otomatis ${idle ? `${idle} menit` : 'mati'}`);
}

// ---------- Hero: the first module whose panel offers one (Ad Blocker: site + blocked count) ----------

let heroKey = null;
let heroSeq = 0;
async function refreshHero() {
  const seq = ++heroSeq;
  let hero = null;
  for (const module of MODULES) {
    try {
      const panel = await loadPanel(module);
      hero = (await panel.hero?.()) || null;
    } catch {
      hero = null;
    }
    if (hero) break;
  }
  if (seq !== heroSeq) return;
  const box = $('mcu-hero');
  if (!hero) {
    box.hidden = true;
    heroKey = null;
    return;
  }
  const key = `${hero.title}|${hero.favUrl || ''}`;
  if (key !== heroKey) {
    heroKey = key;
    const text = el('div', 'grow');
    text.append(el('b', '', hero.title), el('span', '', hero.subtitle));
    const n = el('span', 'mcu-hero-n', '0');
    box.replaceChildren(favTile(hero.favUrl, hero.title), text, n);
    box.hidden = false;
    countUp(n, hero.value, 1000);
    n.dataset.value = String(hero.value);
  } else {
    box.querySelector('.grow span').textContent = hero.subtitle;
    const n = box.querySelector('.mcu-hero-n');
    if (n.dataset.value !== String(hero.value)) {
      n.dataset.value = String(hero.value);
      n.textContent = NF.format(hero.value);
    }
  }
}

// Keep the page counter live while the home view is shown.
setInterval(() => { if (!current) refreshHero(); }, 1500);

// ---------- Views ----------

let current = null; // { module, root } of the open panel
let leaving = null; // root of a panel still sliding out

function setTitle(text) {
  const title = $('mcu-title');
  if (title.textContent === text) return;
  title.textContent = text;
  title.classList.remove('swap');
  void title.offsetWidth; // restart the swap animation
  title.classList.add('swap');
}

function showView(panel) {
  const home = $('mcu-home');
  const view = $('mcu-panel');
  home.classList.toggle('is-on', !panel);
  home.classList.toggle('is-left', panel);
  view.classList.toggle('is-on', panel);
  home.inert = panel;
  view.inert = !panel;
  $('mcu-head').classList.toggle('sub', panel);
  $('mcu-back').inert = !panel;
}

async function openPanel(module, opts = {}) {
  closePanel();
  if (leaving) {
    leaving.remove();
    leaving = null;
    restoreBase();
  }
  // A fresh root per opening: only one panel is ever in the DOM (module element ids may collide).
  const root = el('div', 'mcu-panel-root');
  root.dataset.module = module.id;
  const mine = { module, root };
  current = mine;
  $('mcu-panel').replaceChildren(root);
  $('mcu-panel').scrollTop = 0;
  $('mcu-panel').setAttribute('aria-label', module.name);
  setTitle(module.name);
  showView(true);
  $('mcu-back').focus({ preventScroll: true });
  try {
    await (await loadPanel(module)).render(root, opts);
  } catch (err) {
    console.error(err);
    if (current === mine) root.replaceChildren(el('p', 'mcu-off', 'Panel gagal dimuat.'));
  }
  // Closed while loading: drop whatever the late render added.
  if (!current) restoreBase();
}

function closePanel() {
  if (!current) return;
  current.root.remove();
  current = null;
  restoreBase();
}

function showHome() {
  if (!current) return;
  const { module, root } = current;
  current = null;
  leaving = root;
  setTitle(HOME_TITLE);
  showView(false);
  cards.get(module.id)?.open.focus({ preventScroll: true });
  syncHome(states);
  // Let the panel slide out before it (and its stylesheet) goes, unless another one opened.
  const leave = () => {
    if (leaving !== root) return;
    leaving = null;
    root.remove();
    restoreBase();
  };
  const view = $('mcu-panel');
  const done = (e) => {
    if (e && (e.target !== view || e.propertyName !== 'visibility')) return;
    view.removeEventListener('transitionend', done);
    leave();
  };
  view.addEventListener('transitionend', done);
  setTimeout(() => { view.removeEventListener('transitionend', done); leave(); }, 600);
}

$('mcu-back').addEventListener('click', showHome);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && current) {
    e.preventDefault();
    showHome();
  }
});

$('mcu-options').addEventListener('click', async () => {
  if (current) await chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${current.module.id}`) });
  else await chrome.runtime.openOptionsPage();
  window.close();
});

$('mcu-open-tabs').addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('modules/tabs/newtab.html') });
  window.close();
});

$('mcu-lock-now').addEventListener('click', async () => {
  await send('lock:lock').catch(() => {});
  window.close();
});

syncHome(await getModuleStates());
// Two frames so the closed state is painted before the reveal starts.
requestAnimationFrame(() => requestAnimationFrame(() => $('mcu-pop').classList.add('open')));
