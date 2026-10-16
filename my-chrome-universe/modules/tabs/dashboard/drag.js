// Drag and drop shared by the dashboard zones: open tabs, cards and collections dragged on this
// page carry a payload; links dragged in from elsewhere become { kind: 'url' }.
import { isSavableUrl } from '../store.js';

let dragging = null; // { kind: 'tab' | 'card' | 'collection', ... } for drags started on this page
let afterDrag = null;

export const isDragging = () => dragging !== null;
export function onDragEnd(callback) { afterDrag = callback; }

export function startDrag(event, payload, el) {
  dragging = payload;
  el.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'copyMove';
  if (payload.url) event.dataTransfer.setData('text/uri-list', payload.url);
  event.dataTransfer.setData('text/plain', payload.url || payload.kind);
  el.addEventListener('dragend', endDrag, { once: true });
}

function endDrag() {
  dragging = null;
  document.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
  clearDropMarks();
  afterDrag?.();
}

export function clearDropMarks() {
  document.querySelectorAll('.drop-over, .drop-before, .drop-above, .drop-below')
    .forEach((n) => n.classList.remove('drop-over', 'drop-before', 'drop-above', 'drop-below'));
}

export function currentDrag(event) {
  if (dragging) return dragging;
  const types = Array.from(event.dataTransfer?.types || []);
  return types.includes('text/uri-list') ? { kind: 'url' } : null;
}

// Tabs carried by an open-tab drag, or savable links dropped from elsewhere.
export function droppedTabs(drag, event) {
  if (drag.kind === 'tab') return drag.tabs;
  if (drag.kind !== 'url') return [];
  const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
  return text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#') && isSavableUrl(s)).map((url) => ({ url, title: url }));
}

// After open tabs were saved by a drop: closes them when "Tutup tab setelah disimpan" is on.
export async function closeDroppedTabs(drag, { close, keepTabId }) {
  if (drag.kind !== 'tab' || !close) return;
  await chrome.tabs.remove(drag.tabs.map((t) => t.id).filter((id) => id !== keepTabId)).catch(() => {});
}

document.addEventListener('dragover', (e) => {
  // Clear highlights when the pointer is over something that is not a drop target.
  if (!e.defaultPrevented) clearDropMarks();
});
document.addEventListener('drop', () => setTimeout(endDrag));
