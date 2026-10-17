// Settings page: one scrolling page with a section per area (Umum, each module, Tentang).
// Order: lock gate → appearance → nav → every section renders → entrance; #<id> scrolls to a section.
import { guardPage } from './core/page-guard.js';
import { MODULES, getModuleStates, onModuleStatesChanged } from './core/modules.js';
import { h, moveThumb } from './core/settings-ui.js';
import { initAppearance } from './ui/appearance.js';
import { hydrateIcons, icon } from './ui/icons.js';
import { installEffects, toast, animate, motionLevel } from './ui/motion.js';
import { createSky } from './ui/sky.js';
import { general, about } from './settings-general.js';

await guardPage('tab');

const $ = (id) => document.getElementById(id);
const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });

await initAppearance();
hydrateIcons();
installEffects();
const sky = createSky($('sky'), { mode: 'calm', fxCanvas: $('fx') });

// Browser Lock first (it gates everything), then the other modules in registry order.
const MODULE_ORDER = ['lock', 'tabs', 'notes', 'adblock'];
const rank = (m) => (MODULE_ORDER.includes(m.id) ? MODULE_ORDER.indexOf(m.id) : MODULE_ORDER.length);
const SECTIONS = [
  { id: 'umum', name: 'Umum', icon: 'sliders', load: async () => general },
  ...[...MODULES].sort((a, b) => rank(a) - rank(b)).map((m) => ({
    id: m.id, name: m.name, icon: m.icon, load: () => import(`./${m.settings}`),
  })),
  { id: 'about', name: 'Tentang', icon: 'info', load: async () => about },
];

// ---------- "Tersimpan" ----------

let savedTimer = 0;
const pad = (n) => String(n).padStart(2, '0');
function markSaved() {
  const pill = $('saved');
  pill.classList.remove('pulse');
  void pill.offsetWidth; // restart the pulse
  pill.classList.add('pulse');
  const d = new Date();
  $('saved-text').textContent = `Tersimpan ${pad(d.getHours())}.${pad(d.getMinutes())}`;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $('saved-text').textContent = 'Tersimpan'; }, 4000);
}

// ---------- navigation ----------

const main = $('st-main');
const topOffset = () => $('st-top').offsetHeight + 12;

function setNav(id) {
  for (const l of document.querySelectorAll('.st-link')) {
    const on = l.dataset.sec === id;
    l.classList.toggle('on', on);
    if (on) l.setAttribute('aria-current', 'true');
    else l.removeAttribute('aria-current');
  }
  const on = document.querySelector('.st-link.on');
  const ind = $('st-ind');
  if (!on || !on.offsetWidth) return;
  ind.style.width = `${on.offsetWidth}px`;
  ind.style.height = `${on.offsetHeight}px`;
  ind.style.transform = `translate(${on.offsetLeft}px,${on.offsetTop}px)`;
  // Narrow screens: keep the active link in view in the horizontal nav.
  const nav = $('st-links').parentElement;
  if (nav.scrollWidth > nav.clientWidth) nav.scrollTo({ left: Math.max(0, on.offsetLeft - 16) });
}

let spyLock = 0;
function scrollToSection(id, { instant = false, flash = true } = {}) {
  const sec = $(`sec-${id}`);
  if (!sec) return;
  if (sec.hidden) { clearSearch(); }
  const smooth = !instant && motionLevel() !== 'minimal';
  main.scrollTo({ top: Math.max(0, sec.offsetTop - topOffset()), behavior: smooth ? 'smooth' : 'instant' });
  setNav(id);
  // The spy would flicker through the sections passed on the way; it resumes when scrolling stops.
  spyLock = Date.now() + (smooth ? 900 : 0);
  if (flash) {
    animate(sec.querySelector('.st-card'), [
      { boxShadow: '0 0 0 3px var(--accent), 0 0 40px -6px var(--accent)' },
      { boxShadow: '0 0 0 0 transparent' },
    ], { duration: 1400, delay: smooth ? 300 : 0 });
  }
}

let spyRaf = 0;
function spy() {
  cancelAnimationFrame(spyRaf);
  spyRaf = requestAnimationFrame(() => {
    if (Date.now() < spyLock) return;
    const y = main.scrollTop + topOffset() + 40;
    const shown = SECTIONS.filter((s) => !$(`sec-${s.id}`).hidden);
    let cur = shown[0]?.id || SECTIONS[0].id;
    for (const s of shown) if ($(`sec-${s.id}`).offsetTop <= y) cur = s.id;
    if (main.scrollTop > 0 && main.scrollTop + main.clientHeight >= main.scrollHeight - 4) cur = shown.at(-1)?.id || cur;
    setNav(cur);
  });
}
main.addEventListener('scroll', spy, { passive: true });
main.addEventListener('scrollend', () => { spyLock = 0; spy(); });

const hashSection = () => decodeURIComponent(location.hash.slice(1));
addEventListener('hashchange', () => scrollToSection(hashSection()));

// ---------- search ----------

const sectionName = new Map(SECTIONS.map((s) => [s.id, s.name]));
// Search text of a row: its title, description and section name, plus any extra keywords.
function indexItems() {
  for (const sec of document.querySelectorAll('.st-sec')) {
    const name = sectionName.get(sec.id.slice(4)) || '';
    for (const it of sec.querySelectorAll('.item')) {
      const words = [...it.querySelectorAll(':scope > .item-text, :scope > .item-row > .item-text, :scope > .about')]
        .map((n) => n.textContent).join(' ');
      it.dataset.search = `${words} ${name} ${it.dataset.searchExtra || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
    }
  }
}

function runSearch() {
  const q = $('st-q').value.trim().toLowerCase();
  indexItems();
  let any = false;
  for (const sec of document.querySelectorAll('.st-sec')) {
    let shown = 0;
    for (const it of sec.querySelectorAll('.item')) {
      const hit = !q || it.dataset.search.includes(q);
      it.hidden = !hit;
      it.classList.toggle('match', !!q && hit);
      if (hit) it.style.setProperty('--k', String(shown++));
    }
    sec.hidden = !shown;
    any ||= shown > 0;
  }
  $('st-empty').hidden = any;
  requestAnimationFrame(() => {
    document.querySelectorAll('.seg').forEach(moveThumb);
    spy();
  });
}

function clearSearch() {
  if (!$('st-q').value) return;
  $('st-q').value = '';
  runSearch();
}

$('st-q').addEventListener('input', runSearch);
$('st-q').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('st-q').value) { e.preventDefault(); clearSearch(); }
});

// ---------- sections ----------

const ctx = {
  send,
  markSaved,
  toast,
  burst: (el, n, colors) => sky.burstAt(el, n, colors),
  goto: (id) => { history.replaceState(null, '', `#${id}`); scrollToSection(id); },
};

const body = $('st-body');
const links = $('st-links');
const shells = SECTIONS.map((s, i) => {
  const desc = h('p');
  const card = h('div', { class: 'st-card' });
  const sec = h('section', { class: 'st-sec', id: `sec-${s.id}`, 'aria-labelledby': `h-${s.id}`, 'data-in': '', style: `--i:${i};--base:180ms` },
    h('h2', { id: `h-${s.id}` }, icon(s.icon), s.name), desc, card);
  const sub = h('small');
  const link = h('button', { type: 'button', class: 'st-link', dataset: { sec: s.id }, 'data-in': '', style: `--in:from-left;--i:${i};--base:120ms` },
    icon(s.icon), h('span', { class: 't' }, h('b', {}, s.name), sub));
  link.addEventListener('click', () => ctx.goto(s.id));
  links.append(link);
  body.append(sec);
  return { s, desc, card, sub };
});
body.append(h('p', { class: 'st-empty', id: 'st-empty', hidden: true }, 'Tidak ada pengaturan yang cocok. Coba kata lain.'));

async function renderSection({ s, desc, card, sub }) {
  try {
    const mod = await s.load();
    desc.textContent = mod.summary?.desc || '';
    sub.textContent = mod.summary?.sub || '';
    await mod.render(card, ctx);
  } catch (err) {
    card.replaceChildren(h('p', { class: 'st-error', role: 'alert' }, `Bagian ini gagal dimuat: ${err?.message || err}`));
  }
}

await Promise.all(shells.map(renderSection));
hydrateIcons(body);
indexItems();

// "Kembali ke Tab Manager" only while the dashboard exists.
const syncBack = (states) => { $('st-back').hidden = !states.tabs; };
syncBack(await getModuleStates());
onModuleStatesChanged(syncBack);
$('st-back').addEventListener('click', () => location.assign(chrome.runtime.getURL('modules/tabs/newtab.html')));

// Reveal, then place the thumbs/indicator (they need layout) and jump to #<id>.
$('st').classList.add('ready');
const place = () => {
  document.querySelectorAll('.seg').forEach(moveThumb);
  const id = hashSection();
  if ($(`sec-${id}`)) scrollToSection(id, { instant: true, flash: true });
  else setNav(SECTIONS[0].id);
};
requestAnimationFrame(place);
document.fonts?.ready.then(() => {
  document.querySelectorAll('.seg').forEach(moveThumb);
  const on = document.querySelector('.st-link.on');
  if (on) setNav(on.dataset.sec);
});
addEventListener('resize', () => {
  document.querySelectorAll('.seg').forEach(moveThumb);
  spy();
});
