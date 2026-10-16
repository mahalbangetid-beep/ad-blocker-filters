// Settings sections "Umum" (appearance, module switches) and "Tentang" (version, principles).
import { h, row, toggleRow, segment, itemText, rowMsg, showMsg, errorText, button } from './core/settings-ui.js';
import { getModuleStates, onModuleStatesChanged } from './core/modules.js';
import { readAppearance, watchAppearance } from './ui/appearance.js';
import { icon, logo } from './ui/icons.js';

const THEMES = [['auto', 'Otomatis'], ['light', 'Terang'], ['dark', 'Gelap']];
const MOTIONS = [['full', 'Penuh'], ['balanced', 'Seimbang'], ['minimal', 'Minim']];
const ACCENTS = [['solar', 'Surya'], ['ion', 'Ion'], ['nova', 'Nova']];
const label = (list, v) => list.find(([id]) => id === v)?.[1] || v;

const MODULE_ROWS = [
  { id: 'adblock', title: 'Modul Ad Blocker', desc: 'Memblokir iklan, pelacak, dan situs berbahaya.' },
  { id: 'tabs', title: 'Modul Tab Manager', desc: 'Dashboard ruang dan koleksi yang menggantikan halaman New Tab.' },
];

const lockDesc = (on) => (on
  ? 'Aktif. Mematikannya butuh password saat ini; selama aktif, semua modul baru bisa dipakai setelah browser dibuka dengan password.'
  : 'Nonaktif. Browser tidak dikunci; password tetap tersimpan.');

export const general = {
  summary: { sub: 'Tema, animasi, modul', desc: 'Tampilan seluruh extension dan modul yang aktif.' },

  async render(root, ctx) {
    const [appearance, states] = await Promise.all([readAppearance(), getModuleStates()]);

    // Saves one appearance key; the page itself follows through storage.onChanged.
    const saveAppearance = async (item, patch) => {
      showMsg(rowMsg(item), '');
      const result = await ctx.send('core:setAppearance', { patch }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
      if (!result?.ok) {
        showMsg(rowMsg(item), errorText(result));
        return false;
      }
      ctx.markSaved();
      return true;
    };

    const themeItem = row({ title: 'Tema', desc: 'Gelap: luar angkasa malam. Terang: langit fajar dengan aurora lembut. Otomatis mengikuti tema sistem.' });
    const theme = segment({
      id: 'theme', label: 'Tema', options: THEMES, value: appearance.theme,
      onPick: async (v) => {
        const ok = await saveAppearance(themeItem, { theme: v });
        if (ok) {
          const light = v === 'light' || (v === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
          ctx.toast(`Tema: ${label(THEMES, v)}`, { icon: light ? 'sun' : 'moon' });
        }
        return ok;
      },
    });
    themeItem.append(theme.el);

    const motionItem = row({ title: 'Tingkat animasi', desc: 'Penuh: semua elemen bergerak. Seimbang: animasi inti saja. Minim: hampir tanpa gerak, untuk komputer lambat atau mata yang mudah lelah.' });
    const motion = segment({
      id: 'motion', label: 'Tingkat animasi', options: MOTIONS, value: appearance.motion,
      onPick: async (v) => {
        const ok = await saveAppearance(motionItem, { motion: v });
        if (ok) ctx.toast(`Tingkat animasi: ${label(MOTIONS, v)}`, { icon: 'sparkle' });
        return ok;
      },
    });
    motionItem.append(motion.el);

    const accentItem = row({ title: 'Warna aksen', desc: 'Dipakai tombol utama, sorotan, dan penanda halaman aktif.' });
    const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Warna aksen' },
      ACCENTS.map(([id, name]) => h('button', {
        type: 'button', class: 'swatch', role: 'radio', 'aria-label': name, title: name, style: `--c: var(--${id})`, dataset: { id },
      })));
    const setAccent = (id) => {
      for (const b of swatches.children) {
        b.setAttribute('aria-checked', String(b.dataset.id === id));
        b.tabIndex = b.dataset.id === id ? 0 : -1;
      }
    };
    setAccent(appearance.accent);
    swatches.addEventListener('click', async (e) => {
      const b = e.target.closest('.swatch');
      if (!b || b.getAttribute('aria-checked') === 'true') return;
      const prev = swatches.querySelector('[aria-checked="true"]')?.dataset.id;
      setAccent(b.dataset.id);
      if (!(await saveAppearance(accentItem, { accent: b.dataset.id }))) return setAccent(prev);
      ctx.burst(b, 20, [getComputedStyle(b).backgroundColor, getComputedStyle(document.documentElement).getPropertyValue('--star').trim()]);
    });
    swatches.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const all = [...swatches.children];
      const next = all[(all.findIndex((b) => b.getAttribute('aria-checked') === 'true') + step + all.length) % all.length];
      next.focus();
      next.click();
    });
    accentItem.append(swatches);

    const welcome = toggleRow(ctx, {
      id: 'opt-welcome', title: 'Animasi sambutan', checked: appearance.welcome,
      desc: 'Tampilkan "Welcome to My Chrome Universe" setiap kali browser dibuka.',
      save: (on) => ctx.send('core:setAppearance', { patch: { welcome: on } }),
    });

    const modules = MODULE_ROWS.map((m) => toggleRow(ctx, {
      id: `mod-${m.id}`, title: m.title, desc: m.desc, checked: states[m.id], data: { mod: m.id },
      save: async (on) => {
        const result = await ctx.send('core:setModule', { id: m.id, enabled: on });
        if (result?.ok) ctx.toast(`${m.title.replace('Modul ', '')} ${on ? 'diaktifkan' : 'dimatikan'}`, { icon: on ? 'check' : 'pause' });
        return result;
      },
    }));

    // Browser Lock is switched in its own section (turning it off needs the password).
    const lockStatus = h('span', { class: 'item-desc' }, lockDesc(states.lock));
    const lockItem = h('div', { class: 'item' }, itemText('Modul Browser Lock', lockStatus),
      button('Atur', { ic: 'lock', onclick: () => ctx.goto('lock') }));

    root.replaceChildren(themeItem, motionItem, accentItem, welcome.item, ...modules.map((m) => m.item), lockItem);

    // Changes made elsewhere (dashboard theme button, popup switches) show up here too.
    watchAppearance((a) => {
      theme.set(a.theme);
      motion.set(a.motion);
      setAccent(a.accent);
      welcome.input.checked = a.welcome;
    });
    onModuleStatesChanged((next) => {
      MODULE_ROWS.forEach((m, i) => { modules[i].input.checked = next[m.id]; });
      lockStatus.textContent = lockDesc(next.lock);
    });
  },
};

// Feed version actually in use: a downloaded update when there is one, else the bundled rules.
async function feedVersion(send) {
  const data = await send('ab:getOptions').catch(() => null);
  if (data?.ok) {
    const feed = data.feed || {};
    return feed.feedVersion && feed.status !== 'current' ? feed.feedVersion : data.bundleVersion;
  }
  const lists = await fetch(chrome.runtime.getURL('modules/adblock/lists.json')).then((r) => r.json()).catch(() => null);
  return lists?.feedVersion || '–';
}

export const about = {
  summary: {
    sub: `Versi ${chrome.runtime.getManifest().version}`,
    desc: 'Satu extension untuk mengunci, merapikan, dan membersihkan browser.',
  },

  async render(root, ctx) {
    const manifest = chrome.runtime.getManifest();
    const feed = await feedVersion(ctx.send);
    const principles = ['Lokal, tanpa akun', 'Tanpa telemetri', 'Tanpa "Acceptable Ads"', 'Sumber filter berlisensi jelas'];
    const item = h('div', { class: 'item block', style: 'padding:0' },
      h('div', { class: 'about' }, logo(),
        h('div', {}, h('h3', {}, manifest.name),
          h('p', {}, `Versi ${manifest.version} · feed filter ${feed} · Manifest V${manifest.manifest_version}`))),
      h('div', { class: 'principles' }, principles.map((p) => h('span', {}, icon('check'), p))));
    item.dataset.searchExtra = principles.join(' ').toLowerCase();
    const keys = row({
      title: 'Pintasan keyboard',
      desc: 'Kunci browser, simpan sesi, dan simpan tab aktif. Ubah tombolnya di halaman pintasan Chrome.',
      control: button('Atur pintasan', { ic: 'key', onclick: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) }),
      extra: 'shortcut',
    });
    root.replaceChildren(item, keys);
  },
};
