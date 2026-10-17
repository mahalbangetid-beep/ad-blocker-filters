// Sticky notes on websites. Registered by modules/notes/background.js while the module is on
// (and injected into open tabs when needed). Every note lives in one closed shadow root, so the
// site can neither style nor read them; note text is plain text in a <textarea>, never HTML.
// Universe palette and system fonts only: nothing is loaded into the site.
(() => {
  // A re-injected copy (module switched back on, extension updated) replaces the old one.
  try { window.__mcuNotes?.destroy(); } catch { /* the old copy's context is gone */ }
  for (const old of document.querySelectorAll('mcu-notes')) old.remove();

  const SAVE_DELAY = 600;
  const FONTS = {
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
  };
  const SIZES = { s: '12.5px', m: '14px', l: '16px' };
  const COLORS = [
    ['surya', 'Surya'], ['ion', 'Ion'], ['nova', 'Nova'], ['nebula', 'Nebula'],
    ['langit', 'Langit'], ['bulan', 'Bulan'], ['malam', 'Malam'],
  ];
  const MIN_W = 150;
  const MIN_H = 120;

  // Everything is built with the DOM API (no markup strings anywhere, so nothing a note holds can
  // ever become HTML) and styled with a constructed stylesheet.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function make(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    node.append(...children);
    return node;
  }
  const ICONS = {
    pin: [['path', { d: 'M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z' }]],
    more: [['circle', { cx: 12, cy: 12, r: 1 }], ['circle', { cx: 19, cy: 12, r: 1 }], ['circle', { cx: 5, cy: 12, r: 1 }]],
    copy: [['rect', { x: 8, y: 8, width: 14, height: 14, rx: 2 }], ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }]],
    trash: [['path', { d: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }]],
    note: [['path', { d: 'M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5z' }], ['path', { d: 'M15 3v4a2 2 0 0 0 2 2h4' }]],
  };
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of ICONS[name]) {
      const part = document.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(attrs)) part.setAttribute(key, value);
      svg.append(part);
    }
    return svg;
  }

  const host = document.createElement('mcu-notes');
  host.style.cssText = 'all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; display: block; z-index: 2147483646;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
      :host { --font: ${FONTS.sans}; --size: ${SIZES.m}; }
      @media print { :host { display: none !important; } }
      * { box-sizing: border-box; }
      button { font: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0; cursor: pointer; }
      svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; display: block; }

      /* Palette: fills keep the Universe hues; --ink and --sub keep 4.5:1 on --bg, --bg2 and --bar
         (tests/notes.test.mjs checks it). */
      .c-surya  { --bg: #FFE9B8; --bg2: #FFDB91; --bar: #FFB547; --ink: #2B1B03; --sub: #6A4708; --glow: rgba(255, 181, 71, .6); }
      .c-ion    { --bg: #D2F8F0; --bg2: #ADF0E3; --bar: #5EEAD4; --ink: #06292A; --sub: #1C5A50; --glow: rgba(94, 234, 212, .55); }
      .c-nova   { --bg: #FFE0E7; --bg2: #FFC6D3; --bar: #FF8FA8; --ink: #3A0A18; --sub: #772640; --glow: rgba(255, 143, 168, .55); }
      .c-nebula { --bg: #E8E2FF; --bg2: #D6CCFF; --bar: #A99BFF; --ink: #1C1442; --sub: #463B84; --glow: rgba(169, 155, 255, .55); }
      .c-langit { --bg: #D9ECFF; --bg2: #BEDCFF; --bar: #6CB4FF; --ink: #0B2340; --sub: #284B74; --glow: rgba(108, 180, 255, .55); }
      .c-bulan  { --bg: #F3F5FA; --bg2: #E2E6F1; --bar: #BBC3D9; --ink: #131A35; --sub: #434B6E; --glow: rgba(187, 195, 217, .6); }
      .c-malam  { --bg: #1B2139; --bg2: #11162A; --bar: #2D355A; --ink: #EEF1FF; --sub: #B4BBD8; --glow: rgba(255, 181, 71, .4); }

      .note {
        position: absolute; display: flex; flex-direction: column; min-width: ${MIN_W}px; min-height: ${MIN_H}px;
        color: var(--ink); background: linear-gradient(165deg, var(--bg) 0%, var(--bg2) 100%);
        border-radius: 16px; font: 400 var(--size)/1.5 var(--font); text-align: left; pointer-events: auto;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, .5), 0 22px 44px -20px rgba(6, 8, 15, .6), 0 6px 14px -8px rgba(6, 8, 15, .4);
        transition: box-shadow .28s cubic-bezier(.22, 1, .36, 1), transform .28s cubic-bezier(.22, 1, .36, 1), width .32s cubic-bezier(.22, 1, .36, 1), height .32s cubic-bezier(.22, 1, .36, 1), border-radius .32s;
      }
      .note.enter { animation: nt-in .62s cubic-bezier(.34, 1.56, .64, 1) both; }
      .note.appear { animation: nt-appear .42s cubic-bezier(.22, 1, .36, 1) both; }
      .note.pinned { position: fixed; }
      .note::before { /* starlight sheen in the corner */
        content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
        background: radial-gradient(120% 70% at 100% 0%, rgba(255, 255, 255, .42), transparent 55%);
      }
      .c-malam.note::before { background: radial-gradient(90% 60% at 100% 0%, rgba(255, 181, 71, .16), transparent 60%), radial-gradient(1.5px 1.5px at 82% 22%, #fff 50%, transparent), radial-gradient(1px 1px at 64% 12%, #fff 50%, transparent), radial-gradient(1px 1px at 92% 40%, #fff 50%, transparent); }
      .note:focus-within { box-shadow: inset 0 1px 0 rgba(255, 255, 255, .5), 0 0 0 2px var(--bar), 0 0 38px -6px var(--glow), 0 26px 50px -22px rgba(6, 8, 15, .65); }
      .note.dragging { transform: rotate(-1.4deg) scale(1.025); box-shadow: 0 0 0 2px var(--bar), 0 0 46px -4px var(--glow), 0 34px 60px -24px rgba(6, 8, 15, .7); transition: box-shadow .2s, transform .2s; }
      .note.resizing { transition: none; }
      .note.flash { animation: nt-flash 1.1s ease-out; }
      .note.leaving { animation: nt-out .42s cubic-bezier(.55, 0, 1, .45) forwards; pointer-events: none; }
      @keyframes nt-appear { from { opacity: 0; transform: translateY(8px) scale(.96); } }
      @keyframes nt-in { from { opacity: 0; transform: scale(.35) rotate(-6deg); filter: blur(6px); } 60% { filter: blur(0); } }
      @keyframes nt-out { 40% { opacity: 1; transform: scale(1.04); filter: brightness(1.15); } to { opacity: 0; transform: scale(.05) rotate(14deg); filter: blur(3px) brightness(2); } }
      @keyframes nt-flash { 0%, 100% { box-shadow: inset 0 1px 0 rgba(255, 255, 255, .5), 0 22px 44px -20px rgba(6, 8, 15, .6); } 30% { box-shadow: 0 0 0 3px var(--bar), 0 0 60px 6px var(--glow); } }

      .bar { position: relative; display: flex; align-items: center; gap: 4px; height: 30px; flex: none; padding: 0 5px 0 10px;
        border-radius: 16px 16px 0 0; background: linear-gradient(180deg, var(--bar), color-mix(in srgb, var(--bar) 70%, var(--bg))); cursor: grab; user-select: none; touch-action: none; }
      .note.dragging .bar { cursor: grabbing; }
      .orbit { position: relative; width: 14px; height: 14px; flex: none; }
      .orbit::before { content: ""; position: absolute; inset: 4px; border-radius: 50%; background: var(--ink); opacity: .8; }
      .orbit::after { content: ""; position: absolute; inset: 4px -1px; border: 1.5px solid var(--ink); border-radius: 50%; opacity: .45; transform: rotate(-24deg); }
      .date { flex: 1; min-width: 0; font: 600 11px/1 system-ui, sans-serif; letter-spacing: .01em; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
      :host(.no-date) .date { visibility: hidden; }
      .bar button { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 8px; color: var(--ink); opacity: .72; transition: opacity .16s, background .16s, transform .16s; }
      .bar button:hover { opacity: 1; background: rgba(0, 0, 0, .1); }
      .c-malam .bar button:hover { background: rgba(255, 255, 255, .12); }
      .bar button:active { transform: scale(.9); }
      .bar button:focus-visible, .menu button:focus-visible, .orb:focus-visible, .toast button:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; opacity: 1; }
      .note.pinned .b-pin { opacity: 1; background: rgba(0, 0, 0, .12); }
      .note.pinned .b-pin svg { transform: rotate(-30deg); fill: currentColor; }

      textarea { flex: 1; width: 100%; min-height: 0; margin: 0; padding: 9px 13px 16px; border: 0; outline: 0; resize: none;
        background: transparent; color: inherit; font: inherit; line-height: 1.5; caret-color: var(--ink); }
      textarea::placeholder { color: var(--sub); }
      textarea::selection { background: color-mix(in srgb, var(--bar) 55%, transparent); }
      textarea::-webkit-scrollbar { width: 8px; }
      textarea::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--ink) 25%, transparent); border-radius: 8px; }
      .grip { position: absolute; right: 3px; bottom: 3px; width: 16px; height: 16px; cursor: nwse-resize; touch-action: none; color: var(--sub); opacity: .75;
        background: radial-gradient(circle, currentColor 1.3px, transparent 1.7px) 0 0 / 5px 5px;
        -webkit-mask: linear-gradient(135deg, transparent 52%, #000 52%); mask: linear-gradient(135deg, transparent 52%, #000 52%); }
      .grip:hover { opacity: 1; }

      /* Icon mode: every note becomes a small glowing orb at its corner. */
      .orb { display: none; width: 34px; height: 34px; border-radius: 50%; place-items: center; color: var(--ink);
        background: radial-gradient(circle at 35% 30%, var(--bg), var(--bar)); box-shadow: 0 0 0 2px rgba(255, 255, 255, .5), 0 0 24px -2px var(--glow), 0 8px 18px -8px rgba(6, 8, 15, .6);
        animation: nt-orb 3.2s ease-in-out infinite; }
      @keyframes nt-orb { 50% { box-shadow: 0 0 0 2px rgba(255, 255, 255, .5), 0 0 34px 2px var(--glow), 0 8px 18px -8px rgba(6, 8, 15, .6); } }
      .note.as-icon { min-width: 0; min-height: 0; width: 34px !important; height: 34px !important; border-radius: 50%; background: none; box-shadow: none; }
      .note.as-icon::before, .note.as-icon > :not(.orb) { display: none; }
      .note.as-icon .orb { display: grid; }

      .menu { position: absolute; top: 34px; right: 4px; z-index: 3; width: 220px; padding: 10px; border-radius: 16px;
        --m-bg: #11162A; --m-ink: #EEF1FF; --m-dust: #A3ABCB; --m-line: rgba(170, 184, 235, .26); --m-raise: rgba(255, 255, 255, .06); --m-danger: #FF6B6B; --m-accent: #FFB547;
        background: var(--m-bg); color: var(--m-ink); border: 1px solid var(--m-line); font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
        box-shadow: 0 24px 50px -18px rgba(0, 0, 0, .7), 0 0 44px -26px var(--m-accent); transform-origin: top right; animation: nt-pop .3s cubic-bezier(.34, 1.56, .64, 1); }
      .menu[hidden] { display: none; }
      @keyframes nt-pop { from { opacity: 0; transform: translateY(-6px) scale(.92); } }
      .menu-label { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--m-dust); margin: 0 2px 8px; }
      .swatches { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; padding: 0 2px 10px; margin-bottom: 6px; border-bottom: 1px solid var(--m-line); }
      .swatch { width: 22px; height: 22px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, var(--bg), var(--bar)); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .3); transition: transform .18s cubic-bezier(.34, 1.56, .64, 1); }
      .swatch:hover { transform: scale(1.15); }
      .swatch[aria-checked="true"] { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .3), 0 0 0 2px var(--m-bg), 0 0 0 4px var(--m-accent); }
      .item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px; border-radius: 10px; text-align: left; color: var(--m-ink); transition: background .16s; }
      .item:hover { background: var(--m-raise); }
      .item svg { color: var(--m-dust); }
      .item.danger, .item.danger svg { color: var(--m-danger); }

      .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483647; display: flex; align-items: center; gap: 12px;
        padding: 10px 10px 10px 16px; border-radius: 14px; pointer-events: auto;
        --m-bg: #11162A; --m-ink: #EEF1FF; --m-line: rgba(170, 184, 235, .26); --m-accent: #FFB547;
        background: var(--m-bg); color: var(--m-ink); border: 1px solid var(--m-line); font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
        box-shadow: 0 20px 44px -18px rgba(0, 0, 0, .7); animation: nt-toast .4s cubic-bezier(.34, 1.56, .64, 1); }
      @keyframes nt-toast { from { opacity: 0; transform: translate(-50%, 16px) scale(.96); } }
      .toast button { padding: 6px 12px; border-radius: 9px; font-weight: 700; background: var(--m-accent); color: #1B1204; }
      .toast button[hidden] { display: none; }

      @media (prefers-color-scheme: light) {
        .menu, .toast { --m-bg: #FFFFFF; --m-ink: #131A35; --m-dust: #485073; --m-line: rgba(40, 52, 110, .22); --m-raise: rgba(22, 30, 70, .05); --m-danger: #C6343A; }
        .menu { box-shadow: 0 22px 44px -20px rgba(30, 40, 90, .4); }
        .toast { box-shadow: 0 20px 40px -18px rgba(30, 40, 90, .45); }
      }
      :host([data-motion="balanced"]) .orb { animation: none; }
      :host([data-motion="minimal"]) *, :host([data-motion="minimal"]) *::before, :host([data-motion="minimal"]) *::after { animation: none !important; transition: none !important; }
  `);
  shadow.adoptedStyleSheets = [sheet];
  const layer = make('div', { class: 'layer' });
  shadow.append(layer);

  // Keys typed into a note must not trigger the site's shortcuts.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    shadow.addEventListener(type, (e) => {
      e.stopPropagation();
      if (type === 'keydown' && e.key === 'Escape') {
        closeMenus();
        if (e.target.matches?.('textarea')) e.target.blur();
      }
    });
  }

  let alive = true;
  let pageUrl = null;
  let hidden = false;
  let icons = false;
  let topZ = 1;
  let defaultColor = 'surya';
  let motion = 'full';
  let lastPointer = null;
  const notes = new Map(); // id (or a temporary key) -> view

  const send = (type, payload = {}) => {
    if (!chrome.runtime?.id) {
      destroy();
      return Promise.resolve(null);
    }
    return chrome.runtime.sendMessage({ type, ...payload }).catch(() => null);
  };

  const dateFormat = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtDate = (t) => (t ? dateFormat.format(new Date(t)) : '');
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animated = () => motion !== 'minimal';

  function applySettings(settings, motionSetting) {
    host.style.setProperty('--font', FONTS[settings?.font] || FONTS.sans);
    host.style.setProperty('--size', SIZES[settings?.size] || SIZES.m);
    host.classList.toggle('no-date', settings?.showDate === false);
    defaultColor = settings?.color || 'surya';
    motion = motionSetting || (reducedMotion() ? 'minimal' : 'full');
    host.dataset.motion = motion;
  }

  function mount() {
    if (!host.isConnected) document.documentElement.append(host);
  }

  // ---------- one note ----------

  function createView(data) {
    const el = document.createElement('article');
    el.className = 'note';
    el.addEventListener('animationend', (e) => {
      if (e.target === el && e.animationName !== 'nt-out') el.classList.remove('enter', 'appear', 'flash');
    });
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Catatan');
    const button = (cls, attrs, ...children) => make('button', { class: cls, type: 'button', ...attrs }, ...children);
    el.append(
      make('header', { class: 'bar' },
        make('span', { class: 'orbit', 'aria-hidden': 'true' }),
        make('span', { class: 'date' }),
        button('b-pin', {}, icon('pin')),
        button('b-more', { 'aria-label': 'Menu catatan', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('more'))),
      make('textarea', { spellcheck: 'true', placeholder: 'Tulis catatan…', 'aria-label': 'Isi catatan' }),
      make('span', { class: 'grip', title: 'Ubah ukuran', 'aria-hidden': 'true' }),
      button('orb', { 'aria-label': 'Buka catatan' }, icon('note')),
      make('div', { class: 'menu', role: 'menu', hidden: '' },
        make('p', { class: 'menu-label' }, 'Warna'),
        make('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Warna catatan' },
          ...COLORS.map(([id, name]) => button(`swatch c-${id}`, { role: 'radio', 'data-color': id, 'aria-label': name, title: name }))),
        button('item i-pin', { role: 'menuitem' }, icon('pin'), make('span')),
        button('item i-copy', { role: 'menuitem' }, icon('copy'), make('span', {}, 'Salin teks')),
        button('item i-delete danger', { role: 'menuitem' }, icon('trash'), make('span', {}, 'Hapus catatan'))));
    const view = {
      el,
      text: el.querySelector('textarea'),
      data: { ...data },
      saveTimer: null,
      creating: null, // promise of the first save, while the note has no id yet
    };
    view.text.value = data.text || '';
    paint(view);
    wire(view);
    return view;
  }

  // Toggles only the state classes, so a running entrance or flash animation is left alone.
  function paint(view) {
    const { el, data } = view;
    const color = data.color || defaultColor;
    for (const [id] of COLORS) el.classList.toggle(`c-${id}`, id === color);
    el.classList.toggle('pinned', !!data.pinned);
    el.classList.toggle('as-icon', icons && !view.opened);
    el.style.left = `${data.x}px`;
    el.style.top = `${data.y}px`;
    el.style.width = `${data.w}px`;
    el.style.height = `${data.h}px`;
    el.style.zIndex = String(data.z || 1);
    el.querySelector('.date').textContent = fmtDate(data.updated || data.created);
    const pinLabel = data.pinned ? 'Lepas sematan' : 'Sematkan di layar';
    const pinButton = el.querySelector('.b-pin');
    pinButton.setAttribute('aria-label', pinLabel);
    pinButton.title = pinLabel;
    pinButton.setAttribute('aria-pressed', String(!!data.pinned));
    el.querySelector('.i-pin span').textContent = pinLabel;
    for (const s of el.querySelectorAll('.swatch')) s.setAttribute('aria-checked', String(s.dataset.color === color));
  }

  function toFront(view) {
    if ((view.data.z || 0) >= topZ) return false;
    view.data.z = ++topZ;
    view.el.style.zIndex = String(view.data.z);
    return true;
  }

  function payload(view) {
    const { id, x, y, w, h, z, color, pinned } = view.data;
    return { id, text: view.text.value, x, y, w, h, z, color, pinned };
  }

  async function save(view) {
    clearTimeout(view.saveTimer);
    view.saveTimer = null;
    if (view.removed) return;
    if (view.creating) await view.creating;
    if (view.removed) return;
    const result = await send('nt:save', { note: payload(view) });
    if (!result?.ok) {
      if (result?.error && result.error !== 'locked') toast(result.error);
      return result;
    }
    view.data.updated = result.note.updated;
    view.el.querySelector('.date').textContent = fmtDate(result.note.updated);
    return result;
  }

  const saveSoon = (view) => {
    clearTimeout(view.saveTimer);
    view.saveTimer = setTimeout(() => save(view), SAVE_DELAY);
  };

  function closeMenus(except = null) {
    for (const v of notes.values()) {
      if (v === except) continue;
      v.el.querySelector('.menu').hidden = true;
      v.el.querySelector('.b-more').setAttribute('aria-expanded', 'false');
    }
  }

  function wire(view) {
    const { el, text } = view;
    const bar = el.querySelector('.bar');
    const menu = el.querySelector('.menu');
    const more = el.querySelector('.b-more');

    el.addEventListener('pointerdown', () => { if (toFront(view)) saveSoon(view); });
    text.addEventListener('input', () => saveSoon(view));
    text.addEventListener('blur', () => { if (view.saveTimer) save(view); });
    text.addEventListener('focus', () => closeMenus());

    // Drag by the bar (pinned notes move in viewport coordinates).
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      const start = { px: e.clientX, py: e.clientY, x: view.data.x, y: view.data.y };
      let moved = false;
      const move = (ev) => {
        const dx = ev.clientX - start.px;
        const dy = ev.clientY - start.py;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
        if (!moved) { moved = true; el.classList.add('dragging'); closeMenus(); }
        view.data.x = Math.max(0, Math.round(start.x + dx));
        view.data.y = Math.max(0, Math.round(start.y + dy));
        el.style.left = `${view.data.x}px`;
        el.style.top = `${view.data.y}px`;
      };
      const up = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
        el.classList.remove('dragging');
        if (moved) save(view);
        else text.focus();
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });

    // Resize from the bottom-right corner.
    const grip = el.querySelector('.grip');
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const start = { px: e.clientX, py: e.clientY, w: el.offsetWidth, h: el.offsetHeight };
      el.classList.add('resizing');
      const move = (ev) => {
        view.data.w = Math.max(MIN_W, Math.round(start.w + ev.clientX - start.px));
        view.data.h = Math.max(MIN_H, Math.round(start.h + ev.clientY - start.py));
        el.style.width = `${view.data.w}px`;
        el.style.height = `${view.data.h}px`;
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        el.classList.remove('resizing');
        save(view);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });

    el.querySelector('.b-pin').addEventListener('click', () => togglePin(view));
    more.addEventListener('click', () => {
      const open = menu.hidden;
      closeMenus(view);
      menu.hidden = !open;
      more.setAttribute('aria-expanded', String(open));
      if (open) menu.querySelector('.swatch[aria-checked="true"]')?.focus();
    });
    menu.addEventListener('click', async (e) => {
      const button = e.target.closest('button');
      if (!button) return;
      if (button.dataset.color) {
        view.data.color = button.dataset.color;
        paint(view);
        save(view);
        closeMenus();
        return;
      }
      closeMenus();
      if (button.classList.contains('i-pin')) togglePin(view);
      if (button.classList.contains('i-copy')) copyText(view);
      if (button.classList.contains('i-delete')) remove(view);
    });
    el.querySelector('.orb').addEventListener('click', () => {
      view.opened = true;
      paint(view);
      toFront(view);
      text.focus();
    });
  }

  function togglePin(view) {
    const pinned = !view.data.pinned;
    // Keep the note where it is on screen: switch between page and viewport coordinates.
    const sx = pinned ? -window.scrollX : window.scrollX;
    const sy = pinned ? -window.scrollY : window.scrollY;
    view.data.x = Math.max(0, Math.round(view.data.x + sx));
    view.data.y = Math.max(0, Math.round(view.data.y + sy));
    view.data.pinned = pinned;
    paint(view);
    save(view);
  }

  async function copyText(view) {
    const value = view.text.value;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      view.text.focus();
      view.text.select();
      document.execCommand('copy');
    }
    toast('Teks catatan disalin');
  }

  function dropView(view, { animate = animated() } = {}) {
    view.removed = true;
    clearTimeout(view.saveTimer);
    notes.delete(view.key);
    if (!animate) return view.el.remove();
    view.el.classList.add('leaving');
    setTimeout(() => view.el.remove(), 440);
  }

  async function remove(view) {
    if (view.creating) await view.creating;
    const snapshot = payload(view);
    dropView(view);
    if (!snapshot.id) return;
    await send('nt:delete', { id: snapshot.id });
    toast('Catatan dihapus', {
      action: 'Urungkan',
      onAction: async () => {
        const result = await send('nt:save', { note: snapshot });
        if (result?.ok) addView(result.note, { entrance: 'enter' });
      },
    });
  }

  function addView(data, { key = data.id, entrance = 'appear' } = {}) {
    const view = createView(data);
    view.key = key;
    view.el.classList.add(entrance);
    notes.set(view.key, view);
    topZ = Math.max(topZ, data.z || 1);
    layer.append(view.el);
    mount();
    return view;
  }

  // ---------- page actions ----------

  function placeNew(at) {
    const w = 220;
    const h = 200;
    const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth);
    let x;
    let y;
    if (at === 'pointer' && lastPointer) {
      x = lastPointer.x;
      y = lastPointer.y;
    } else {
      x = window.scrollX + (window.innerWidth - w) / 2;
      y = window.scrollY + Math.max(24, (window.innerHeight - h) / 2 - 40);
      // Cascade new notes so they do not hide one another.
      while ([...notes.values()].some((v) => !v.data.pinned && Math.abs(v.data.x - x) < 8 && Math.abs(v.data.y - y) < 8)) {
        x += 26;
        y += 26;
      }
    }
    x = Math.min(Math.max(0, x), Math.max(0, docW - w - 8));
    return { x: Math.round(x), y: Math.round(Math.max(0, y)), w, h };
  }

  function createNote({ at = 'center', text = '' } = {}) {
    if (hidden) setHidden(false);
    const pos = placeNew(at);
    const data = { ...pos, text: String(text || '').slice(0, 20000), z: ++topZ, color: defaultColor, pinned: false, created: Date.now() };
    const view = addView(data, { key: Symbol('new'), entrance: 'enter' });
    view.opened = true;
    paint(view);
    view.text.focus({ preventScroll: true });
    view.creating = send('nt:save', { note: payload(view) }).then((result) => {
      view.creating = null;
      if (!result?.ok) {
        dropView(view);
        if (result?.error !== 'locked') toast(result?.error || 'Catatan gagal disimpan.');
        return;
      }
      notes.delete(view.key);
      view.key = result.note.id;
      view.data = { ...view.data, ...result.note, text: view.text.value };
      notes.set(view.key, view);
      view.el.querySelector('.date').textContent = fmtDate(result.note.updated);
      // Typed while the first save was on its way.
      if (view.text.value !== result.note.text) saveSoon(view);
    });
    return view;
  }

  function setHidden(value) {
    hidden = value;
    host.style.display = hidden ? 'none' : 'block';
  }

  function setIcons(value) {
    icons = value;
    for (const view of notes.values()) {
      view.opened = false;
      paint(view);
    }
  }

  function focusNote(id) {
    const view = notes.get(id);
    if (!view) return false;
    if (hidden) setHidden(false);
    view.opened = true;
    paint(view);
    toFront(view);
    if (!view.data.pinned) view.el.scrollIntoView({ behavior: animated() ? 'smooth' : 'auto', block: 'center', inline: 'nearest' });
    view.el.classList.remove('enter', 'appear', 'flash');
    void view.el.offsetWidth;
    view.el.classList.add('flash');
    setTimeout(() => view.text.focus({ preventScroll: true }), animated() ? 400 : 0);
    return true;
  }

  let toastTimer = null;
  function toast(message, { action, onAction } = {}) {
    shadow.querySelector('.toast')?.remove();
    clearTimeout(toastTimer);
    const box = document.createElement('div');
    box.className = 'toast';
    box.setAttribute('role', 'status');
    const label = document.createElement('span');
    label.textContent = message;
    const button = document.createElement('button');
    button.type = 'button';
    button.hidden = !action;
    button.textContent = action || '';
    button.addEventListener('click', () => {
      box.remove();
      onAction?.();
    }, { once: true });
    box.append(label, button);
    shadow.append(box);
    mount();
    toastTimer = setTimeout(() => box.remove(), action ? 6000 : 2600);
  }

  // Draws the stored notes; a note being typed in keeps what is on screen.
  async function load({ fresh = false } = {}) {
    const result = await send('nt:load');
    if (!alive) return;
    if (!result?.ok || !result.enabled) {
      for (const view of [...notes.values()]) dropView(view, { animate: false });
      return;
    }
    applySettings(result.settings, result.motion);
    if (fresh || result.url !== pageUrl) {
      for (const view of [...notes.values()]) dropView(view, { animate: false });
      pageUrl = result.url;
    }
    const incoming = new Map(result.notes.map((n) => [n.id, n]));
    for (const view of [...notes.values()]) {
      if (typeof view.key === 'symbol') continue;
      if (!incoming.has(view.key)) dropView(view);
    }
    for (const data of result.notes) {
      topZ = Math.max(topZ, data.z || 1);
      const view = notes.get(data.id);
      if (!view) {
        addView(data);
        continue;
      }
      if (shadow.activeElement === view.text || view.saveTimer || view.el.classList.contains('dragging')) continue;
      view.data = { ...data };
      if (view.text.value !== data.text) view.text.value = data.text;
      paint(view);
    }
  }

  // ---------- wiring ----------

  const onContextMenu = (e) => { lastPointer = { x: e.pageX, y: e.pageY }; };
  const onPointerDown = (e) => { if (!e.composedPath().includes(host)) closeMenus(); };
  const onPageHide = () => {
    for (const view of notes.values()) if (view.saveTimer) save(view);
  };
  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pagehide', onPageHide);

  const onMessage = (message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || typeof message?.type !== 'string') return false;
    const reply = (value) => { sendResponse(value); return false; };
    switch (message.type) {
      case 'nt:ping': return reply({ ok: true });
      case 'nt:state': return reply({ ok: true, hidden, icons });
      case 'nt:new': createNote(message); return reply({ ok: true });
      case 'nt:toggleHidden': setHidden(!hidden); return reply({ ok: true, hidden });
      case 'nt:toggleIcons': if (hidden) setHidden(false); setIcons(!icons); return reply({ ok: true, icons });
      case 'nt:focus': return reply({ ok: focusNote(message.id) });
      case 'nt:refresh': load(); return reply({ ok: true });
      case 'nt:urlChanged': load({ fresh: true }); return reply({ ok: true });
      case 'nt:off': destroy(); return reply({ ok: true });
      default: return false;
    }
  };
  chrome.runtime.onMessage.addListener(onMessage);

  function destroy() {
    if (!alive) return;
    alive = false;
    for (const view of notes.values()) clearTimeout(view.saveTimer);
    notes.clear();
    host.remove();
    document.removeEventListener('contextmenu', onContextMenu, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pagehide', onPageHide);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* context gone */ }
    if (window.__mcuNotes?.shadow === shadow) delete window.__mcuNotes;
  }

  // Visible to this extension's isolated world only (used by the E2E tests), never to the site.
  window.__mcuNotes = { destroy, shadow };
  load();
})();
