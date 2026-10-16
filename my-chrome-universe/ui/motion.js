// Motion helpers scaled by the page's data-motion level.
import { ic } from './icons.js';

export const MOTION_SCALE = { full: 1, balanced: 0.75, minimal: 0 };
const NF = new Intl.NumberFormat('id-ID');

export function motionLevel() {
  const m = typeof document !== 'undefined' ? document.documentElement.dataset.motion : '';
  return m === 'balanced' || m === 'minimal' ? m : 'full';
}

// Minimal waits a token 30 ms at most so sequenced code stays ordered but instant.
export function wait(ms) {
  const lvl = motionLevel();
  const t = lvl === 'minimal' ? Math.min(ms, 30) : ms * (lvl === 'balanced' ? 0.85 : 1);
  return new Promise((r) => setTimeout(r, t));
}

export function animate(el, keyframes, opts = {}) {
  const k = MOTION_SCALE[motionLevel()];
  return el.animate(keyframes, { easing: 'cubic-bezier(.22,1,.36,1)', ...opts, duration: Math.max(1, (opts.duration || 300) * (k || 0.001)) });
}

export function countUp(el, to, ms = 1100) {
  if (!el) return;
  if (motionLevel() === 'minimal') { el.textContent = NF.format(to); return; }
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / ms);
    el.textContent = NF.format(Math.round(to * (1 - Math.pow(1 - k, 3))));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function shake(el) {
  animate(el, [{ transform: 'translateX(0)' }, { transform: 'translateX(-12px)' }, { transform: 'translateX(10px)' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], { duration: 520, easing: 'ease-out' });
}

// Auto-dismiss uses JS timers: in minimal motion CSS animations jump to their end state.
export function toast(text, opts = {}) {
  let box = document.querySelector('.toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    box.setAttribute('aria-live', 'polite');
    document.body.append(box);
  }
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span class="t-ic">${ic(opts.icon || 'check')}</span><span class="t-text"></span><span class="t-bar"></span>`;
  t.querySelector('.t-text').textContent = text;
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    t.classList.add('out');
    setTimeout(() => t.remove(), 260);
  };
  if (opts.action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost sm';
    b.innerHTML = ic('undo');
    b.append(opts.action.label);
    b.addEventListener('click', () => { opts.action.run(); dismiss(); });
    t.insertBefore(b, t.querySelector('.t-bar'));
  }
  box.prepend(t);
  while (box.children.length > 3) box.lastElementChild.remove();
  timer = setTimeout(dismiss, 4200);
}

const installed = new WeakSet();

// Ripple on .rp, spotlight on .glow, tilt on .tilt (full motion only).
export function installEffects(root = document) {
  if (installed.has(root)) return;
  installed.add(root);
  root.addEventListener('pointerdown', (e) => {
    const b = e.target.closest?.('.rp');
    if (!b || motionLevel() === 'minimal') return;
    const r = b.getBoundingClientRect(), size = Math.max(r.width, r.height) * 2.4;
    const sp = document.createElement('span');
    sp.className = 'ripple';
    sp.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    b.append(sp);
    setTimeout(() => sp.remove(), 700);
  });
  root.addEventListener('pointermove', (e) => {
    const g = e.target.closest?.('.glow');
    if (g) {
      const r = g.getBoundingClientRect();
      g.style.setProperty('--mx', `${e.clientX - r.left}px`);
      g.style.setProperty('--my', `${e.clientY - r.top}px`);
    }
    const t = e.target.closest?.('.tilt');
    if (t && motionLevel() === 'full') {
      const r = t.getBoundingClientRect();
      t.style.setProperty('--ry', `${((e.clientX - r.left) / r.width - 0.5) * 6}deg`);
      t.style.setProperty('--rx', `${-((e.clientY - r.top) / r.height - 0.5) * 8}deg`);
    }
  }, { passive: true });
  root.addEventListener('pointerout', (e) => {
    const t = e.target.closest?.('.tilt');
    if (t && !t.contains(e.relatedTarget)) { t.style.setProperty('--rx', '0deg'); t.style.setProperty('--ry', '0deg'); }
  });
}
