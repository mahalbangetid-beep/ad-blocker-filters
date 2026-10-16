// Toolbar popup: a grid of module tiles; a tile opens that module's panel, "←" returns.
import { guardPage } from './core/page-guard.js';
import { MODULES } from './core/modules.js';

await guardPage('popup');

const $ = (id) => document.getElementById(id);
const loadPanel = (module) => import(`./${module.panel}`);

// What the popup itself puts in <head> and on <html>; closing a panel restores exactly this,
// so a module's stylesheet (and e.g. Tab Manager's data-theme) never leaks into the grid.
const baseHead = new Set(document.head.children);
const baseAttrs = [...document.documentElement.attributes].map((a) => [a.name, a.value]);

function restoreBase() {
  for (const node of [...document.head.children]) if (!baseHead.has(node)) node.remove();
  const html = document.documentElement;
  for (const name of html.getAttributeNames()) html.removeAttribute(name);
  for (const [name, value] of baseAttrs) html.setAttribute(name, value);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------- Grid ----------

const tiles = new Map();
for (const module of MODULES) {
  const tile = el('button', 'mcu-tile');
  tile.type = 'button';
  tile.dataset.id = module.id;
  tile.append(el('span', 'mcu-tile-icon', module.icon), el('span', 'mcu-tile-name', module.name), el('span', 'mcu-tile-status'));
  tile.addEventListener('click', () => openPanel(module));
  tiles.set(module.id, tile);
}
$('mcu-grid').append(...tiles.values());

function refreshStatuses() {
  for (const module of MODULES) {
    const line = tiles.get(module.id).querySelector('.mcu-tile-status');
    loadPanel(module)
      .then((panel) => panel.status())
      .then((text) => { line.textContent = text; })
      .catch(() => { line.textContent = ''; });
  }
}

// ---------- Panel ----------

let current = null; // { module, root } of the open panel

function setHeader(module) {
  $('mcu-back').hidden = !module;
  $('mcu-logo').hidden = !!module;
  $('mcu-icon').hidden = !module;
  $('mcu-icon').textContent = module?.icon || '';
  $('mcu-title').textContent = module ? module.name : 'My Chrome Universe';
  $('mcu-options').hidden = !!module && !module.options;
}

async function openPanel(module) {
  closePanel();
  // A fresh root per opening: only one panel is ever in the DOM (module element ids may collide).
  const root = el('div', 'mcu-panel-root');
  root.dataset.module = module.id;
  current = { module, root };
  $('mcu-panel').replaceChildren(root);
  $('mcu-grid').hidden = true;
  $('mcu-panel').hidden = false;
  setHeader(module);
  try {
    await (await loadPanel(module)).render(root);
  } catch (err) {
    console.error(err);
    if (current?.root === root) root.replaceChildren(el('p', 'mcu-off', 'Panel gagal dimuat.'));
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

function showGrid() {
  closePanel();
  $('mcu-panel').hidden = true;
  $('mcu-grid').hidden = false;
  setHeader(null);
  refreshStatuses();
  tiles.get(MODULES[0].id).focus();
}

$('mcu-back').addEventListener('click', showGrid);

$('mcu-options').addEventListener('click', async () => {
  if (current) await chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${current.module.id}`) });
  else await chrome.runtime.openOptionsPage();
  window.close();
});

setHeader(null);
refreshStatuses();
