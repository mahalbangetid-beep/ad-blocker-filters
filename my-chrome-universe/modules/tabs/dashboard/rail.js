// Zone 1: clock and greeting, spaces as planets with a sliding indicator, starred collections.
import { runOp, h } from '../common.js';
import { icon } from '../../../ui/icons.js';
import { act } from './dialogs.js';
import { planetColor } from './collections.js';
import { clearDropMarks, currentDrag } from './drag.js';

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const tabCount = (space) => space.collections.reduce((n, c) => n + c.cards.length, 0);

let lastData = null;
let knownStarred = null;

// onActivate(spaceId), onReveal(spaceId, collectionId), onSpaceMenu(anchor, spaceId),
// onDropTabs(spaceId, drag, event, button) for open tabs or links dropped on a space.
// searching: no space is marked active while search results are shown.
export function renderRail(data, { onActivate, onReveal, onSpaceMenu, onDropTabs, searching = false }) {
  lastData = data;
  const list = $('space-list');
  list.querySelectorAll('.space').forEach((el) => el.remove());
  data.spaces.forEach((space, i) => {
    const on = space.id === data.activeSpaceId && !searching;
    const button = h('button', {
      type: 'button',
      class: `space${on ? ' on' : ''}`,
      dataset: { id: space.id },
      style: `--pc:${planetColor(i)}`,
      title: space.name,
      'aria-current': on ? 'true' : null,
      onclick: () => onActivate(space.id),
      oncontextmenu: (e) => {
        e.preventDefault();
        onSpaceMenu(button, space.id);
      },
    }, h('span', { class: 'planet' }), h('span', { class: 'space-name' }, space.name), h('span', { class: 'space-n' }, tabCount(space)));

    // Drop a collection on a space to move it there; open tabs and links are saved into it.
    const accepts = (drag) => drag && (drag.kind === 'collection' || ((drag.kind === 'tab' || drag.kind === 'url') && onDropTabs));
    button.addEventListener('dragover', (e) => {
      if (!accepts(currentDrag(e))) return;
      e.preventDefault();
      clearDropMarks();
      button.classList.add('drop-over');
    });
    button.addEventListener('drop', (e) => {
      const drag = currentDrag(e);
      if (!accepts(drag)) return;
      e.preventDefault();
      clearDropMarks();
      if (drag.kind === 'collection') {
        act(runOp({ type: 'collection/move', collectionId: drag.collectionId, toSpaceId: space.id, index: 0 }), `Dipindah ke ${space.name}`);
      } else {
        onDropTabs(space.id, drag, e, button);
      }
    });
    list.append(button);
  });
  moveIndicator();
  renderStarred(data, onReveal);
  tickClock();
}

// Marks a space active right away (the stored change follows) so the indicator slides at once.
export function setActiveSpace(spaceId) {
  for (const el of $('space-list').querySelectorAll('.space')) {
    el.classList.toggle('on', el.dataset.id === spaceId);
    if (el.dataset.id === spaceId) el.setAttribute('aria-current', 'true');
    else el.removeAttribute('aria-current');
  }
  moveIndicator();
}

export function moveIndicator() {
  const ind = $('space-ind');
  if (!ind) return; // page replaced by the lock notice
  const on = $('space-list').querySelector('.space.on');
  ind.hidden = !on;
  if (!on) return;
  const first = !ind.dataset.placed;
  if (first) ind.style.transition = 'none';
  ind.style.setProperty('--pc', on.style.getPropertyValue('--pc'));
  ind.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
  ind.style.width = `${on.offsetWidth}px`;
  ind.style.height = `${on.offsetHeight}px`;
  if (first) {
    void ind.offsetWidth;
    ind.style.transition = '';
    ind.dataset.placed = '1';
  }
}

function renderStarred(data, onReveal) {
  const items = data.spaces.flatMap((space) => space.collections.filter((c) => c.starred).map((c) => ({ space, c })));
  const before = knownStarred;
  knownStarred = new Set(items.map(({ c }) => c.id));
  $('starred').replaceChildren(...(items.length
    ? items.map(({ space, c }) => h('li', { class: before && !before.has(c.id) ? 'new' : null },
      h('button', { type: 'button', title: `${c.name} — ${space.name}`, onclick: () => onReveal(space.id, c.id) },
        icon('star'), h('span', { class: 'starred-name' }, c.name), h('small', {}, space.name))))
    : [h('li', { class: 'empty-note' }, 'Bintangi koleksi agar muncul di sini.')]));
}

export function tickClock() {
  if (!lastData || !$('clock')) return; // nothing to show before the data (or under the lock notice)
  const d = new Date();
  const hour = d.getHours();
  $('clock').replaceChildren(pad(hour), h('i', {}, '.'), pad(d.getMinutes()));
  const saved = lastData.spaces.reduce((n, s) => n + tabCount(s), 0);
  const part = hour < 11 ? 'pagi' : hour < 15 ? 'siang' : hour < 18 ? 'sore' : 'malam';
  $('greet').textContent = `Selamat ${part}. ${saved} tab tersimpan aman.`;
}

setInterval(tickClock, 15000);
addEventListener('resize', () => requestAnimationFrame(moveIndicator));
document.fonts?.ready.then(() => moveIndicator());
