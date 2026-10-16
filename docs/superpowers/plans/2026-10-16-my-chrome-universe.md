# My Chrome Universe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menyatukan `browser-lock/`, `tab-manager/`, dan `ad-blocker/` menjadi satu extension MV3 "My Chrome Universe" (satu ikon, popup grid → panel, sakelar per modul, Browser Lock sebagai gerbang wajib + kode pemulihan) tanpa mengubah tampilan fitur yang ada.

**Architecture:** Folder `my-chrome-universe/` berisi `core/` (registry modul, status kunci/gerbang, menu klik kanan bersama, page guard) dan `modules/{lock,tabs,adblock}/` (isi folder lama, dipindah dengan `git mv`). Satu `background.js` di akar mengimpor `core/background.js` lalu background tiap modul; modul hanya boleh mengimpor `core/`, tidak saling mengimpor. Popup dan halaman pengaturan dibangun dari registry `core/modules.js`.

**Tech Stack:** Chrome MV3, JavaScript ES module murni (tanpa build, tanpa npm), `node:test` + `chrome` tiruan untuk unit test, Chromium Playwright + CDP untuk E2E.

**Spec:** `docs/superpowers/specs/2026-10-16-my-chrome-universe-design.md` (baca dulu; plan ini berargumen dari sana).

## Global Constraints

- MV3, JS murni ES module, tanpa build step dan tanpa dependensi npm.
- Service worker: **tanpa top-level await**; listener didaftarkan di top level; state di `chrome.storage` (SW bisa mati kapan saja) — fungsi gerbang membaca storage setiap kali, tanpa cache variabel.
- `modules/adblock/filters.js` tetap murni tanpa `chrome.*`; validasi `updater.js` tidak dilonggarkan; prioritas DNR (`PRIORITY`) dan bucket hash FNV-1a tidak diubah.
- Awalan namespace: pesan & storage Browser Lock `lock:`, Tab Manager `tm:`, Ad Blocker `ab:`, core `core:`.
- Teks UI bahasa Indonesia; komentar kode ringkas bahasa Inggris, gaya seperti kode sekitarnya.
- Manifest: `name` "My Chrome Universe", `short_name` "Universe", `version` "1.0.0", `minimum_chrome_version` "121"; maksimal 4 shortcut ber-`suggested_key` (dipakai 3: Alt+Shift+L, Alt+Shift+S, Alt+Shift+D).
- Tanpa telemetri, tanpa request ke server pihak ketiga baru, tanpa Acceptable Ads.
- Aturan dinamis DNR seluruhnya milik modul adblock.
- **Commit hanya dengan persetujuan pengguna.** Di awal eksekusi tanyakan sekali apakah langkah "Commit" per task boleh dijalankan; bila tidak, lewati langkah commit dan lanjutkan. Pesan commit diakhiri `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Node yang ada di mesin ini v22 (CI memakai 24); semua tes harus lolos di keduanya.

## Review Focus

1. **SW dimatikan Chrome lalu bangun lagi saat terkunci / perlu setup** → status tetap benar karena dibaca dari storage. Tes: `tests/core.test.mjs` "lockStatus reads storage every call" (Task 2).
2. **Ad Blocker dijeda, lalu modul dinonaktifkan, lalu diaktifkan lagi** → tetap dalam keadaan dijeda (jeda dan nonaktif independen); allowlist & filter saya utuh. Tes E2E di Task 6.
3. **Kode pemulihan diketik huruf kecil, dengan spasi/tanpa tanda hubung, atau dengan O/I/L** → tetap diterima. Tes unit di Task 5.
4. **Chrome dibuka ulang saat modul lock nonaktif** → tidak ada layar kunci, tab tidak ditutup. Tes unit di Task 4.
5. **Popup dibuka saat tab aktif adalah halaman `chrome://` / New Tab** → grid tampil, petak Ad Blocker menampilkan status tanpa error, panelnya menampilkan "Pemblokiran tidak berlaku di halaman ini." Tes E2E di Task 8.

---

### Task 0: Persiapan repo + stabilkan tes picker

**Files:**
- Modify: `.gitignore`
- Modify: `tests/ad-blocker.e2e.mjs:310-330` (tes picker) + helper baru `waitFor`

**Interfaces:**
- Produces: `async function waitFor(sessionId: string, expression: string, timeoutMs = 5000): Promise<any>` di file E2E — mengevaluasi `expression` tiap 100 ms sampai truthy, melempar error berisi `expression` bila habis waktu. Dipakai task-task E2E berikutnya.

- [ ] **Step 1: Pastikan perubahan working copy hanya akhir baris, lalu normalkan**

Run: `git diff --ignore-cr-at-eol --stat`
Expected: output kosong. (Bila tidak kosong: berhenti dan laporkan ke pengguna.)
Run: `git checkout -- .` lalu `git status --short`
Expected: hanya `?? docs/superpowers/` dan `?? .superpowers/` (atau tanpa yang terakhir setelah Step 2).

- [ ] **Step 2: Tambahkan `.superpowers/` ke `.gitignore`** (dengan komentar satu baris seperti entri lain).

- [ ] **Step 3: Perbaiki tes picker** — dugaan penyebab (gagal 3/6 run, `display` tetap `block`): tes sebelumnya mengaktifkan kelima kategori, sehingga `ab:addFilter` → `applyAll()` bisa lebih lama dari `sleep(600)`. Ganti dengan menunggu kondisi:
  - setelah `ab:startPicker`: `await waitFor(session, "document.querySelector('ab-picker')")` (ganti `sleep(300)`);
  - setelah klik "Blokir": `await waitFor(session, "!document.querySelector('ab-picker')")` (picker menutup diri hanya bila `ab:addFilter` sukses), lalu `await waitFor(session, "getComputedStyle(document.getElementById('content')).display === 'none'")`;
  - assertion `customFilters` tetap.

- [ ] **Step 4: Verifikasi stabil**

Run: `for i in 1 2 3 4 5; do node --test tests/ad-blocker.e2e.mjs 2>&1 | grep -E "^# (pass|fail)" | tr '\n' ' '; echo; done`
Expected: lima baris `# pass 13 # fail 0`.

- [ ] **Step 5: Commit** — `git add .gitignore tests/ad-blocker.e2e.mjs docs/superpowers` · pesan: `Stabilize picker E2E test and add My Chrome Universe design`

---

### Task 1: Pindahkan folder (riwayat git terjaga)

**Files:**
- Move: `browser-lock/` → `my-chrome-universe/modules/lock/`, `tab-manager/` → `my-chrome-universe/modules/tabs/`, `ad-blocker/` → `my-chrome-universe/modules/adblock/`
- Modify (path saja): `tests/browser-lock.test.mjs`, `tests/tab-manager.test.mjs`, `tests/ad-blocker.test.mjs`, `tests/ad-blocker.e2e.mjs:19`, `tests/feed.live.mjs:13`, `tests/youtube.live.mjs:14`, `tests/harness/serve.mjs:16,23`, `filter-bot/bot.mjs:25,35`

- [ ] **Step 1: `git mv` ketiga folder** (buat `my-chrome-universe/modules/` dulu). `_metadata/` diabaikan git; hapus sisa `ad-blocker/_metadata` bila foldernya tertinggal.
- [ ] **Step 2: Commit pindahan saja** (tanpa perubahan isi apa pun) — pesan: `Move extensions into my-chrome-universe/modules` · Run sesudahnya: `git show --stat HEAD | grep -c "=>"` → Expected: jumlah file yang dipindah (semua tercatat sebagai rename).
- [ ] **Step 3: Perbarui path di file yang disebut di atas.** Setiap modul masih punya `manifest.json`-nya sendiri, jadi E2E/live test memuat `my-chrome-universe/modules/adblock` sebagai extension mandiri; `EXT_DIR` bot → `my-chrome-universe/modules/adblock`.
- [ ] **Step 4: Verifikasi**

Run: `node --test tests/browser-lock.test.mjs tests/tab-manager.test.mjs tests/ad-blocker.test.mjs && node --test tests/ad-blocker.e2e.mjs`
Expected: `# pass 38 # fail 0` lalu `# pass 13 # fail 0`.

- [ ] **Step 5: Commit** — pesan: `Point tests and filter bot at the moved extension folders`

---

### Task 2: Core — registry modul, status kunci, menu bersama

**Files:**
- Create: `my-chrome-universe/core/modules.js`, `my-chrome-universe/core/gate.js`, `my-chrome-universe/core/menus.js`
- Test: `tests/core.test.mjs` (baru; `chrome` tiruan dengan pola `event()`/`area()` dari `tests/browser-lock.test.mjs`, ditambah `storage.onChanged` dan `contextMenus` perekam)

**Interfaces:**
- Produces (`core/modules.js`, tanpa DOM, bisa diimpor SW & halaman):
  - `export const MODULES_KEY = 'core:modules'`
  - `export const MODULES: Array<{ id: 'adblock'|'tabs'|'lock', name: string, icon: string, panel: string, options: string|null }>` urutan & nilai persis: `{ id: 'adblock', name: 'Ad Blocker', icon: '🛡', panel: 'modules/adblock/panel.js', options: 'modules/adblock/options.html' }`, `{ id: 'tabs', name: 'Tab Manager', icon: '🗂', panel: 'modules/tabs/panel.js', options: null }`, `{ id: 'lock', name: 'Browser Lock', icon: '🔒', panel: 'modules/lock/panel.js', options: 'modules/lock/options.html' }`
  - `export async function getModuleStates(): Promise<Record<string, boolean>>` — default `true` untuk tiap id yang tidak tersimpan
  - `export async function isModuleEnabled(id: string): Promise<boolean>`
  - `export async function setModuleState(id: string, enabled: boolean): Promise<Record<string, boolean>>` — tulis mentah, tanpa kebijakan
  - `export function onModuleStatesChanged(cb: (states: Record<string, boolean>) => void): void` — lewat `chrome.storage.onChanged` area `local`
- Produces (`core/gate.js`):
  - `export const LOCK_PATH = 'modules/lock/lock.html'`, `export const SETUP_PATH = 'modules/lock/setup.html'`
  - `export async function lockStatus(): Promise<'setup'|'locked'|'open'>` — tanpa `lock:auth` di local → `'setup'`; modul lock nonaktif → `'open'`; `lock:unlocked === true` di session → `'open'`; selain itu `'locked'`
  - `export const PUBLIC_MESSAGES: Set<string>` = `lock:getState`, `lock:setup`, `lock:unlock`, `lock:recover`, `lock:lock`, `core:getModules`
  - `export async function messageAllowed(type: string): Promise<boolean>` — `PUBLIC_MESSAGES.has(type) || (await lockStatus()) === 'open'`
  - `export async function guardAction(): Promise<boolean>` — `'open'` → `true`; `'setup'` → fokuskan tab setup yang ada atau buka `SETUP_PATH`, `false`; `'locked'` → `false`
- Produces (`core/menus.js`):
  - `export function registerMenuProvider(moduleId: string, provider: () => Promise<chrome.contextMenus.CreateProperties[]>): void`
  - `export function rebuildMenus(): Promise<void>` — diantrekan (promise chain seperti `mutate` di tabs); `removeAll`, lalu buat item semua provider yang modulnya aktif, urut sesuai `MODULES`

- [ ] **Step 1: Tulis tes yang gagal** di `tests/core.test.mjs`:
  - `module states default to enabled` — `getModuleStates()` → `{ adblock: true, tabs: true, lock: true }`; setelah `setModuleState('tabs', false)` → `isModuleEnabled('tabs') === false`
  - `lockStatus covers setup, locked, open and disabled lock` — kosong → `'setup'`; `lock:auth` ada → `'locked'`; + session `lock:unlocked: true` → `'open'`; session dikosongkan + `setModuleState('lock', false)` → `'open'`
  - `lockStatus reads storage every call` — panggil, ubah storage langsung, panggil lagi → hasil berubah
  - `messageAllowed lets only lock screen messages through while locked` — saat `'locked'`: `lock:unlock` → true, `tm:op` → false, `ab:getOptions` → false, `core:setModule` → false; saat `'open'`: `tm:op` → true
  - `guardAction opens setup when no password exists` — status `'setup'` → `false` dan ada tab `chrome-extension://testid/modules/lock/setup.html`; dipanggil dua kali → tetap satu tab setup
  - `menus from every enabled module coexist` — dua provider (`adblock` 1 item, `tabs` 4 item) → `rebuildMenus()` menghasilkan 5 `create`; `setModuleState('tabs', false)` + rebuild → 1 `create`; dua `rebuildMenus()` beruntun tanpa await → tetap 5 item, bukan 10

- [ ] **Step 2: Jalankan** `node --test tests/core.test.mjs` → Expected: FAIL (modul belum ada)
- [ ] **Step 3: Implementasikan ketiga file** sesuai Interfaces.
- [ ] **Step 4: Jalankan** `node --test tests/core.test.mjs` → Expected: semua PASS
- [ ] **Step 5: Commit** — pesan: `Add core module registry, lock gate and shared context menus`

---

### Task 3: Satu extension — manifest gabungan, background akar, path modul

**Files:**
- Create: `my-chrome-universe/manifest.json`, `my-chrome-universe/background.js`, `my-chrome-universe/core/background.js`, `my-chrome-universe/icons/icon{16,32,48,128}.png` (sementara, sederhana, dibuat dengan skrip Node tanpa dependensi atau disalin dari ikon modul lalu diwarnai beda — keputusan pembangun)
- Delete: `my-chrome-universe/modules/*/manifest.json`, `modules/adblock/icons/icon*-off.png` (ikon abu-abu tak dipakai lagi)
- Modify: `modules/adblock/background.js`, `modules/adblock/updater.js:169`, `modules/adblock/options.js:156`, `modules/tabs/background.js`, `modules/tabs/newtab.js:5`, `modules/lock/background.js:3-5`, `filter-bot/bot.mjs` (bagian 5), `tests/ad-blocker.e2e.mjs` → `git mv` ke `tests/universe.e2e.mjs`, `tests/feed.live.mjs`, `tests/youtube.live.mjs`, `tests/harness/serve.mjs`, `.github/workflows/filter-bot.yml`

**Interfaces:**
- Consumes: `registerMenuProvider`, `rebuildMenus` (Task 2)
- Produces: `my-chrome-universe/background.js` = empat `import` berurutan: `./core/background.js`, `./modules/lock/background.js`, `./modules/tabs/background.js`, `./modules/adblock/background.js`. `core/background.js` memanggil `rebuildMenus()` di `onInstalled` dan `onStartup`, dan di `onModuleStatesChanged`.

- [ ] **Step 1: Manifest gabungan** sesuai spec §5.6. Sementara (sampai Task 8/9): `action.default_popup` = `modules/adblock/popup.html`, `options_ui.page` = `modules/adblock/options.html`. `chrome_url_overrides.newtab` = `modules/tabs/newtab.html`; `rule_resources` path `modules/adblock/rules/<id>.json` (enabled sama dengan sekarang).
- [ ] **Step 2: Prefiks path di background & halaman modul.** Semua `chrome.runtime.getURL(...)`, `files:` di `executeScript`, `js:`/`css:` di `registerContentScripts`, dan `fetch` berkas bundel memakai path dari akar extension (`modules/adblock/lists.json`, `modules/adblock/cosmetic/<id>.json`, `modules/adblock/rules/<id>.json`, `modules/adblock/youtube-main.js`, `modules/adblock/youtube.css`, `modules/adblock/picker.js`, `modules/tabs/newtab.html`, `modules/lock/lock.html`, `modules/lock/setup.html`). URL relatif di HTML modul (`style.css`, `options.html`) tidak berubah karena relatif terhadap halaman.
- [ ] **Step 3: Lepaskan bentrokan antar modul** (spec §5.5):
  - adblock: `applyMenu` → `registerMenuProvider('adblock', …)` (item "Blokir elemen…" hanya bila `settings.contextMenu`) dan `applyAll` memanggil `rebuildMenus()`; hapus `ICONS`/`refreshIcon`/`refreshAllIcons` dan pemanggilnya; hapus `chrome.runtime.openOptionsPage()` di `onInstalled`.
  - tabs: `createMenus` → `registerMenuProvider('tabs', …)` dengan empat item yang sama; hapus `chrome.runtime.onInstalled.addListener(createMenus)`.
- [ ] **Step 4: Bot** — `EXT_DIR` = `my-chrome-universe/modules/adblock` untuk `rules/`, `cosmetic/`, `lists.json`; manifest yang ditulis = `my-chrome-universe/manifest.json`, hanya kunci `declarative_net_request` yang diganti, path `modules/adblock/rules/<id>.json`.
- [ ] **Step 5: Tes ikut pindah** — `git mv tests/ad-blocker.e2e.mjs tests/universe.e2e.mjs`; `extDir` = `my-chrome-universe`; SW dicari dengan `name === 'My Chrome Universe'`; `bg()` membuka `modules/adblock/popup.html`; tes "extension pages render" memakai path baru. Live test & harness: path dan nama manifest baru. Unit test: tambahkan `contextMenus` tiruan & `storage.onChanged` bila modul kini mengimpor `core/`. Workflow CI: jalankan `tests/core.test.mjs` juga dan `tests/universe.e2e.mjs`.
- [ ] **Step 6: Verifikasi**

Run: `node --test tests/core.test.mjs tests/browser-lock.test.mjs tests/tab-manager.test.mjs tests/ad-blocker.test.mjs && node --test tests/universe.e2e.mjs`
Expected: semua unit PASS; E2E `# pass 13 # fail 0`.
Run: `node -e "const m=require('./my-chrome-universe/manifest.json');console.log(m.name, Object.keys(m.commands).length, m.declarative_net_request.rule_resources[0].path)"`
Expected: `My Chrome Universe 3 modules/adblock/rules/ads.json`

- [ ] **Step 7: Commit** — pesan: `Combine the three extensions into one My Chrome Universe manifest`

---

### Task 4: Browser Lock — awalan `lock:`, status "perlu setup", sakelar, pemulihan tab + dashboard

**Files:**
- Modify: `modules/lock/background.js`, `modules/lock/{lock,setup,options,popup}.js`, `modules/lock/options.html`
- Test: `tests/browser-lock.test.mjs`

**Interfaces:**
- Consumes: `lockStatus`, `messageAllowed`, `LOCK_PATH`, `SETUP_PATH` (gate), `isModuleEnabled`, `setModuleState` (modules)
- Produces — storage: local `lock:auth`, `lock:settings`, `lock:failures`, `lock:lockoutUntil`; session `lock:unlocked`, `lock:savedTabs`. Pesan (semua `{ type, ...payload }` → `{ ok, ... }`): `lock:getState` → `{ hasPassword, locked, status: 'setup'|'locked'|'open', enabled, settings, failures, lockoutUntil, minLength }`; `lock:setup {password, confirm}`; `lock:unlock {password}`; `lock:changePassword {current, password, confirm}`; `lock:saveSettings {settings}`; `lock:lock`; `lock:setEnabled {enabled: boolean, current?: string}`. `removePassword` **dihapus**.

- [ ] **Step 1: Ubah tes yang ada** ke nama baru (pesan, storage, URL `BASE + 'modules/lock/lock.html'` / `setup.html`, impor `../my-chrome-universe/modules/lock/background.js`) dan ganti tes "change and remove password" dengan tes baru:
  - `restart while lock module is disabled does not lock` — `lock:auth` ada, `setModuleState('lock', false)`, session dikosongkan, `onStartup` → tab tetap, tidak ada `lock.html`
  - `disabling the lock needs the current password` — `lock:setEnabled {enabled:false, current:'salah'}` → `ok:false` dan `failures` naik 1; dengan password benar → `ok:true`, `isModuleEnabled('lock') === false`; `lock:lock` → `ok:false`; `lock:setEnabled {enabled:true}` → `ok:true` dan `lockStatus() === 'open'` (tidak langsung terkunci)
  - `lock cannot be disabled before a password exists` — tanpa `lock:auth`: `lock:setEnabled {enabled:false}` → `ok:false`
  - `unlock restores tabs and focuses the dashboard` — tab yang dipulihkan dibuat `active:false`, lalu satu tab baru `chrome://newtab/` `active:true` dibuat terakhir; bila `setModuleState('tabs', false)`: tidak ada tab tambahan, tab pulihan pertama `active:true`
  - `messages other than the lock screen ones are refused while locked` — saat terkunci `lock:saveSettings` → `ok:false` (lewat `messageAllowed`, error `'locked'`)
- [ ] **Step 2: Jalankan** `node --test tests/browser-lock.test.mjs` → Expected: FAIL pada tes baru/ganti nama
- [ ] **Step 3: Implementasikan**: `isLocked()` → `(await lockStatus()) === 'locked'`; `lock()` → `false` bila status bukan `'open'`/modul nonaktif; listener `onMessage` memakai `messageAllowed` (tolak dengan `{ ok:false, error:'locked' }`); `restoreTabs()` sesuai tes; `lock:setEnabled` sesuai Interfaces (mematikan memakai `checkPassword` yang sama → ikut throttle; mengaktifkan juga set `lock:unlocked: true`). Halaman lock: `send('lock:…')`; `options.html`/`options.js`: bagian "Hapus password" diganti sakelar "Browser Lock aktif" (mematikan meminta password saat ini).
- [ ] **Step 4: Jalankan** `node --test tests/browser-lock.test.mjs tests/core.test.mjs` → Expected: PASS
- [ ] **Step 5: Commit** — pesan: `Make Browser Lock the gate: lock: prefix, setup state, on/off switch`

---

### Task 5: Kode pemulihan

**Files:**
- Modify: `modules/lock/crypto.js`, `modules/lock/background.js`, `modules/lock/lock.html`/`lock.js`, `modules/lock/setup.html`/`setup.js`, `modules/lock/options.html`/`options.js`
- Test: `tests/browser-lock.test.mjs`

**Interfaces:**
- Produces (`crypto.js`):
  - `export function generateRecoveryCode(): string` — 20 karakter dari alfabet Crockford `0123456789ABCDEFGHJKMNPQRSTVWXYZ` lewat `crypto.getRandomValues`, dikelompokkan 4 dengan `-` (`XXXX-XXXX-XXXX-XXXX-XXXX`, 100 bit)
  - `export function normalizeRecoveryCode(input: string): string` — huruf besar, buang selain alfanumerik, `I`/`L` → `1`, `O` → `0`
- Produces (pesan & storage): local `lock:recovery` = `createPasswordRecord(normalizeRecoveryCode(code))`. `lock:setup` kini → `{ ok, recoveryCode }`. `lock:recover {code, password, confirm}` → `{ ok, recoveryCode }`: validasi password baru dulu (tidak dihitung percobaan), lalu verifikasi kode dengan throttle yang sama (`lock:failures`/`lock:lockoutUntil`); sukses → password baru, kode baru, failures 0, **tidak** membuka kunci. `lock:newRecoveryCode {current}` → `{ ok, recoveryCode }`, hanya saat `'open'` dan password benar.

- [ ] **Step 1: Tulis tes yang gagal:**
  - `recovery codes look right and normalize` — `generateRecoveryCode()` cocok `/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/`; dua panggilan berbeda; `normalizeRecoveryCode(' abcd-efgh ijkl-mnop-qrst ')` === `'ABCDEFGH1JK1MN0PQRST'`
  - `setup returns a recovery code that is stored only as a hash` — `lock:setup` → `recoveryCode` ada; dump storage tidak memuat kode itu (dengan atau tanpa `-`)
  - `recovery code resets the password but does not unlock by itself` — saat terkunci: `lock:recover` dengan kode huruf kecil tanpa `-` + password baru → `ok:true`, `recoveryCode` baru ≠ lama; `lockStatus()` masih `'locked'`; `lock:unlock` dengan password baru → `ok:true`; kode lama kini ditolak
  - `wrong recovery codes are throttled like passwords` — 5 kode salah → `error:'lockout'`
  - `a new recovery code needs the current password` — `lock:newRecoveryCode {current:'salah'}` → `ok:false`; benar → kode baru
- [ ] **Step 2: Jalankan** `node --test tests/browser-lock.test.mjs` → Expected: FAIL
- [ ] **Step 3: Implementasikan** crypto + handler (generalisasi `checkPassword` menjadi `checkSecret(secret, key)` agar throttle dipakai bersama). Tambahkan `lock:recover` ke `PUBLIC_MESSAGES` (sudah ada di Task 2).
- [ ] **Step 4: UI** — `setup`: setelah sukses tampilkan kode sekali dalam kotak monospace + teks "Simpan kode pemulihan ini di tempat aman. Kode ini hanya ditampilkan sekali dan bisa membuka browser bila kamu lupa password." + tombol "Saya sudah mencatatnya". `lock`: tautan "Lupa password?" → form kode + password baru + ulangi; sukses → tampilkan kode baru + tombol "Saya sudah mencatatnya, buka browser" yang mengirim `lock:unlock` dengan password baru yang masih di memori halaman. `options`: tombol "Buat kode pemulihan baru" (minta password saat ini).
- [ ] **Step 5: Jalankan** `node --test tests/browser-lock.test.mjs` → Expected: PASS
- [ ] **Step 6: Commit** — pesan: `Add one-time recovery codes to Browser Lock`

---

### Task 6: Gerbang di semua modul + sakelar modul

**Files:**
- Create: `my-chrome-universe/core/page-guard.js`
- Modify: `core/background.js` (pesan `core:`), `modules/tabs/background.js`, `modules/tabs/newtab.js`, `modules/tabs/popup.js`, `modules/adblock/background.js`, `modules/adblock/options.js`, `modules/adblock/popup.js`, `modules/lock/options.js`, `tests/harness/mock-chrome.js`
- Test: `tests/tab-manager.test.mjs`, `tests/core.test.mjs`, `tests/universe.e2e.mjs`

**Interfaces:**
- Consumes: semua dari Task 2; `lock:lock` (Task 4)
- Produces:
  - `core/page-guard.js`: `export async function guardPage(kind: 'tab'|'popup'|'frame'): Promise<void>` — `'open'` → resolve, lalu pasang `storage.onChanged` (local `lock:auth`/`core:modules`, session `lock:unlocked`) yang `location.reload()` bila status menjadi bukan `'open'`. `'setup'`: `tab` → `location.replace(getURL(SETUP_PATH))`; `popup`/`frame` → ganti isi `body` dengan "Buat password terlebih dahulu." + tombol "Buat password" (buka setup). `'locked'` → isi `body` diganti "Browser terkunci." (+ di popup tombol "Buka layar kunci" yang mengirim `lock:lock`). Selain `'open'` promise **tidak pernah resolve** sehingga skrip halaman berhenti sebelum memuat data. Dipanggil sebagai baris `await` pertama di setiap skrip halaman extension kecuali `lock.js` dan `setup.js`.
  - Pesan core: `core:getModules` → `{ ok, modules: Record<string, boolean> }`; `core:setModule {id, enabled}` → `{ ok, modules }`, menolak `id === 'lock'` (`error: 'Gunakan pengaturan Browser Lock'`) dan id yang tak dikenal.
  - adblock: `getSettings()` menambah `disabled: boolean` (= modul nonaktif); helper `isOff(settings) = settings.paused || settings.disabled` menggantikan setiap cek `settings.paused` di `applyRulesets`, `applyDynamicRules`, `applyBadge`, `applyYoutube`, `injectCosmetics`, dan provider menu; `onModuleStatesChanged(() => applyAll())`; `ab:getPopupState` menambah `disabled`.
  - tabs: provider menu, `commands`, `omnibox` dan `contextMenus.onClicked` diam bila modul nonaktif; semua aksi diawali `guardAction()`.
  - Semua listener `onMessage` modul (tabs, adblock, core) memakai `messageAllowed` → `{ ok:false, error:'locked' }`.

- [ ] **Step 1: Tulis tes yang gagal:**
  - unit `tests/tab-manager.test.mjs` `tab messages are refused while locked` — set `lock:auth`, session kosong → `tm:op` → `{ ok:false, error:'locked' }`; set `lock:unlocked: true` → berhasil. (Siapkan status `'open'` di awal file agar tes lama tetap lolos.)
  - unit `tests/tab-manager.test.mjs` `shortcuts and menus do nothing while the module is off` — `setModuleState('tabs', false)`; `commands.onCommand.fire('save-session')` → koleksi tidak bertambah
  - unit `tests/core.test.mjs` `core:setModule refuses lock` dan menerima `adblock`
  - E2E `tests/universe.e2e.mjs` — `before()`: setelah SW ditemukan, `bg({ type:'lock:setup', password:'rahasia1', confirm:'rahasia1' })` (sebelumnya semua pesan modul ditolak karena `'setup'`); tes baru:
    - `turning Ad Blocker off stops blocking and keeps pause separate` — `ab:setPaused true` → `core:setModule adblock false` → `core:setModule adblock true` → `ab:getOptions().settings.paused === true`; `ab:setPaused false` → iklan diblokir lagi; dengan modul nonaktif: `loadTestPage().loads.adserver === true`, `getEnabledRulesets()` kosong, `adBanner === 'block'`
    - `turning Tab Manager off replaces the dashboard` — `core:setModule tabs false`, buka New Tab (`chrome://newtab/`) → bukan dashboard (lihat Step 3); aktifkan lagi → dashboard
- [ ] **Step 2: Jalankan** unit + E2E → Expected: tes baru FAIL
- [ ] **Step 3: Implementasikan.** Untuk New Tab saat Tab Manager nonaktif: **spike dulu** di E2E apakah `newtab.js` bisa mengarahkan tab ke `chrome://new-tab-page/` (`chrome.tabs.update` pada tab sendiri) tanpa berputar kembali ke override. Bila bisa, pakai itu; bila tidak, tampilkan halaman sederhana "Tab Manager sedang nonaktif." + tombol "Aktifkan Tab Manager" (`core:setModule`). Catat hasil spike di `docs/PROJECT_HISTORY.md` (Task 9). Tes E2E menyesuaikan pilihan itu.
- [ ] **Step 4: Page guard** di `newtab.js` (`'tab'`), popup modul (`'popup'`, sementara masih jadi popup aksi), `modules/adblock/options.js` & `modules/lock/options.js` (`'tab'`). `tests/harness/mock-chrome.js` mengisi status `'open'` (auth tiruan + `lock:unlocked`) agar harness UI tetap jalan.
- [ ] **Step 5: Jalankan** semua unit + E2E (perintah Task 3 Step 6, dengan `tests/universe.e2e.mjs`) → Expected: PASS semua
- [ ] **Step 6: Commit** — pesan: `Gate every module behind Browser Lock and add per-module switches`

---

### Task 7: E2E gerbang kunci

**Files:**
- Test: `tests/universe.e2e.mjs` (tes ditaruh **paling akhir** di file karena mengunci browser)

**Interfaces:**
- Consumes: `waitFor` (Task 0), pesan `lock:*` (Task 4–5)

Saat terkunci, setiap tab non-kunci ditutup, termasuk halaman yang dipakai `bg()`. Untuk membuka kunci, evaluasi `chrome.runtime.sendMessage({type:'lock:unlock', …})` di target CDP halaman `modules/lock/lock.html`.

- [ ] **Step 1: Tulis tes:**
  - `locking closes every extension page and refuses module messages` — buka dashboard (`modules/tabs/newtab.html`) dan `options` adblock; `bg({type:'lock:lock'})`; `waitFor` hingga daftar target `page` hanya berisi `lock.html`; dari target lock.html: `chrome.runtime.sendMessage({type:'tm:op', …})` → `error:'locked'`, `ab:getOptions` → `error:'locked'`; buka `popup.html` adblock lewat `Target.createTarget` → tab itu tertutup (`waitFor` target hilang)
  - `unlock restores tabs and shows the dashboard` — dari lock.html `lock:unlock` → `waitFor` ada target `site.test` yang dipulihkan dan target aktif terakhir adalah dashboard (`newtab.html` / `chrome://newtab/`)
  - `recovery code opens the browser and replaces the password` — kunci lagi; dari lock.html `lock:recover` dengan `recoveryCode` dari `before()` → `ok:true`; `lock:unlock` dengan password baru → terbuka
- [ ] **Step 2: Jalankan** `node --test tests/universe.e2e.mjs` → Expected: semua PASS (bila gagal, perbaiki implementasi Task 4–6, bukan melonggarkan tes)
- [ ] **Step 3: Commit** — pesan: `Cover the lock gate end to end`

---

### Task 8: Popup My Chrome Universe — grid → panel → ← kembali

**Files:**
- Create: `my-chrome-universe/popup.html`, `popup.js`, `popup.css`; `modules/adblock/panel.js`, `modules/tabs/panel.js`, `modules/lock/panel.js`
- Delete: `modules/{adblock,tabs,lock}/popup.html` dan `popup.js` (isinya pindah ke `panel.js`)
- Modify: `my-chrome-universe/manifest.json` (`action.default_popup` = `popup.html`, `default_title` "My Chrome Universe"), `tests/universe.e2e.mjs` (`bg()` membuka `popup.html` akar)

**Interfaces:**
- Consumes: `MODULES`, `getModuleStates` (modules), `guardPage('popup')`
- Produces — setiap `modules/<id>/panel.js`:
  - `export async function render(root: HTMLElement): Promise<void>` — membangun kontrol yang sama dengan popup modul lama di dalam `root` (CSS modul dimuat dengan `<link>` yang ditambahkan panel bila perlu), ditambah sakelar "Aktif" di atas (adblock/tabs → `core:setModule`; lock → `lock:setEnabled` dengan meminta password saat mematikan); bila modul nonaktif, panel hanya menampilkan sakelar + "Fitur ini sedang nonaktif."
  - `export async function status(): Promise<string>` — teks pendek petak grid: adblock `'nonaktif'` / `'dijeda'` / `'aktif · <pageBlocked>'` (tab aktif tanpa host → `'aktif'`); tabs `'nonaktif'` / `'<n> koleksi'`; lock `'nonaktif'` / `'aktif'`
- Popup: `await guardPage('popup')`; grid 3 kolom dari `MODULES` (ikon, nama, status); klik petak → `import(panel)` → header `← <ikon> <nama>` + tombol ⚙ (bila `options` ada → `chrome.tabs.create({ url: getURL('options.html#' + id) })`) → `render(root)`; ← mengosongkan panel dan menampilkan grid lagi. Hanya satu panel di DOM pada satu waktu (id elemen modul bisa bentrok). Tampilan mengikuti mockup `popup-layout-v2.html` varian 1 dan gaya CSS yang ada; lebar 320px.

- [ ] **Step 1: Tulis tes E2E yang gagal:**
  - `popup shows the module grid and opens a panel` — buka `popup.html`; `waitFor` 3 petak berisi `Ad Blocker`, `Tab Manager`, `Browser Lock`; klik petak Ad Blocker → teks "Blokir elemen di halaman ini" ada; klik ← → grid lagi
  - `popup works when the active tab is not a website` — aktifkan tab `about:blank`, buka popup → petak Ad Blocker berstatus `aktif` tanpa error konsol; panel menampilkan "Pemblokiran tidak berlaku di halaman ini."
  - `extension pages render without errors` diperbarui: `popup.html` dan `modules/adblock/options.html`
- [ ] **Step 2: Jalankan** → Expected: FAIL
- [ ] **Step 3: Implementasikan** popup + tiga panel (port logika `popup.js` modul lama; `send` dari `common.js` modul masing-masing).
- [ ] **Step 4: Jalankan** `node --test tests/universe.e2e.mjs` → Expected: PASS
- [ ] **Step 5: Commit** — pesan: `Add the My Chrome Universe popup with a module grid`

---

### Task 9: Halaman pengaturan bersama, dokumentasi, verifikasi akhir

**Files:**
- Create: `my-chrome-universe/options.html`, `options.js`
- Modify: `my-chrome-universe/manifest.json` (`options_ui.page` = `options.html`, `open_in_tab: true`), `README.md`, `CLAUDE.md`, `HANDOFF.md`, `docs/PROJECT_HISTORY.md`, `.github/workflows/filter-bot.yml`
- Test: `tests/universe.e2e.mjs`

**Interfaces:**
- Consumes: `MODULES`, `guardPage('tab')`, `core:getModules`/`core:setModule`, `lock:setEnabled`
- Produces: `options.html#<id>` — menu samping dari `MODULES`; konten: judul modul + sakelar Aktif + `<iframe>` ke `options` modul (adblock, lock; halaman di iframe memanggil `guardPage('frame')`). Tab Manager (tanpa halaman opsi): sakelar + tombol "Buka dashboard". Hash kosong → modul pertama. Halaman `options.html` lama di modul tetap bisa dibuka langsung.

- [ ] **Step 1: Tulis tes E2E** `options page lists every module` — buka `options.html#lock` → menu samping memuat ketiga nama; iframe `modules/lock/options.html` termuat; `options.html#adblock` → iframe adblock termuat.
- [ ] **Step 2: Implementasikan**, jalankan `node --test tests/universe.e2e.mjs` → Expected: PASS
- [ ] **Step 3: Bot** — Run: `node filter-bot/bot.mjs --update-extension --out "$SCRATCH/feed"` (butuh internet; `$SCRATCH` = direktori scratchpad sesi). Expected: `git diff my-chrome-universe/manifest.json` hanya mengubah isi `declarative_net_request` (path tetap `modules/adblock/rules/…`); lalu `node --test tests/universe.e2e.mjs` PASS. Kembalikan data bundel dengan `git checkout -- my-chrome-universe/modules/adblock/rules my-chrome-universe/modules/adblock/cosmetic my-chrome-universe/modules/adblock/lists.json my-chrome-universe/manifest.json` kecuali pengguna ingin bundelnya disegarkan.
- [ ] **Step 4: Dokumentasi** — README (struktur baru, cara memasang "Load unpacked → `my-chrome-universe/`", hapus extension lama; "Catatan untuk menyatukan" diganti "Menambah modul baru": folder `modules/<id>/`, entri `MODULES`, `panel.js` dengan `render`/`status`, awalan pesan/storage, `messageAllowed`, `guardPage`, `registerMenuProvider`); CLAUDE.md (tabel struktur, perintah tes baru, konvensi `core:`/`lock:`); HANDOFF.md (state terbaru, langkah berikutnya = redesign global); PROJECT_HISTORY.md §7 "Penyatuan My Chrome Universe" (keputusan, hasil spike New Tab, bentrokan yang ditemukan); workflow CI memakai path & berkas tes baru.
- [ ] **Step 5: Verifikasi akhir**

Run: `node --test tests/core.test.mjs tests/browser-lock.test.mjs tests/tab-manager.test.mjs tests/ad-blocker.test.mjs`
Expected: `# fail 0`
Run: `for i in 1 2 3 4 5; do node --test tests/universe.e2e.mjs 2>&1 | grep -E "^# (pass|fail)" | tr '\n' ' '; echo; done`
Expected: lima baris dengan `# fail 0`
Run: `grep -rn "chrome.contextMenus.removeAll\|openOptionsPage\|'getState'\|'unlock'" my-chrome-universe --include=*.js`
Expected: hanya `removeAll` di `core/menus.js`; tidak ada nama pesan lock tanpa awalan.
Run: `ls browser-lock tab-manager ad-blocker 2>&1 | head -3`
Expected: ketiganya "No such file or directory".

- [ ] **Step 6: Commit** — pesan: `Add shared settings page and document My Chrome Universe`
- [ ] **Step 7: (Dengan izin pengguna) push & CI** — `git push` lalu `gh workflow run filter-bot.yml --ref main && gh run list --workflow filter-bot.yml --limit 1` → Expected: run hijau. Uji manual oleh pengguna: Load unpacked `my-chrome-universe/`, buat password, simpan kode, restart Chrome.
