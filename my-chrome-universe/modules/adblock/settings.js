// Ad Blocker section of the settings page: filter lists (rule meter vs Chrome's safe limit),
// updates, allowlisted sites, custom filters, badge/YouTube/context menu, filter credits.
import { h, toggleRow, button, msgLine, showMsg, errorText, rowMsg, itemText, switchEl } from '../../core/settings-ui.js';
import { icon } from '../../ui/icons.js';
import { countUp, shake } from '../../ui/motion.js';

export const summary = { sub: 'Filter, situs diizinkan', desc: 'Daftar filter, pengecualian, dan filter buatanmu sendiri.' };

// Chrome guarantees this many static rules per extension; more may not load.
const SAFE_RULES = 30000;
const number = new Intl.NumberFormat('id-ID');
const dateTime = (iso) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '–');

function describeStats(stats, failed = []) {
  const skipped = Object.entries(stats.skipped || {});
  let text = `${stats.network} filter jaringan dan ${stats.cosmetic} filter elemen aktif.`;
  if (skipped.length) text += ` Dilewati: ${skipped.map(([reason, n]) => `${n} (${reason})`).join(', ')}.`;
  if (failed.length) text += ` ${failed.length} aturan ditolak Chrome.`;
  return text;
}

export async function render(root, ctx) {
  let data = await ctx.send('ab:getOptions');
  if (!data?.ok) throw new Error(errorText(data, 'Pengaturan Ad Blocker tidak bisa dibaca'));
  const refresh = async () => {
    const next = await ctx.send('ab:getOptions');
    if (next?.ok) data = next;
  };

  // ---------- filter lists ----------
  const updateStatus = h('span', { class: 'item-desc', id: 'update-status' });
  const updateBtn = h('button', { class: 'btn ghost sm rp refresh-btn', type: 'button', id: 'update-now' }, icon('refresh'), h('span', {}, 'Perbarui sekarang'));
  const ruleTotal = h('b', { id: 'rule-total' }, '0');
  const fill = h('i', { id: 'meter-fill' });
  const meter = h('div', { class: 'meter' },
    h('div', { class: 'meter-top' }, h('span', {}, ruleTotal, ' aturan aktif'), h('span', { class: 'faint', id: 'meter-limit' }, `batas aman Chrome ${number.format(SAFE_RULES)} aturan`)),
    h('div', { class: 'meter-bar' }, fill));
  const listBox = h('div', { class: 'lists', id: 'lists' });
  const listsItem = h('div', { class: 'item block' },
    h('div', { class: 'item-row' }, itemText('Daftar filter', updateStatus, { msgId: 'lists-msg' }), updateBtn),
    meter, listBox);
  listsItem.dataset.searchExtra = data.lists.map((l) => `${l.title} ${l.description}`).join(' ').toLowerCase();
  const listsMsg = rowMsg(listsItem);

  let lastTotal = null;
  function updateMeter() {
    const enabled = new Set(data.settings.enabledLists);
    const total = data.lists.filter((l) => enabled.has(l.id)).reduce((n, l) => n + (l.ruleCount || 0), 0);
    countUp(ruleTotal, total, lastTotal === null ? 900 : 700);
    fill.style.setProperty('--f', String(Math.min(1, total / SAFE_RULES)));
    const over = total > SAFE_RULES;
    meter.classList.toggle('over', over);
    meter.querySelector('#meter-limit').textContent = over
      ? `melebihi batas aman Chrome ${number.format(SAFE_RULES)} aturan`
      : `batas aman Chrome ${number.format(SAFE_RULES)} aturan`;
    if (over && lastTotal !== null && lastTotal <= SAFE_RULES) {
      ctx.toast(`Melebihi batas aman ${number.format(SAFE_RULES)} aturan. Sebagian aturan mungkin tidak dimuat Chrome.`, { icon: 'info' });
    }
    lastTotal = total;
  }

  // The wanted lists are read from the switches themselves (a reply for an earlier switch may still
  // be on its way), and saves go one at a time so an older list never lands last.
  let listQueue = Promise.resolve();
  const switchedOn = () => [...listBox.querySelectorAll('input[data-list]')].filter((i) => i.checked).map((i) => i.dataset.list);

  function renderLists() {
    const enabled = new Set(data.settings.enabledLists);
    listBox.replaceChildren(...data.lists.map((list) => {
      const id = `ab-list-${list.id}`;
      const { input, el } = switchEl({ id, checked: enabled.has(list.id), dataset: { list: list.id }, 'aria-label': list.title });
      input.addEventListener('change', async () => {
        showMsg(listsMsg, '');
        const run = listQueue.then(() => ctx.send('ab:saveSettings', { patch: { enabledLists: switchedOn() } }));
        listQueue = run.catch(() => {});
        const result = await run.catch((err) => ({ ok: false, error: String(err?.message || err) }));
        if (!result?.ok) {
          input.checked = !input.checked;
          return showMsg(listsMsg, errorText(result));
        }
        data.settings = result.settings;
        updateMeter();
        ctx.markSaved();
      });
      const meta = [
        `${number.format(list.networkFilters)} filter jaringan`,
        `${number.format(list.cosmeticFilters)} filter elemen`,
        list.version && `versi ${list.version}`,
        (list.sources || []).length && `Sumber: ${list.sources.map((s) => s.title).join(', ')}`,
      ].filter(Boolean).join(' · ');
      return h('label', { for: id },
        h('span', { class: 'lt' }, h('b', {}, list.title), h('span', {}, list.description), h('span', { class: 'meta' }, meta)),
        h('span', { class: 'n', title: 'aturan' }, number.format(list.ruleCount || 0)),
        el);
    }));
  }

  function renderUpdate() {
    const feed = data.feed || {};
    const version = feed.feedVersion && feed.status !== 'current' ? feed.feedVersion : data.bundleVersion;
    let text = `Versi filter ${version || '–'} · dicek ${dateTime(feed.checkedAt)}`;
    if (feed.status === 'current') text += ' · filter bawaan sudah yang terbaru';
    if (feed.status === 'updated') text += ` · diperbarui ${dateTime(feed.updatedAt)}`;
    if (feed.error) text += ` · ${feed.status === 'error' ? 'gagal' : 'catatan'}: ${feed.error}`;
    updateStatus.textContent = text;
    updateStatus.classList.toggle('err', feed.status === 'error');
    updateSource.textContent = `Sumber: ${data.feedUrl || '(tidak ada)'}`;
    autoUpdate.input.checked = data.settings.autoUpdate;
  }

  updateBtn.addEventListener('click', async () => {
    if (updateBtn.classList.contains('busy')) return;
    showMsg(listsMsg, '');
    updateBtn.classList.add('busy');
    updateBtn.disabled = true;
    updateBtn.lastChild.textContent = 'Memperbarui…';
    const result = await ctx.send('ab:updateFilters');
    await refresh();
    renderUpdate();
    renderLists();
    updateMeter();
    updateBtn.classList.remove('busy');
    updateBtn.disabled = false;
    updateBtn.lastChild.textContent = 'Perbarui sekarang';
    if (!result?.ok) return showMsg(listsMsg, `Gagal memperbarui: ${errorText(result, 'feed tidak bisa diambil')}`);
    ctx.markSaved();
    ctx.toast('Daftar filter sudah versi terbaru', { icon: 'refresh' });
  });

  const updateSource = h('span', { class: 'item-desc', id: 'update-source' });
  const autoUpdate = toggleRow(ctx, {
    id: 'opt-autoupdate', title: 'Perbarui filter otomatis setiap hari', checked: data.settings.autoUpdate, desc: updateSource,
    save: (on) => ctx.send('ab:saveSettings', { patch: { autoUpdate: on } }),
  });
  autoUpdate.item.dataset.searchExtra = 'feed update github';

  // ---------- allowlist ----------
  const allowInput = h('input', { class: 'input', id: 'allow-input', placeholder: 'contoh: detik.com', 'aria-label': 'Domain yang diizinkan', autocomplete: 'off' });
  const allowForm = h('form', { class: 'inline-form', id: 'allow-form' }, allowInput,
    h('button', { class: 'btn primary sm rp', type: 'submit' }, icon('plus'), 'Tambah'));
  const chips = h('div', { class: 'chips', id: 'allowlist' });
  const allowMsg = msgLine('allow-msg');
  const allowItem = h('div', { class: 'item block' },
    itemText('Situs diizinkan', 'Iklan tidak diblokir di situs ini (termasuk subdomainnya). Berguna untuk situs bank atau toko yang rusak bila iklan diblokir.'),
    allowForm, allowMsg, chips);
  allowItem.dataset.searchExtra = 'allowlist pengecualian domain';

  function renderAllowlist(fresh = null) {
    const list = data.settings.allowlist;
    if (!list.length) return chips.replaceChildren(h('span', { class: 'chips-empty' }, 'Belum ada situs yang diizinkan.'));
    chips.replaceChildren(...list.map((domain) => {
      const remove = h('button', { class: 'icon-btn xs', type: 'button', 'aria-label': `Hapus ${domain}`, title: 'Hapus' }, icon('x'));
      const chip = h('span', { class: `domain-chip${domain === fresh ? ' fresh' : ''}` }, h('span', {}, domain), remove);
      remove.addEventListener('click', async () => {
        showMsg(allowMsg, '');
        chip.classList.add('out');
        const [result] = await Promise.all([
          ctx.send('ab:allowlistRemove', { domain }),
          new Promise((r) => { setTimeout(r, 260); }),
        ]);
        if (!result?.ok) {
          chip.classList.remove('out');
          return showMsg(allowMsg, errorText(result));
        }
        await refresh();
        renderAllowlist();
        ctx.markSaved();
      });
      return chip;
    }));
  }

  allowForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showMsg(allowMsg, '');
    const result = await ctx.send('ab:allowlistAdd', { domain: allowInput.value });
    if (!result?.ok) {
      allowInput.classList.add('err');
      shake(allowInput);
      return showMsg(allowMsg, errorText(result));
    }
    allowInput.classList.remove('err');
    allowInput.value = '';
    const before = new Set(data.settings.allowlist);
    await refresh();
    renderAllowlist(data.settings.allowlist.find((d) => !before.has(d)));
    ctx.markSaved();
  });
  allowInput.addEventListener('input', () => allowInput.classList.remove('err'));

  // ---------- custom filters ----------
  const custom = h('textarea', {
    class: 'input', id: 'custom', spellcheck: 'false', 'aria-label': 'Filter saya',
    placeholder: '||iklan.contoh.com^\ncontoh.com##.banner-iklan\n@@||situs-baik.com^$document',
  });
  custom.value = data.settings.customFilters;
  const customMsg = h('span', { class: 'st-msg', id: 'custom-msg', role: 'status' });
  const saveCustom = button('Simpan filter', { id: 'save-custom', ic: 'check', cls: 'btn primary sm rp' });
  const code = (t) => h('code', {}, t);
  const customItem = h('div', { class: 'item block' },
    itemText('Filter saya', 'Satu filter per baris, sintaks Adblock Plus. Filter dari "Blokir elemen" juga tersimpan di sini. Filter yang tidak bisa diterjemahkan dengan tepat dilewati dan dihitung.'),
    custom,
    h('div', { class: 'form-foot' }, customMsg, saveCustom),
    h('p', { class: 'help' },
      code('||domain.com^'), ' blokir semua permintaan ke domain itu · ',
      code('/iklan/*.gif'), ' blokir URL yang cocok · ',
      code('||cdn.com^$script,third-party'), ' hanya skrip pihak ketiga · ',
      code('situs.com##.kelas'), ' sembunyikan elemen di situs itu · ',
      code('##.kelas'), ' sembunyikan di semua situs · ',
      code('@@||situs.com^$document'), ' izinkan seluruh situs.'));
  customItem.dataset.searchExtra = 'custom adblock plus sintaks';
  if (data.settings.customFilters.trim()) customMsg.textContent = describeStats(data.custom);
  saveCustom.addEventListener('click', async () => {
    const result = await ctx.send('ab:saveCustomFilters', { text: custom.value });
    customMsg.classList.remove('err');
    if (!result?.ok) {
      customMsg.classList.add('err');
      customMsg.textContent = errorText(result);
      return;
    }
    const problem = Object.keys(result.stats.skipped || {}).length || result.failed.length;
    customMsg.classList.toggle('err', !!problem);
    customMsg.textContent = `Tersimpan. ${describeStats(result.stats, result.failed)}`;
    ctx.burst(saveCustom, 18);
    ctx.markSaved();
  });

  // ---------- behaviour switches ----------
  const setting = (key) => (on) => ctx.send('ab:saveSettings', { patch: { [key]: on } });
  const badge = toggleRow(ctx, { id: 'opt-badge', title: 'Jumlah iklan diblokir di ikon', desc: 'Angka kecil di ikon toolbar untuk tab yang aktif.', checked: data.settings.showBadge, save: setting('showBadge') });
  const youtube = toggleRow(ctx, { id: 'opt-youtube', title: 'Blokir iklan video YouTube', desc: 'Membuang jadwal iklan dari data pemutar, dan melewati iklan yang tetap muncul.', checked: data.settings.youtube, save: setting('youtube') });
  const menu = toggleRow(ctx, { id: 'opt-menu', title: 'Menu klik kanan "Blokir elemen…"', desc: 'Sembunyikan elemen di halaman lewat klik kanan.', checked: data.settings.contextMenu, save: setting('contextMenu') });

  // ---------- about / credits ----------
  const sources = new Map();
  for (const list of data.lists) for (const s of list.sources || []) sources.set(s.title, s);
  const credits = h('div', { class: 'credits', id: 'credits' }, [...sources.values()].map((s) => h('div', { class: 'credit' },
    h('b', {}, s.title),
    h('a', { href: s.homepage, target: '_blank', rel: 'noopener' }, s.homepage),
    h('span', {}, `lisensi ${s.license}`))));
  const built = h('p', { class: 'note', id: 'built' });
  const total = h('b', { id: 'total' }, `${number.format(data.totalBlocked)} permintaan diblokir sejak dipasang`);
  const aboutItem = h('div', { class: 'item block' },
    itemText('Cara kerja dan sumber filter', h('span', { class: 'item-desc' },
      'Pemblokir iklan lokal yang meniru cara kerja Adblock Plus: filter list dikompilasi menjadi aturan declarativeNetRequest Chrome, dan penyembunyian elemen memakai CSS. Tidak ada "iklan yang diizinkan", tidak ada akun, dan tidak ada data yang dikirim ke mana pun. ',
      total, '.')),
    credits, built);
  aboutItem.dataset.searchExtra = 'kredit lisensi tentang statistik';
  fetch(chrome.runtime.getURL('modules/adblock/lists.json')).then((r) => r.json()).then((lists) => {
    built.textContent = `Filter list bawaan dikompilasi ${new Date(lists.builtAt).toLocaleString('id-ID')} (feed ${lists.feedVersion}). Perbarui dengan menjalankan filter-bot/bot.mjs --update-extension lalu muat ulang extension.`;
  }).catch(() => {});

  root.replaceChildren(listsItem, autoUpdate.item, allowItem, customItem, badge.item, youtube.item, menu.item, aboutItem);
  renderLists();
  renderUpdate();
  renderAllowlist();
  // The meter counts up once the section is on screen (the page reveals after every section rendered).
  requestAnimationFrame(updateMeter);
}
