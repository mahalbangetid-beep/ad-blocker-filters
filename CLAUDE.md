# CLAUDE.md — koleksi extension Chrome (E:\AI\ext → repo `ad-blocker-filters`)

Dibaca otomatis oleh Claude Code. Briefing lanjutan ada di `HANDOFF.md`; riwayat lengkap, temuan
reverse-engineering, dan alasan setiap keputusan ada di `docs/PROJECT_HISTORY.md`. Baca keduanya sebelum
mengubah arsitektur.

## Tentang pengguna

- Berkomunikasi dalam **bahasa Indonesia**; jawab dalam bahasa Indonesia. Teks UI extension juga berbahasa Indonesia.
- Pola kerjanya: menyebut extension Chrome Web Store yang sudah ia pasang ("buatkan yang serupa dengan X"), lalu kita
  membaca file extension yang terpasang, menjelaskan cara kerjanya, dan membangun versi sendiri yang lebih baik/aman.
- Ketiga extension sudah **disatukan** menjadi satu: **My Chrome Universe** (`my-chrome-universe/`); cara menambah modul
  ada di "Menambah modul baru" di `README.md`. Tampilannya sudah didesain ulang ("Universe": tema gelap "Malam" + terang
  "Fajar", penuh animasi) dan sudah di-merge ke `main` + di-push (lihat `HANDOFF.md`).
- Akun GitHub: `mahalbangetid-beep`. Repo publik: https://github.com/mahalbangetid-beep/ad-blocker-filters
- Prinsip yang ia setujui: lokal/tanpa akun, tanpa telemetri, tanpa "Acceptable Ads", sumber filter berlisensi jelas.

## Struktur

| Path | Isi |
|---|---|
| `my-chrome-universe/` | Extension tunggal (MV3): `manifest.json`, `background.js` (meng-import core + modul), `popup.*` (grid modul), `options.*` (pengaturan bersama) |
| `my-chrome-universe/core/` | `modules.js` (registry `MODULES` + status aktif), `gate.js` (status kunci, `messageAllowed`), `page-guard.js` (`guardPage`), `menus.js` (`registerMenuProvider`), `panel.js` (helper panel), `settings-ui.js` (helper bagian pengaturan), `background.js` (`core:*`) |
| `my-chrome-universe/ui/` | Sistem desain bersama: `tokens.css` (token dua tema, aksen, `@font-face`), `components.css` (komponen, keyframe, tingkat gerak, sambutan, `.guard-notice`), `icons.js` (`ic`/`icon`/`logo`/`hydrateIcons`), `boot.js` (tema dari cermin localStorage sebelum render), `appearance.js` (`core:appearance`), `motion.js` (`wait`/`animate`/`toast`/`countUp`/efek), `sky.js` (kanvas bintang), `welcome.js` (adegan sambutan), `fonts/` (woff2 lokal + OFL) |
| `my-chrome-universe/settings-general.js` | Bagian Umum (tampilan, sakelar modul) dan Tentang di `options.html` |
| `my-chrome-universe/modules/*/settings.js`, `panel.js` | Bagian modul di halaman pengaturan; panel modul di popup |
| `my-chrome-universe/modules/tabs/dashboard/` | Bagian dashboard: `rail.js` (ruang), `collections.js`, `drag.js`, `open-tabs.js`, `palette.js` (Ctrl K), `guide.js`, `dialogs.js`, `backup.js` |
| `tools/make-icons.mjs` | Membuat `icons/icon{16,32,48,128}.png` dari `logo()` lewat Chromium (jalankan sekali bila logo berubah, commit PNG-nya) |
| `my-chrome-universe/modules/lock/` | Browser Lock: kunci browser dengan password; **gerbang wajib** semua modul |
| `my-chrome-universe/modules/tabs/` | Tab Manager: dashboard New Tab ala Toby (ruang → koleksi → kartu tab) |
| `my-chrome-universe/modules/adblock/` | Ad Blocker ala Adblock Plus (declarativeNetRequest); `filters.js`, `updater.js`, ruleset bawaan |
| `filter-bot/` | Bot yang menggabungkan filter list dari banyak sumber → feed harian di GitHub Pages |
| `tests/` | Unit test (`core`, `browser-lock`, `tab-manager`, `ad-blocker`, `ui` `.test.mjs`), E2E Chromium (`universe.e2e.mjs`), cek langsung (`*.live.mjs`), harness UI (`harness/`: dashboard tiruan, `ui-gallery.html`, `sky-demo.html`) |
| `docs/superpowers/` | Spesifikasi desain (penyatuan, redesign Universe + prototipe di `specs/assets/`) dan rencana |
| `.github/workflows/filter-bot.yml` | CI harian 01:17 UTC: unit test → bangun feed → E2E Ad Blocker/feed (tes berawalan `adblock: `) di Chromium → terbitkan ke `gh-pages`; E2E UI penuh di job `ui-e2e` terpisah (tidak menahan feed) |

Satu extension, Manifest V3, JavaScript murni (ES module), **tanpa build step dan tanpa dependensi npm**.

## Perintah

```bash
# Unit test (Node 24; tidak butuh browser)
node --test tests/core.test.mjs tests/browser-lock.test.mjs tests/tab-manager.test.mjs tests/ad-blocker.test.mjs tests/ui.test.mjs

# E2E seluruh extension di Chromium sungguhan (butuh Chromium Playwright + openssl)
npx playwright@1 install chromium        # sekali; di Linux tanpa GUI tambahkan --with-deps
node --test tests/universe.e2e.mjs        # CHROME_PATH=/path/chrome untuk memilih browser lain
node --test --test-name-pattern="^adblock: " tests/universe.e2e.mjs   # hanya Ad Blocker/feed (gerbang terbit CI)

# Filter bot
node filter-bot/bot.mjs                      # ambil semua sumber → feed/ (feed/ diabaikan git)
node filter-bot/bot.mjs --update-extension   # sekaligus perbarui ruleset bawaan modules/adblock/
node filter-bot/bot.mjs --offline            # bangun ulang dari feed/raw tanpa internet

# Cek langsung (butuh internet)
node tests/feed.live.mjs      # extension mengambil update dari feed GitHub Pages asli
node tests/youtube.live.mjs   # iklan video YouTube asli: modul mati vs hidup

# UI Tab Manager di browser biasa (API chrome tiruan)
node tests/harness/serve.mjs  # lalu buka http://localhost:8765/my-chrome-universe/modules/tabs/newtab.html?harness
                              # galeri komponen: http://localhost:8765/tests/harness/ui-gallery.html

# Tangkapan layar dari E2E (opsional): SHOT_DIR=/tmp/shots node --test tests/universe.e2e.mjs
# Ikon PNG dari logo orbit (sekali, lalu commit icons/*.png)
node tools/make-icons.mjs

# CI
gh workflow run filter-bot.yml --ref main && gh run list --workflow filter-bot.yml --limit 1
```

Branded Google Chrome sejak v137 **mengabaikan `--load-extension`**; tes otomatis harus memakai Chromium Playwright.
Untuk mencoba manual: `chrome://extensions` → Developer mode → Load unpacked → pilih `my-chrome-universe/`
(hapus dulu tiga extension lama bila masih terpasang).

## Konvensi yang wajib dijaga

- **Awalan namespace**: Browser Lock → `lock:`; Tab Manager → `tm:`; Ad Blocker → `ab:`; core → `core:` (pesan dan kunci storage).
- **Registry modul**: modul didaftarkan di `MODULES` (`core/modules.js`); popup, halaman pengaturan, sakelar, dan menu
  klik kanan mengikuti daftar itu. Sakelar lewat `core:setModule` (menolak `lock`); Browser Lock hanya lewat
  `lock:setEnabled` (mematikan butuh password saat ini).
- **Gerbang kunci**: Browser Lock wajib. Status (`setup`/`locked`/`open`) dibaca dari storage setiap kali (`lockStatus`,
  tanpa cache). Handler pesan memanggil `messageAllowed(type)` (kecuali `PUBLIC_MESSAGES`); setiap halaman extension
  (selain layar kunci/setup) `await guardPage('tab'|'popup')` sebelum membaca data **atau memutar animasi yang
  memperlihatkan data**. Saat tidak `open`, `guardPage` mengganti halaman dengan kartu `.guard-notice` (tanpa data modul).
- **Pengirim pesan**: setiap listener `onMessage` memanggil `senderAllowed(sender, type)` (`core/gate.js`) dan menjawab
  `{ ok:false, error:'forbidden' }` untuk extension lain atau halaman web; hanya `WEB_MESSAGES` (`ab:addFilter` dari picker)
  boleh datang dari content script.
- **Menu klik kanan**: hanya `core/menus.js` yang boleh memanggil `chrome.contextMenus.removeAll`; modul memakai
  `registerMenuProvider(id, provider)`.
- Aturan dinamis declarativeNetRequest seluruhnya milik modul adblock.
- Service worker MV3 **tidak boleh top-level await** dan bisa mati kapan saja: simpan state di `chrome.storage`,
  daftarkan listener di top level, muat data secara lazy.
- Ad Blocker: `modules/adblock/filters.js` adalah satu-satunya konverter (dipakai bot di Node *dan* extension untuk filter
  pengguna) — harus tetap JS murni tanpa `chrome.*`. Filter yang tidak bisa diterjemahkan dengan setia **dilewati dan
  dihitung**, jangan pernah diterjemahkan secara mendekati.
- Prioritas DNR: block 1, allow 2, important 3, allow+important 4, allowlist pengguna 100 (`PRIORITY` di filters.js).
- Feed hanya data. `modules/adblock/updater.js` memvalidasi: aksi hanya `block`/`allow`/`allowAllRequests`, prioritas ≤ 10,
  kunci kondisi dari daftar putih, selector tanpa `{}`; SHA-256 tiap file harus cocok dengan `index.json`.
- Domain di ruleset dikelompokkan per **hash FNV-1a** (maks. 700/aturan) agar satu perubahan filter = satu aturan berubah.
  Jangan kembali ke pengelompokan berurutan (diff harian jadi besar).
- Batas Chrome: ≥30.000 aturan statis dijamin per extension (kategori bawaan saat ini ±18.000), 30.000 aturan dinamis
  (updater menyisakan 5.000 untuk allowlist + filter pengguna), 5.000 aturan statis yang dinonaktifkan.
- Komentar kode ringkas berbahasa Inggris (seperti kode yang ada); teks UI berbahasa Indonesia.

### Tampilan "Universe" (`ui/`)

- **Token, bukan warna literal**: komponen memakai variabel `tokens.css`. `:root` = tema gelap "Malam",
  `:root[data-ui="light"]` = terang "Fajar"; aksen `:root[data-accent="ion"|"nova"]` (default surya). Teks kecil harus
  ≥ 4,5:1 di kedua tema (dijaga `tests/ui.test.mjs`; varian teks `--solar-text`, `--danger-text`, dll. untuk tema terang).
  Pengecualian: picker di situs web (`modules/adblock/picker.js`) punya palet sendiri di shadow DOM, font sistem,
  gelap/terang dari `prefers-color-scheme` halaman.
- **Tanpa request ke luar**: font lokal di `ui/fonts/` (Unbounded, Plus Jakarta Sans, JetBrains Mono, OFL), tanpa CDN
  (E2E `extension pages make no third-party requests`). Ikon = SVG dari `ui/icons.js` (`<i data-ic="name">` +
  `hydrateIcons()`), bukan emoji.
- **Pengaturan tampilan** `core:appearance` = `{ theme: 'auto'|'light'|'dark', motion: 'full'|'balanced'|'minimal',
  accent: 'solar'|'ion'|'nova', welcome: boolean }`, disimpan **jarang** (hanya kunci yang diubah pengguna) lewat
  `core:setAppearance`; pembaca menormalkan dengan `readAppearance()` (default motion `minimal` bila
  `prefers-reduced-motion`). Halaman memanggil `initAppearance()` + `watchAppearance()`; `applyAppearance` menulis
  cermin `localStorage['mcu:appearance']` yang dibaca `ui/boot.js` (skrip klasik di `<head>`) agar tema terpasang
  sebelum render pertama.
- **Tingkat gerak** `data-motion` di `<html>`: `minimal` = durasi/delay CSS ≈ 0, kanvas digambar statis sekali (tanpa
  loop rAF), sambutan langsung menampilkan teks; `balanced` meredam nebula. Pakai `wait()`/`animate()` dari `motion.js`
  (mengikuti tingkat gerak). Kanvas berhenti saat `document.hidden`, DPR ≤ 2. Pesan error, sisa percobaan, hitung
  mundur, dan kode pemulihan **tidak boleh menunggu animasi**.
- **Kontrak bagian pengaturan**: `modules/<id>/settings.js` mengekspor `summary` dan `render(root, ctx)`; `ctx` =
  `{ send, markSaved, toast, burst, goto }`. Baris dibangun dengan helper `core/settings-ui.js` (`row`, `toggleRow`,
  `expandRow`, `field`, …). Simpan langsung, lalu `ctx.markSaved()`; error di dekat kontrolnya. Nilai yang disimpan
  bersama dalam satu objek dikirim berurutan dengan nilai terbaru yang diinginkan (lihat `modules/lock/settings.js`).
- **Kontrak panel popup**: `panel.js` mengekspor `status()`, `render(root, opts)`, dan opsional `hero()`
  (`{ title, subtitle, value, favUrl? }` atau `null`) untuk kartu situs di beranda popup. Popup lebar 370 px.
- **Alur buka kunci (handoff)**: startup → SW menandai `core:welcome` (session) → layar kunci memutar sambutan sekali →
  login. Setelah `lock:unlock` sukses, layar kunci memutar warp lalu mengirim `lock:handoff`; SW mengubah **tab kunci itu
  sendiri** menjadi `chrome://newtab/` (dashboard) dan menyimpan id tab itu di `tm:arrive` (hanya tab itu yang memutar
  animasi tiba). Tab tersimpan pulih di latar belakang. Bila `lock:handoff` tidak datang dalam 4 dtk, SW melakukannya
  sendiri. Panduan dashboard tampil otomatis sekali (`tm:guideSeen`).
- Maksimal 4 shortcut ber-`suggested_key` per extension (terpakai 3: Alt+Shift+L/S/D).
- Commit diakhiri `Co-Authored-By: Claude …`; commit/push hanya bila pengguna meminta.
- Tulis skrip edit panjang ke file lalu jalankan (heredoc ber-kutip di shell sering gagal); path Windows di JS pakai `/`.
