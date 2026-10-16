# Redesign Global "Universe" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ganti seluruh tampilan My Chrome Universe dengan sistem desain "Universe" (gelap "Malam" + terang "Fajar", penuh animasi) sesuai prototipe yang disetujui, tanpa menghilangkan fitur atau melemahkan gerbang kunci.

**Architecture:** Folder baru `my-chrome-universe/ui/` berisi token CSS dua tema, komponen, font lokal, ikon SVG, efek gerak, kanvas bintang, dan sambutan; semua halaman extension memakainya. Pengaturan tampilan disimpan di `core:appearance` (ditulis lewat `core:setAppearance`, dibaca langsung dari storage dan dicerminkan ke `localStorage` agar tema terpasang sebelum render pertama). Alur buka browser: layar kunci memutar sambutan (hanya setelah startup), lalu setelah unlock mengirim `lock:handoff` sehingga SW mengubah tab kunci itu sendiri menjadi dashboard.

**Tech Stack:** Chrome MV3, ES module murni, CSS custom properties, Canvas 2D, Web Animations API; tes `node --test` + E2E Chromium via CDP (`tests/universe.e2e.mjs`). Tanpa build step dan tanpa dependensi npm.

**Spec:** `docs/superpowers/specs/2026-10-16-global-redesign-design.md` — acuan visual dan perilaku gerak: `docs/superpowers/specs/assets/2026-10-16-universe-prototype.html` (salin nilai token, keyframe, markup, dan logika gerak dari sini; jangan menebak ulang).

## Global Constraints

- MV3, ES module murni, **tanpa build step dan tanpa dependensi npm**; SW tanpa top-level await; listener SW di top level; state di `chrome.storage`.
- Awalan namespace: `lock:`, `tm:`, `ab:`, `core:` untuk pesan dan kunci storage. Setiap `onMessage` memanggil `senderAllowed` + `messageAllowed`; menu hanya lewat `core/menus.js`.
- Setiap halaman extension selain layar kunci/setup `await guardPage(...)` **sebelum** membaca data modul atau memutar animasi yang memperlihatkan data.
- Tidak ada request ke host selain extension itu sendiri (tanpa Google Fonts/CDN). Font: Unbounded (500, 700), Plus Jakarta Sans (400, 500, 600, 700), JetBrains Mono (400, 500), woff2 subset latin + `OFL.txt`.
- Teks UI bahasa Indonesia; komentar kode ringkas bahasa Inggris; tanpa emoji sebagai ikon.
- Dua tema: `:root` = gelap, `:root[data-ui="light"]` = terang, nilai persis prototipe; komponen tidak memakai warna literal (selalu token). Teks kecil kontras ≥ 4,5:1 di kedua tema.
- Tingkat gerak `data-motion="full|balanced|minimal"`; `minimal` = durasi/delay animasi ≈ 0 dan kanvas digambar statis sekali; default `minimal` bila `prefers-reduced-motion`.
- Kanvas bintang berhenti saat `document.hidden`; DPR maks 2; mode `drift`/`calm` maks 30 fps.
- Pesan error, sisa percobaan, hitung mundur jeda, dan kode pemulihan tampil seketika (tidak menunggu animasi).
- Popup lebar 370 px (batas Chrome 800×600).
- Commit hanya bila pengguna sudah mengizinkan commit per tugas; bila belum, langkah "Commit" = `git add` saja. Pesan commit diakhiri `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Kerjakan di branch `universe-redesign`.

## Review Focus

1. **Data sebelum gerbang** — animasi masuk dashboard/popup/pengaturan tidak boleh merender data sebelum `guardPage` resolve; saat terkunci halaman tetap kosong (dijaga tes E2E gerbang kunci yang ada + Task 5, 6, 7, 8).
2. **Data besar** — ruang dengan ±400 tab dan judul/URL sangat panjang: tidak ada geser horizontal, dan stagger masuk dibatasi (hanya ±24 elemen pertama dianimasikan) agar New Tab tetap cepat (tes di Task 5).
3. **Tema/gerak berubah saat halaman terbuka** — mengubah tema di Pengaturan langsung mengubah dashboard dan popup yang sedang terbuka, tanpa reload (tes di Task 6).
4. **Minimal motion** — pada `minimal` tidak ada loop rAF kanvas, sambutan langsung menampilkan teks, dan pesan "Password salah" muncul seketika (tes di Task 4 dan Task 9).
5. **Handoff gagal** — layar kunci ditutup/crash sebelum mengirim `lock:handoff`: SW tetap menghasilkan dashboard aktif di akhir jendela dan tab pulih (tes di Task 3).

---

## File Structure

```
my-chrome-universe/
  ui/                         (baru) sistem desain bersama
    tokens.css                token 2 tema, font-face, tingkat gerak, aksen [data-accent]
    components.css            tombol, sakelar, input, toast, menu, dialog, ripple, glow, keyframe bersama, nebula
    fonts/*.woff2, OFL.txt
    boot.js                   skrip klasik di <head>: terapkan tema/gerak dari localStorage sebelum render
    appearance.js             normalize/read/apply/watch core:appearance, consumeWelcome
    icons.js                  ikon SVG + logo orbit
    motion.js                 wait/animate/countUp/shake/toast/efek ripple-glow-tilt
    sky.js                    kanvas bintang, nebula, warp, partikel teks, percikan
    welcome.js                adegan "Welcome to My Chrome Universe"
  core/background.js          + core:setAppearance, migrasi tema lama, flag sambutan
  core/modules.js             icon emoji → nama ikon; options → settings
  core/page-guard.js          pemberitahuan bergaya baru
  modules/lock/               lock.html/.js, setup.html/.js (desain baru), background.js (handoff), settings.js (baru), panel.js, options.html → pengalih
  modules/tabs/               newtab.html/.css/.js + dashboard/*.js (baru), panel.js, settings.js (baru)
  modules/adblock/            panel.js, settings.js (baru), options.html → pengalih, picker.js (gaya)
  popup.html/.css/.js         desain baru
  options.html/.js            halaman pengaturan tunggal + settings-general.js (Umum, Tentang)
  icons/                      PNG logo orbit
tools/make-icons.mjs          (baru) render PNG ikon dari SVG via Chromium
tests/ui.test.mjs             (baru) unit test ui/
```

---

### Task 1: Fondasi visual `ui/` (token, font, komponen, ikon)

**Files:**
- Create: `my-chrome-universe/ui/tokens.css`, `ui/components.css`, `ui/icons.js`, `ui/fonts/` (7 woff2 + `OFL.txt`), `tests/ui.test.mjs`, `tests/harness/ui-gallery.html`
- Modify: `CLAUDE.md` (perintah unit test: tambah `tests/ui.test.mjs`), `.github/workflows/filter-bot.yml` (tambah `tests/ui.test.mjs` ke langkah unit test)

**Interfaces:**
- Produces: token CSS (`--void --deep --panel --panel-solid --line --line-strong --star --dust --faint --solar --ion --nova --danger --ok --accent --accent-ink --accent-text --solar-text --ion-text --nova-text --ok-text --danger-text --tint --shade --shade-k --glass --void-rgb --scrim --scrim-k --line-rgb --fav-s --fav-l --chrome-0/1/2 --media-bg --ad-* --title-grad --neb-blend --neb-op --logo-ring --f-display --f-body --f-mono --ease-out --ease-in --spring --d1 --d2 --d3`); aksen lewat `:root[data-accent="ion"|"nova"]` (default solar) yang mengatur `--accent`, `--accent-text`, `--accent-ink` (`#1B1204`/`#04201B`/`#2A0710`); kelas komponen `.btn(.primary|.ghost|.danger|.sm|.block) .icon-btn(.sm|.xs) .sw .check .input .pill kbd .fav .glow .rp .ripple .toast .toasts .menu .menu-item .dialog .nebula .eyebrow .spin-hover`; keyframe `rise depth pop from-left from-right from-top spin breathe shimmer ripple`.
- Produces (`ui/icons.js`): `ICONS: Record<string,string>` (path SVG), `ic(name: string, cls?: string): string`, `icon(name: string, cls?: string): SVGSVGElement`, `logo(cls?: string): SVGSVGElement`, `hydrateIcons(root?: ParentNode): void` (ganti `<i data-ic="name">` dan `<svg data-logo>`). Set ikon = semua ikon di prototipe (`P`) + `sun moon edit undo folder group link`.

- [ ] **Step 1: Write the failing tests** di `tests/ui.test.mjs`:
  - `test('ui css has no external urls')`: setiap `url(` di `ui/*.css` menunjuk `fonts/…woff2`; tidak ada `http`.
  - `test('every font-face file exists')`: tiap `src: url(fonts/X.woff2)` ada di disk; `ui/fonts/OFL.txt` ada.
  - `test('light theme overrides every themed token')`: blok `:root[data-ui="light"]` mendefinisikan `--void --star --dust --faint --tint --glass --line-rgb --solar-text --ion-text --nova-text --title-grad --neb-blend`.
  - `test('text tokens meet 4.5:1 in both themes')`: hitung kontras WCAG dari nilai hex di `tokens.css` untuk `--star --dust --faint --solar-text --ion-text --nova-text --danger-text` terhadap `--void` dan `--panel-solid`, untuk tema gelap dan terang → semua ≥ 4.5.
  - `test('ic returns an svg with the icon path')`: `ic('lock')` diawali `<svg class="ic` dan memuat `class="shackle"`; `ic('nope')` tetap `<svg` kosong (tidak melempar).
  - `test('icons used in markup exist')`: kumpulkan semua `data-ic="…"` dan `ic('…')` dari `my-chrome-universe/**/*.{html,js}`; setiap nama ada di `ICONS`.
- [ ] **Step 2:** Run `node --test tests/ui.test.mjs` → FAIL (berkas belum ada).
- [ ] **Step 3: Unduh font** — skrip sekali pakai di scratchpad (bukan di repo): minta `https://fonts.googleapis.com/css2?family=Unbounded:wght@500;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap` dengan User-Agent Chrome desktop, ambil blok `/* latin */` saja, unduh woff2-nya ke `ui/fonts/` dengan nama `unbounded-500.woff2`, `plus-jakarta-sans-400.woff2`, dst. (bila satu file variabel melayani beberapa bobot, simpan sekali dan pakai `font-weight: 400 700`). `OFL.txt` dari `https://raw.githubusercontent.com/google/fonts/main/ofl/unbounded/OFL.txt` (+ salinan bagian copyright dua font lain di berkas yang sama).
- [ ] **Step 4: Tulis `tokens.css` dan `components.css`** dengan memindahkan blok CSS prototipe yang bersifat umum (token `:root` + `:root[data-ui="light"]`, aturan `[data-motion]`, kontrol bersama, keyframe, nebula). Tambah `@font-face` lokal (`font-display: swap`). CSS khusus halaman tetap di halaman masing-masing (tugas berikutnya).
- [ ] **Step 5: Tulis `ui/icons.js`** (ikon dari `P` prototipe + tambahan; logo = `LOGO` prototipe dengan `style="stroke:var(--logo-ring)"`, gradien inti didefinisikan di dalam SVG logo itu sendiri dengan id unik per instans).
- [ ] **Step 6: Galeri harness** `tests/harness/ui-gallery.html` (memuat `/my-chrome-universe/ui/*.css` dan `icons.js` lewat `node tests/harness/serve.mjs`) yang menampilkan semua komponen + tombol ganti `data-ui`/`data-accent`, untuk diperiksa mata.
- [ ] **Step 7:** Run `node --test tests/ui.test.mjs` → PASS; buka galeri di Chromium, ambil tangkapan layar gelap+terang, bandingkan dengan prototipe.
- [ ] **Step 8: Commit** — `git add my-chrome-universe/ui tests/ui.test.mjs tests/harness/ui-gallery.html CLAUDE.md .github/workflows/filter-bot.yml && git commit -m "Add the Universe design tokens, fonts, components and icons"`

### Task 2: Tampilan dan gerak bersama (`appearance.js`, `motion.js`, `sky.js`, `boot.js`) + `core:setAppearance`

**Files:**
- Create: `ui/appearance.js`, `ui/motion.js`, `ui/sky.js`, `ui/boot.js`
- Modify: `core/background.js`, `tests/core.test.mjs`, `tests/ui.test.mjs`

**Interfaces:**
- Produces (`ui/appearance.js`, aman diimpor SW — tidak menyentuh `document`/`matchMedia` saat impor):
  - `APPEARANCE_KEY = 'core:appearance'`, `WELCOME_KEY = 'core:welcome'` (storage.session), `MIRROR_KEY = 'mcu:appearance'` (localStorage)
  - `APPEARANCE_DEFAULTS = { theme: 'auto', motion: 'full', accent: 'solar', welcome: true }`
  - `normalizeAppearance(raw: unknown, opts?: { reducedMotion?: boolean }): { theme, motion, accent, welcome }` — nilai tak dikenal → default; `motion` tanpa nilai valid → `'minimal'` bila `reducedMotion`.
  - `readAppearance(): Promise<Appearance>`; `applyAppearance(a, root = document.documentElement): { light: boolean }` (set `data-ui`, `data-motion`, `data-accent`, tulis cermin `localStorage[MIRROR_KEY]`); `watchAppearance(cb: (a) => void): void` (storage.onChanged + perubahan `prefers-color-scheme`); `initAppearance(): Promise<Appearance>` (read → apply → watch yang re-apply); `consumeWelcome(): Promise<boolean>` (baca & hapus `WELCOME_KEY`, kembalikan `flag && appearance.welcome`).
- Produces (`ui/boot.js`, skrip klasik non-module, dimuat sinkron di `<head>` setiap halaman): baca `localStorage[MIRROR_KEY]` dan set atribut `data-ui/data-motion/data-accent` di `<html>` sebelum render (tema `auto` diselesaikan dengan `matchMedia`).
- Produces (`ui/motion.js`): `MOTION_SCALE = { full: 1, balanced: .75, minimal: 0 }`, `motionLevel(): 'full'|'balanced'|'minimal'`, `wait(ms): Promise<void>`, `animate(el, keyframes, opts): Animation` (durasi diskalakan), `countUp(el, to: number, ms = 1100): void` (format `id-ID`), `shake(el): void`, `toast(text: string, opts?: { icon?: string, action?: { label: string, run: () => void } }): void` (wadah `.toasts` dibuat malas, maks 3, hilang 4,2 dtk, `aria-live="polite"`), `installEffects(root = document): void` (ripple `.rp`, spotlight `.glow`, tilt `.tilt` hanya di `full`).
- Produces (`ui/sky.js`): `createSky(canvas: HTMLCanvasElement, opts?: { mode?: 'welcome'|'orbit'|'drift'|'calm', fxCanvas?: HTMLCanvasElement }): Sky` dengan `Sky = { setMode(m), warp(ms), reverse(ms), buildText(el), scatter(), burst(x, y, n?, colors?), burstAt(el, n?, colors?), running: boolean, destroy() }`; mengikuti `data-ui` dan `data-motion` lewat `MutationObserver` pada `<html>`; logika bintang/partikel/percikan dari objek `sky` prototipe.
- Catatan: spesifikasi menyebut `core:getAppearance` publik; diganti pembacaan langsung `chrome.storage.local` dari halaman (pola yang sama dengan `core/gate.js`), jadi tidak ada pesan publik baru.
- Produces (`core/background.js`): pesan `core:setAppearance({ patch }) → { ok: true, appearance }` (digabung dengan nilai tersimpan lalu `normalizeAppearance`, **tidak** publik); `onStartup` dan `onInstalled(reason 'install')` menulis `chrome.storage.session[WELCOME_KEY] = true`; `migrateAppearance(): Promise<void>` dipanggil di top level (tanpa await) — bila `core:appearance` belum ada dan `tm:data.settings.theme ∈ {auto, light, dark}`, simpan `{ ...APPEARANCE_DEFAULTS, theme }`.

- [ ] **Step 1: Write the failing tests**
  - `tests/ui.test.mjs`: `test('normalizeAppearance fills defaults and rejects junk')` → `normalizeAppearance({ theme: 'x', motion: 'balanced', accent: 'ion', welcome: 0 })` deepEqual `{ theme: 'auto', motion: 'balanced', accent: 'ion', welcome: false }`; `normalizeAppearance(null, { reducedMotion: true }).motion === 'minimal'`; `normalizeAppearance({ motion: 'full' }, { reducedMotion: true }).motion === 'full'`.
  - `tests/core.test.mjs`: `test('core:setAppearance validates, merges and is gated')` — saat terbuka `{ patch: { theme: 'light' } }` lalu `{ patch: { accent: 'nova', motion: 'nope' } }` → tersimpan `{ theme: 'light', motion: 'full', accent: 'nova', welcome: true }`; saat terkunci → `{ ok: false, error: 'locked' }`; dari halaman web → `forbidden`.
  - `tests/core.test.mjs`: `test('old Tab Manager theme is migrated once')` — `tm:data.settings.theme = 'dark'`, tanpa `core:appearance` → setelah `migrateAppearance()` tersimpan `theme: 'dark'`; bila `core:appearance` sudah ada, tidak berubah.
  - `tests/core.test.mjs`: `test('startup and install raise the welcome flag')` — `onStartup.fire()` → `storage.session['core:welcome'] === true`.
- [ ] **Step 2:** Run `node --test tests/ui.test.mjs tests/core.test.mjs` → FAIL.
- [ ] **Step 3:** Implement keempat berkas `ui/` dan perubahan `core/background.js` sesuai Interfaces (port `sky`, `countUp`, `toast`, ripple/glow/tilt dari prototipe; tambahkan pembatas 30 fps untuk `drift`/`calm` dan berhenti pada `visibilitychange`).
- [ ] **Step 4:** Run `node --test tests/core.test.mjs tests/browser-lock.test.mjs tests/tab-manager.test.mjs tests/ad-blocker.test.mjs tests/ui.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Add shared appearance, motion and star-field runtime"`

### Task 3: Handoff unlock → dashboard di service worker

**Files:**
- Modify: `modules/lock/background.js`, `tests/browser-lock.test.mjs`

**Interfaces:**
- Consumes: `isModuleEnabled('tabs')`, `WELCOME_KEY` tidak dipakai di sini.
- Produces: pesan `lock:handoff() → { ok: true }` (tidak publik; status sudah `open`); konstanta `HANDOFF_FALLBACK_MS = 4000`; `restoreTabs()` sekarang: pulihkan semua tab tersimpan **tidak aktif** di jendela tab kunci, **tidak** membuat tab dashboard, **tidak** menutup tab kunci, lalu jadwalkan `finishUnlock()` setelah `HANDOFF_FALLBACK_MS`. `finishUnlock()` idempoten (antre seperti `serialized`): bila tidak ada tab kunci → selesai; tab kunci ekstra ditutup; bila Tab Manager aktif → `storage.session['tm:arrive'] = true`, `tabs.move(id, { index: -1 })`, `tabs.update(id, { url: 'chrome://newtab/', active: true })`; bila nonaktif → aktifkan tab pulih pertama dan tutup tab kunci, atau bila tidak ada yang dipulihkan `tabs.update(id, { url: 'chrome://newtab/', active: true })`.

- [ ] **Step 1: Update/write the failing tests** (mock `chrome.tabs` mendapat `move(id, { index })`):
  - Ubah `'correct password unlocks and restores tabs'`: setelah unlock, sebelum handoff, `tabs` = `[LOCK, a, b, c]` dengan a/b/c tidak aktif; setelah `send({ type: 'lock:handoff' })` → `['https://a.com/', 'https://b.com/', 'https://c.com/', NEWTAB]`, NEWTAB aktif, dan `storage.session['tm:arrive'] === true`.
  - Ubah `'unlock restores tabs and focuses the dashboard'` (Tab Manager nonaktif): setelah handoff → a aktif, tidak ada LOCK; tanpa tab pulih → `[[NEWTAB, true]]`.
  - Baru `test('handoff falls back when the lock page never asks')`: `mock.timers.enable({ apis: ['setTimeout'] })`, unlock, `mock.timers.tick(4000)`, `settle()` → hasil sama dengan handoff.
  - Baru `test('handoff twice is harmless')`: dua `lock:handoff` berurutan → tetap satu NEWTAB.
  - Baru `test('handoff is refused while locked')`: saat terkunci → `{ ok: false, error: 'locked' }`.
- [ ] **Step 2:** Run `node --test tests/browser-lock.test.mjs` → FAIL.
- [ ] **Step 3:** Implement di `modules/lock/background.js`.
- [ ] **Step 4:** Run semua unit test → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Turn the lock tab itself into the dashboard after unlocking"`

### Task 4: Layar kunci, sambutan, dan setup (UI)

**Files:**
- Create: `ui/welcome.js`, `modules/lock/screen.css` (gaya bersama layar kunci & setup)
- Modify: `modules/lock/lock.html`, `lock.js`, `setup.html`, `setup.js`, `common.js` (bila perlu); hapus `modules/lock/style.css` bila tak dipakai lagi; `tests/universe.e2e.mjs`

**Interfaces:**
- Consumes: `initAppearance`, `consumeWelcome` (Task 2), `createSky`, `wait`, `shake`, `animate`, `hydrateIcons`, `lock:handoff` (Task 3).
- Produces (`ui/welcome.js`): `playWelcome(container: HTMLElement, sky: Sky): Promise<void>` — membangun adegan sambutan prototipe di `container`, resolve saat selesai (±4,8 dtk penuh, ±3,2 dtk minimal) atau saat "Lewati"/klik/Enter/Esc; tombol "Lewati" fokus otomatis.
- DOM kontrak yang dipertahankan (dipakai `lock.js`/`setup.js` dan tes): id lama layar kunci `form password unlock msg forgot recover-form code new-password confirm recover back recover-msg recovered new-code open open-msg`; setup `form password confirm save msg recovery code noted`; baru: `#welcome`, `#sky`, `#fx`, `.login-card`.

- [ ] **Step 1: Write the failing E2E tests** di `tests/universe.e2e.mjs` (letakkan di grup gerbang kunci, sebelum tes yang harus terakhir):
  - `'startup shows the welcome, then the login card'`: set `storage.session['core:welcome']=true` lalu kunci; layar kunci memiliki `#welcome` yang terlihat; klik `.w-skip` → `#form` terlihat dan `#password` fokus.
  - `'manual lock shows no welcome'`: `lock:lock` tanpa flag → `#welcome` tersembunyi sejak awal.
  - `'wrong password message appears at once in minimal motion'`: set `core:appearance.motion='minimal'`, kirim form dengan `salah` → dalam ≤ 300 ms `#msg` memuat "Password salah".
  - `'unlocking from the form turns the lock tab into the dashboard'`: isi password benar dan submit form (bukan pesan langsung) → target tab yang sama kini `newtab` dan `#space-list .space` ada.
- [ ] **Step 2:** Run `node --test tests/universe.e2e.mjs` → tes baru FAIL.
- [ ] **Step 3:** Implement: markup & CSS dari adegan `s-welcome` dan `s-login` prototipe (orbit, kartu kaca, bingkai berputar, flip ke pemulihan, tombol memeriksa/berhasil); `lock.js` mempertahankan semua logika lama (jeda, sisa percobaan, pemulihan, kode baru) dan setelah unlock sukses: tombol ✓ + gembok terbuka + `sky.warp(1100)` + animasi `leave-warp` ≈ 700 ms → `send('lock:handoff')`; layar kunci yang dibuka bukan karena startup masuk dengan `sky.reverse(900)`. `setup.html`: sambutan (bila flag) → kartu "Atur password" → kartu kode pemulihan; "Saya sudah mencatatnya" → `location.replace('/options.html#lock')`.
- [ ] **Step 4:** Run E2E → PASS; tangkapan layar layar kunci & setup di kedua tema, bandingkan dengan prototipe.
- [ ] **Step 5: Commit** — `git commit -m "Redesign the lock screen and setup with the welcome scene"`

### Task 5: Dashboard Tab Manager — kerangka, ruang, koleksi, kartu

**Files:**
- Create: `modules/tabs/dashboard/rail.js`, `dashboard/collections.js`, `dashboard/dialogs.js` (dialog + menu memakai komponen bersama)
- Modify: `modules/tabs/newtab.html`, `newtab.css`, `newtab.js` (jadi entry: guard → appearance → data → render), `common.js` (hapus `applyTheme`), `tests/harness/mock-chrome.js`, `tests/universe.e2e.mjs`

**Interfaces:**
- Consumes: `ui/*` (Task 1–2); semua operasi lama `runOp({ type: 'space/create'|'space/rename'|'space/delete'|'space/activate'|'collection/create'|'collection/rename'|'collection/delete'|'collection/update'|'collection/setCollapsedAll'|'collection/move'|'collection/dedupe'|'card/add'|'card/update'|'card/delete'|'card/move'|'import', … })`, `send('tm:openCollection', { collectionId, mode: 'current'|'window'|'group' })`, `loadData`, `onDataChanged`, `faviconUrl`.
- Produces: `renderRail(data, { onActivate })`, `renderCollections(space, { enter: boolean, flashId?: string })` (nama bebas, tetapi DOM berikut tetap): `#space-list .space[data-id]` (+ `.on`), `#space-ind`, `#starred li`, `#cols .col[data-id]` (+ `.collapsed`), `.col .row[data-id]`, `.new-drop`, `#main-head`, `#fold-all`, `#add-col`, `#add-space`. Favicon: `<img>` `faviconUrl(url, 32)` di dalam `.fav`, fallback huruf saat `error`.

- [ ] **Step 1: Write the failing tests**
  - Ubah semua `#space-list li` di `tests/universe.e2e.mjs` → `#space-list .space`.
  - Baru E2E `'dashboard keeps every collection action'`: lewat menu `.col-more` jalankan Ganti nama, Pindah ke ruang lain, Hapus tab ganda, Hapus (+ Urungkan dari toast) → `tm:getData` mencerminkan tiap langkah.
  - Baru E2E `'big spaces stay fast and narrow screens do not scroll sideways'`: isi 1 ruang dengan 20 koleksi × 20 kartu berjudul 300 karakter; muat dashboard pada viewport 400×800 → `document.documentElement.scrollWidth <= innerWidth`, render selesai < 1500 ms, dan elemen beranimasi `.col.enter` ≤ 24.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement zona 1 (rail: jam/sapaan dari prototipe, planet per ruang dengan warna bergilir `solar ion nova #8FB4FF #C6F26B`, indikator meluncur, Berbintang) dan zona 2 (kepala ruang, grid koleksi, lipat beranimasi, bintang + percikan, buka semua, menu opsi lengkap seperti `collectionMenu` lama + `spaceMenu`, edit/hapus kartu dengan Urungkan, tarik-ulang urutan kartu, zona koleksi baru). Stagger hanya 24 elemen pertama. Semua tulis data tetap lewat `runOp`.
- [ ] **Step 4:** Run E2E + `node tests/harness/serve.mjs` cek visual kedua tema → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Redesign the Tab Manager dashboard: spaces and collections"`

### Task 6: Dashboard — tab terbuka, cari & perintah, panduan, bilah atas, kedatangan

**Files:**
- Create: `modules/tabs/dashboard/open-tabs.js`, `dashboard/palette.js`, `dashboard/guide.js`
- Modify: `modules/tabs/newtab.html`, `newtab.css`, `newtab.js`, `tests/universe.e2e.mjs`

**Interfaces:**
- Consumes: `send('tm:saveSession', { … close })`, `send('tm:closeDuplicates')`, `runOp({ type: 'card/add', … })`, `search(data, query)` dari `store.js`, `send('ab:getOptions')` (total diblokir untuk chip; sembunyikan chip bila modul adblock nonaktif), `send('core:setAppearance', { patch: { theme } })`, `send('lock:lock')`, `consumeWelcome`, `storage.session['tm:arrive']`.
- Produces: DOM `#tm-open` (laci `.open` di < 1180 px), `#windows .orow[data-id]` (`.dup`), `#save-session`, `#close-after`, `#dedupe`, `#dup-count`, `#open-palette`, `#palette` (`#pal-q`, `.pal-item`), `#guide-card`, `#guide-btn`, `#theme-btn`, `#tm-lock`, `.chip-ab`. Panduan otomatis sekali: `storage.local['tm:guideSeen'] = true`. Pintasan `Ctrl/⌘+K` dan `/`.

- [ ] **Step 1: Write the failing E2E tests**
  - `'palette finds saved tabs and runs commands'`: `Ctrl+K`, ketik judul kartu yang ada → `.pal-item` pertama memuat judul itu; Enter → koleksinya ditandai `.flash`; ketik "kunci" → ada perintah "Kunci browser sekarang".
  - `'theme button switches every open page'` (Review Focus 3): buka dashboard dan `options.html`; klik `#theme-btn` → `document.documentElement.dataset.ui` berubah di **kedua** halaman tanpa reload.
  - `'arrival plays only after unlock'`: `tm:arrive` di-set → dashboard menghapus flag setelah dibaca.
  - `'guide shows once'`: kunjungan pertama `#guide-card` terlihat; setelah "Mengerti" dan reload, tidak tampil.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement zona 3 (tab terbuka per jendela, duplikat, simpan sesi + "Tutup tab setelah disimpan" memakai `settings.closeAfterSave`, simpan satu tab ke "Disimpan", tarik ke koleksi / ruang / zona baru, hantu terbang), zona 4 (palet: hasil `search()` + koleksi + perintah prototipe, panah/Enter/Esc), bilah atas (logo, palet, chip Ad Blocker total, Kunci dengan animasi runtuh ≤ 450 ms lalu `lock:lock`, tema, panduan, pengaturan, tombol laci), kedatangan (`tm:arrive` → `sky.warp` mundur + masuk dari kedalaman), sambutan bila Browser Lock mati (`consumeWelcome()` true). Hapus tombol tema lama & menu ⋯ lama (isinya pindah: ekspor/impor/bookmark ke palet dan Pengaturan; "Pintasan keyboard…" ke palet).
- [ ] **Step 4:** Run E2E → PASS; tangkapan layar dashboard 1440 px dan 400 px di kedua tema.
- [ ] **Step 5: Commit** — `git commit -m "Add open tabs, command palette, guide and arrival to the dashboard"`

### Task 7: Popup baru + panel modul

**Files:**
- Modify: `popup.html`, `popup.css`, `popup.js`, `core/panel.js`, `core/modules.js` (`icon` → nama ikon: `shield`, `layers`, `lock`), `modules/adblock/panel.js`, `modules/tabs/panel.js`, `modules/lock/panel.js`, `tests/universe.e2e.mjs`, `tests/core.test.mjs` (bila memeriksa ikon)

**Interfaces:**
- Consumes: `ui/*`, `MODULES`, kontrak panel lama `status(): Promise<string>`, `render(root): Promise<void>`.
- Produces: kontrak panel opsional baru `hero(): Promise<{ title: string, subtitle: string, value: number, favUrl?: string } | null>` (diimplementasikan Ad Blocker: domain tab aktif + `pageBlocked`; null bila halaman tak didukung atau modul nonaktif). DOM popup: `#mcu-home`, `#mcu-hero`, `.mcu-card[data-id]` dengan `.mcu-card-open`, `.mcu-card-status`, `input[data-mod]`; `#mcu-back`, `#mcu-title`, `#mcu-options`, `#mcu-panel > .mcu-panel-root[data-module]`, `#mcu-lock-now`. Sakelar modul pindah ke kartu beranda; sakelar Browser Lock off → buka panel lock dengan form password (`#disable-current`) terlihat. `core/panel.js`: hapus `moduleSwitch` bila tak dipakai lagi, tambah gaya baru untuk `offNotice`/`messageLine`.

- [ ] **Step 1: Update the failing E2E tests** (`'popup …'` dan sakelar modul): ganti `.mcu-tile*` → `.mcu-card*`; lebar body 370; sakelar adblock/tabs lewat `input[data-mod]` di beranda (status kartu jadi "nonaktif"); mematikan lock dari kartu → panel lock dengan `#disable-current`, sakelar tetap aktif sampai password benar; `#mcu-hero` memuat domain situs uji dan angka diblokir.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement sesuai adegan popup prototipe (buka melingkar dari pojok kanan atas lewat `clip-path` pada `body`/wadah, panel bergeser masuk, judul berganti, tilt kartu, hitung naik, cincin hitungan Ad Blocker, tombol "Tersimpan di …" Tab Manager, ikon gembok + fakta Browser Lock). Pembersihan `<head>` saat panel ditutup tetap.
- [ ] **Step 4:** Run E2E → PASS; tangkapan layar popup beranda + 3 panel, kedua tema.
- [ ] **Step 5: Commit** — `git commit -m "Redesign the toolbar popup and module panels"`

### Task 8: Halaman pengaturan tunggal

**Files:**
- Create: `settings-general.js` (bagian Umum + Tentang), `modules/lock/settings.js`, `modules/tabs/settings.js`, `modules/adblock/settings.js`
- Modify: `options.html`, `options.js`, `core/modules.js` (`options` → `settings`), `modules/lock/options.html` & `modules/adblock/options.html` (jadi pengalih `<meta http-equiv="refresh" content="0;url=/options.html#lock">` / `#adblock`), hapus `modules/lock/options.js`, `modules/adblock/options.js`, `tests/universe.e2e.mjs`

**Interfaces:**
- Consumes: semua pesan lama `lock:getState lock:saveSettings lock:lock lock:changePassword lock:newRecoveryCode lock:setEnabled`, `ab:getOptions ab:saveSettings ab:updateFilters ab:allowlistAdd ab:allowlistRemove ab:saveCustomFilters`, `tm:op settings/update`, ekspor/impor/bookmark dari Task 6 (pindahkan fungsinya ke `modules/tabs/dashboard/backup.js` agar dipakai dashboard dan pengaturan), `core:setModule`, `core:setAppearance`.
- Produces: kontrak bagian pengaturan `render(root: HTMLElement, ctx: { send, markSaved: () => void, toast }): Promise<void>` per modul, didaftarkan di `MODULES[i].settings`. DOM: `#st-links .st-link[data-sec]`, `#st-ind`, `#st-q`, `#saved`, `#st-body > section.st-sec#sec-<id>` (`umum`, `lock`, `tabs`, `adblock`, `about`), item `.item[data-search]`. `options.html#<id>` menggulir ke bagiannya.

- [ ] **Step 1: Update the failing E2E tests** (`'shared settings page …'`): tidak ada `#frame`; lima `.st-link`; `#lock` menggulir ke `#sec-lock`; mematikan lock perlu password (pesan "salah" saat keliru); `#st-q` "youtube" menyisakan satu item; sakelar daftar filter memanggil `ab:saveSettings` dan meteran berubah; `modules/adblock/options.html` mengalihkan ke `options.html#adblock`; semua kontrol `modules/adblock/options.html` lama (daftar, perbarui sekarang, pembaruan otomatis, situs diizinkan, filter saya + hitungan, badge, YouTube, menu, kredit) ada.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement sesuai adegan pengaturan prototipe (navigasi + indikator + scrollspy, bilah atas lengket, pencarian dengan animasi cocok, penanda "Tersimpan" berdenyut, segmen Tema/Tingkat animasi/Warna aksen, slider kunci otomatis 0–240, form lipat ganti password/kode pemulihan/matikan lock, meteran aturan vs 30.000, chip situs diizinkan). Status `setup` di bagian Browser Lock → tombol "Atur password" (`guardAction`).
- [ ] **Step 4:** Run E2E → PASS; tangkapan layar kedua tema dan 400 px.
- [ ] **Step 5: Commit** — `git commit -m "Replace module option frames with one animated settings page"`

### Task 9: Sisa permukaan, ikon, verifikasi akhir, dokumentasi

**Files:**
- Create: `tools/make-icons.mjs`
- Modify: `core/page-guard.js`, `modules/adblock/picker.js` (hanya `<style>` + markup panel), `icons/*.png`, `manifest.json` (ikon modul lama tak dipakai → hapus folder `modules/*/icons` yang tidak direferensikan), `tests/universe.e2e.mjs`, `README.md`, `CLAUDE.md`, `HANDOFF.md`, `docs/PROJECT_HISTORY.md`

**Interfaces:**
- Consumes: `logo()` dari `ui/icons.js`, `tests/chromium.mjs` (pencari Chromium).
- Produces: `node tools/make-icons.mjs` → `icons/icon{16,32,48,128}.png` dari logo orbit (CDP `Page.captureScreenshot`, latar transparan).

- [ ] **Step 1: Write the failing E2E tests**
  - `'extension pages make no third-party requests'`: aktifkan `Network` di dashboard, popup, options, lock; kumpulkan URL request → semua diawali `chrome-extension://<id>/` atau `chrome://`/`data:`.
  - `'minimal motion stops the canvas loop'`: `core:appearance.motion='minimal'` → di dashboard `requestAnimationFrame` tidak dipanggil berulang (hitung dengan pembungkus selama 1 dtk ≤ 2 panggilan).
  - `'guard notice uses the new style'`: popup saat terkunci menampilkan `.guard-notice` + tombol "Buka layar kunci".
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: `page-guard` memakai kartu `.guard-notice` (memuat `ui/tokens.css`+`components.css` bila belum; tetap tanpa membaca data modul); picker memakai palet Universe (gelap/terang mengikuti `prefers-color-scheme`, font sistem) **tanpa mengubah posisi/ukuran panel** (`right:16px; bottom:16px; width:min(380px, …); padding:14px`; baris tombol sama) karena E2E mengklik koordinatnya; ikon PNG baru.
- [ ] **Step 4:** Run seluruh verifikasi:
  - `node --test tests/core.test.mjs tests/browser-lock.test.mjs tests/tab-manager.test.mjs tests/ad-blocker.test.mjs tests/ui.test.mjs` → semua PASS
  - `node --test tests/universe.e2e.mjs` → semua PASS
  - tangkapan layar setiap permukaan (sambutan, login, setup, dashboard 1440/400, popup + 3 panel, pengaturan) × 2 tema, dibandingkan dengan prototipe; tidak ada error konsol.
- [ ] **Step 5:** Perbarui dokumentasi: `README.md` (tampilan baru, pengaturan Tampilan, cara menambah bagian pengaturan modul), `CLAUDE.md` (struktur `ui/`, konvensi token/tema, perintah tes UI), `HANDOFF.md`, `docs/PROJECT_HISTORY.md` (bagian redesign: keputusan handoff tab, font lokal, cermin localStorage).
- [ ] **Step 6: Commit** — `git commit -m "Finish the Universe redesign: guard notice, picker, icons, docs"`
