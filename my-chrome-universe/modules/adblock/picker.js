// "Block element" picker, injected on demand with chrome.scripting.executeScript.
// Hover to highlight, click to select, adjust how broad the selector is, then
// save it as a "domain##selector" filter.
(() => {
  if (window.__abPicker) return;
  window.__abPicker = true;

  const host = document.createElement('ab-picker');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      .box { position: fixed; pointer-events: none; background: rgba(198, 40, 40, .18); outline: 2px solid #c62828; border-radius: 2px; transition: all .05s; }
      .box.preview { background: rgba(198, 40, 40, .45); }
      .panel {
        position: fixed; right: 16px; bottom: 16px; width: min(380px, calc(100vw - 32px));
        pointer-events: auto; font: 13px/1.4 system-ui, sans-serif; color: #1f1f22;
        background: #fff; border: 1px solid #ddd; border-radius: 12px; padding: 14px;
        box-shadow: 0 10px 30px rgba(0,0,0,.25);
      }
      .panel h1 { font-size: 15px; margin: 0 0 6px; }
      .panel p { margin: 0 0 8px; color: #5f6672; }
      .panel input[type=text] { width: 100%; box-sizing: border-box; font: 12px ui-monospace, monospace; padding: 7px 8px; border: 1px solid #ccc; border-radius: 7px; }
      .panel input[type=range] { width: 100%; }
      .row { display: flex; gap: 8px; margin-top: 10px; }
      button { flex: 1; font: inherit; font-weight: 600; padding: 8px; border-radius: 8px; border: 1px solid #ccc; background: #fff; cursor: pointer; }
      button.primary { background: #c62828; border-color: #c62828; color: #fff; }
      button:disabled { opacity: .5; cursor: not-allowed; }
      .count { font-size: 12px; color: #5f6672; margin-top: 4px; }
      @media (prefers-color-scheme: dark) {
        .panel { background: #23252a; color: #eceef2; border-color: #3a3d44; }
        .panel p, .count { color: #a3a9b4; }
        .panel input[type=text], button { background: #1b1d21; color: #eceef2; border-color: #454952; }
      }
    </style>
    <div class="panel">
      <h1>Blokir elemen</h1>
      <p class="hint">Arahkan kursor ke iklan atau elemen yang ingin disembunyikan, lalu klik. Tekan Esc untuk batal.</p>
      <div class="editor" hidden>
        <label>Cakupan <input type="range" class="depth" min="0" max="0" value="0"></label>
        <input type="text" class="selector" spellcheck="false">
        <div class="count"></div>
      </div>
      <div class="row">
        <button class="cancel">Batal</button>
        <button class="preview-btn" disabled>Pratinjau</button>
        <button class="primary block" disabled>Blokir</button>
      </div>
    </div>`;
  const box = document.createElement('div');
  box.className = 'box';
  shadow.append(box);
  document.documentElement.append(host);

  const $ = (sel) => shadow.querySelector(sel);
  const panel = $('.panel');
  const input = $('.selector');
  const depth = $('.depth');
  const count = $('.count');

  let picking = true;
  let chain = []; // selected element followed by its ancestors
  let previewStyle = null;

  function highlight(el, preview = false) {
    if (!el) {
      box.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    box.classList.toggle('preview', preview);
  }

  function elementAt(x, y) {
    host.style.display = 'none';
    const el = document.elementFromPoint(x, y);
    host.style.display = '';
    return el && el !== document.documentElement && el !== document.body ? el : null;
  }

  // Stable-looking class names only: skip ones that look generated (long hex/digit runs).
  function usefulClasses(el) {
    return [...el.classList].filter((c) => c.length < 40 && !/\d{4,}|[a-f0-9]{8,}/i.test(c)).slice(0, 3);
  }

  function partFor(el) {
    if (el.id && !/\d{4,}/.test(el.id)) return `#${CSS.escape(el.id)}`;
    let part = el.localName;
    for (const attr of ['src', 'href']) {
      const value = el.getAttribute(attr);
      if (value && value.length < 200 && (el.localName === 'iframe' || el.localName === 'img' || el.localName === 'a')) {
        return `${part}[${attr}="${value.replace(/"/g, '\\"')}"]`;
      }
    }
    const classes = usefulClasses(el);
    if (classes.length) part += classes.map((c) => `.${CSS.escape(c)}`).join('');
    return part;
  }

  // Builds a selector for el, adding ancestors until it is reasonably specific.
  function selectorFor(el) {
    let selector = partFor(el);
    let node = el;
    let guard = 0;
    while (document.querySelectorAll(selector).length > 1 && node.parentElement && node.parentElement !== document.body && guard++ < 4) {
      const parent = node.parentElement;
      const siblings = [...parent.children].filter((c) => c.localName === node.localName);
      if (siblings.length > 1 && !selector.startsWith('#')) {
        selector = selector.replace(/^[^ >]+/, (first) => `${first}:nth-of-type(${siblings.indexOf(node) + 1})`);
      }
      node = parent;
      selector = `${partFor(node)} > ${selector}`;
      if (selector.startsWith('#')) break;
    }
    return selector;
  }

  function matches(selector) {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return -1;
    }
  }

  function updateCount() {
    const n = matches(input.value);
    count.textContent = n < 0 ? 'Selector tidak valid' : `${n} elemen cocok`;
    $('.block').disabled = n <= 0;
    $('.preview-btn').disabled = n <= 0;
  }

  function select(el) {
    picking = false;
    chain = [];
    for (let n = el; n && n !== document.body && n !== document.documentElement && chain.length < 6; n = n.parentElement) chain.push(n);
    depth.max = String(chain.length - 1);
    depth.value = '0';
    $('.hint').textContent = 'Geser "Cakupan" untuk memilih elemen pembungkus yang lebih besar, atau ubah selector-nya.';
    $('.editor').hidden = false;
    applyDepth();
  }

  function applyDepth() {
    const el = chain[Number(depth.value)];
    input.value = selectorFor(el);
    highlight(el);
    updateCount();
  }

  function togglePreview() {
    if (previewStyle) {
      previewStyle.remove();
      previewStyle = null;
      $('.preview-btn').textContent = 'Pratinjau';
      return;
    }
    previewStyle = document.createElement('style');
    previewStyle.textContent = `${input.value} { display: none !important; }`;
    document.documentElement.append(previewStyle);
    $('.preview-btn').textContent = 'Batal pratinjau';
  }

  function close() {
    previewStyle?.remove();
    host.remove();
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.__abPicker = false;
  }

  function onMove(e) {
    if (picking) highlight(elementAt(e.clientX, e.clientY));
  }

  function onClick(e) {
    if (!picking || e.composedPath().includes(host)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = elementAt(e.clientX, e.clientY);
    if (el) select(el);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  panel.addEventListener('click', (e) => e.stopPropagation());
  depth.addEventListener('input', applyDepth);
  input.addEventListener('input', () => {
    updateCount();
    try {
      highlight(document.querySelector(input.value));
    } catch {
      highlight(null);
    }
  });
  $('.cancel').addEventListener('click', close);
  $('.preview-btn').addEventListener('click', togglePreview);
  $('.block').addEventListener('click', async () => {
    const selector = input.value.trim();
    if (matches(selector) <= 0) return;
    const domain = location.hostname.replace(/^www\./, '');
    const result = await chrome.runtime.sendMessage({ type: 'ab:addFilter', filter: `${domain}##${selector}` });
    if (result?.ok) close();
    else count.textContent = result?.error || 'Gagal menyimpan filter';
  });
})();
