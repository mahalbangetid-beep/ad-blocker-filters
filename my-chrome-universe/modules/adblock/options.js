const $ = (id) => document.getElementById(id);
const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });
const number = new Intl.NumberFormat('id-ID');

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

function message(el, text, kind = 'ok') {
  el.textContent = text;
  el.className = `msg ${kind}`;
}

let data = await send('ab:getOptions');

// ---------- Tabs ----------

const tabs = [...document.querySelectorAll('nav button')];
function showTab(name) {
  for (const b of tabs) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of document.querySelectorAll('section')) s.hidden = s.id !== `tab-${name}`;
  history.replaceState(null, '', `#${name}`);
}
for (const b of tabs) b.addEventListener('click', () => showTab(b.dataset.tab));
if (location.hash.slice(1) && $(`tab-${location.hash.slice(1)}`)) showTab(location.hash.slice(1));

// ---------- Filter lists ----------

function renderLists() {
  const enabled = new Set(data.settings.enabledLists);
  $('lists').replaceChildren(...data.lists.map((list) => {
    const input = h('input', { type: 'checkbox', checked: enabled.has(list.id), 'aria-label': list.title });
    input.addEventListener('change', async () => {
      const next = new Set(data.settings.enabledLists);
      if (input.checked) next.add(list.id);
      else next.delete(list.id);
      const result = await send('ab:saveSettings', { patch: { enabledLists: [...next] } });
      if (result.ok) data.settings = result.settings;
      else input.checked = !input.checked;
    });
    return h('label', { class: 'item' },
      h('span', { class: 'text' },
        h('span', { class: 'title' }, list.title),
        h('span', { class: 'desc' }, ` — ${list.description}`),
        h('div', { class: 'desc' }, `${number.format(list.networkFilters)} filter jaringan · ${number.format(list.cosmeticFilters)} filter elemen`,
          list.version ? ` · versi ${list.version}` : ''),
        h('div', { class: 'desc' }, `Sumber: ${(list.sources || []).map((s) => s.title).join(', ')}`)),
      h('span', { class: 'switch' }, input, h('span')));
  }));
}

// ---------- Filter updates ----------

const dateTime = (iso) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '–');

function renderUpdate() {
  const feed = data.feed || {};
  const version = feed.feedVersion && feed.status !== 'current' ? feed.feedVersion : data.bundleVersion;
  let text = `Versi filter ${version || '–'} · dicek ${dateTime(feed.checkedAt)}`;
  if (feed.status === 'current') text += ' · filter bawaan sudah yang terbaru';
  if (feed.status === 'updated') text += ` · diperbarui ${dateTime(feed.updatedAt)}`;
  if (feed.error) text += ` · ${feed.status === 'error' ? 'gagal' : 'catatan'}: ${feed.error}`;
  $('update-status').textContent = text;
  $('update-status').style.color = feed.status === 'error' ? 'var(--accent)' : '';
  $('update-source').textContent = `Sumber: ${data.feedUrl || '(tidak ada)'}`;
  $('opt-autoupdate').checked = data.settings.autoUpdate;
}

$('opt-autoupdate').addEventListener('change', (e) => send('ab:saveSettings', { patch: { autoUpdate: e.target.checked } }));
$('update-now').addEventListener('click', async () => {
  const button = $('update-now');
  button.disabled = true;
  button.textContent = 'Memperbarui…';
  await send('ab:updateFilters');
  data = await send('ab:getOptions');
  renderUpdate();
  renderLists();
  button.disabled = false;
  button.textContent = 'Perbarui sekarang';
});

// ---------- Allowlist ----------

function renderAllowlist() {
  const list = data.settings.allowlist;
  $('allowlist').replaceChildren(...(list.length
    ? list.map((domain) => h('div', { class: 'item' },
      h('span', { class: 'text title' }, domain),
      h('button', {
        class: 'remove',
        onclick: async () => {
          await send('ab:allowlistRemove', { domain });
          data = await send('ab:getOptions');
          renderAllowlist();
        },
      }, 'Hapus')))
    : [h('div', { class: 'empty' }, 'Belum ada situs yang diizinkan.')]));
}

$('allow-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const result = await send('ab:allowlistAdd', { domain: $('allow-input').value });
  if (!result.ok) return message($('allow-msg'), result.error, 'error');
  $('allow-input').value = '';
  message($('allow-msg'), 'Situs ditambahkan.');
  data = await send('ab:getOptions');
  renderAllowlist();
});

// ---------- Custom filters ----------

function describeStats(stats, failed = []) {
  const skipped = Object.entries(stats.skipped || {});
  let text = `${stats.network} filter jaringan dan ${stats.cosmetic} filter elemen aktif.`;
  if (skipped.length) text += ` Dilewati: ${skipped.map(([reason, n]) => `${n} (${reason})`).join(', ')}.`;
  if (failed.length) text += ` ${failed.length} aturan ditolak Chrome.`;
  return text;
}

$('custom').value = data.settings.customFilters;
if (data.settings.customFilters.trim()) message($('custom-msg'), describeStats(data.custom));

$('save-custom').addEventListener('click', async () => {
  const result = await send('ab:saveCustomFilters', { text: $('custom').value });
  if (!result.ok) return message($('custom-msg'), result.error, 'error');
  const problem = Object.keys(result.stats.skipped).length || result.failed.length;
  message($('custom-msg'), `Tersimpan. ${describeStats(result.stats, result.failed)}`, problem ? 'error' : 'ok');
});

// ---------- General ----------

$('opt-badge').checked = data.settings.showBadge;
$('opt-menu').checked = data.settings.contextMenu;
$('opt-youtube').checked = data.settings.youtube;
$('opt-youtube').addEventListener('change', (e) => send('ab:saveSettings', { patch: { youtube: e.target.checked } }));
$('opt-badge').addEventListener('change', (e) => send('ab:saveSettings', { patch: { showBadge: e.target.checked } }));
$('opt-menu').addEventListener('change', (e) => send('ab:saveSettings', { patch: { contextMenu: e.target.checked } }));

// ---------- About ----------

const sources = new Map();
for (const list of data.lists) for (const s of list.sources || []) sources.set(s.title, s);
$('credits').replaceChildren(...[...sources.values()].map((s) => h('div', { class: 'item' },
  h('span', { class: 'text' },
    h('span', { class: 'title' }, s.title),
    h('div', { class: 'desc' }, h('a', { href: s.homepage, target: '_blank', rel: 'noopener' }, s.homepage), ` · lisensi ${s.license}`)))));
const lists = await fetch(chrome.runtime.getURL('lists.json')).then((r) => r.json());
$('built').textContent = `Filter list dikompilasi ${new Date(lists.builtAt).toLocaleString('id-ID')} (feed ${lists.feedVersion}). Perbarui dengan menjalankan filter-bot/bot.mjs --update-extension lalu muat ulang extension.`;

$('total').textContent = `${number.format(data.totalBlocked)} permintaan diblokir sejak dipasang`;

renderLists();
renderAllowlist();
renderUpdate();
