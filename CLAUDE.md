# CLAUDE.md — koleksi extension Chrome (E:\AI\ext → repo `ad-blocker-filters`)

Dibaca otomatis oleh Claude Code. Briefing lanjutan ada di `HANDOFF.md`; riwayat lengkap, temuan
reverse-engineering, dan alasan setiap keputusan ada di `docs/PROJECT_HISTORY.md`. Baca keduanya sebelum
mengubah arsitektur.

## Tentang pengguna

- Berkomunikasi dalam **bahasa Indonesia**; jawab dalam bahasa Indonesia. Teks UI extension juga berbahasa Indonesia.
- Pola kerjanya: menyebut extension Chrome Web Store yang sudah ia pasang ("buatkan yang serupa dengan X"), lalu kita
  membaca file extension yang terpasang, menjelaskan cara kerjanya, dan membangun versi sendiri yang lebih baik/aman.
- Ketiga extension sudah **disatukan** menjadi satu: **My Chrome Universe** (`my-chrome-universe/`); cara menambah modul
  ada di "Menambah modul baru" di `README.md`. Rencana berikutnya: redesign tampilan global (proyek terpisah).
- Akun GitHub: `mahalbangetid-beep`. Repo publik: https://github.com/mahalbangetid-beep/ad-blocker-filters
- Prinsip yang ia setujui: lokal/tanpa akun, tanpa telemetri, tanpa "Acceptable Ads", sumber filter berlisensi jelas.

## Struktur

| Path | Isi |
|---|---|
| `my-chrome-universe/` | Extension tunggal (MV3): `manifest.json`, `background.js` (meng-import core + modul), `popup.*` (grid modul), `options.*` (pengaturan bersama) |
| `my-chrome-universe/core/` | `modules.js` (registry `MODULES` + status aktif), `gate.js` (status kunci, `messageAllowed`), `page-guard.js` (`guardPage`), `menus.js` (`registerMenuProvider`), `panel.js` (helper panel), `background.js` (`core:*`) |
| `my-chrome-universe/modules/lock/` | Browser Lock: kunci browser dengan password; **gerbang wajib** semua modul |
| `my-chrome-universe/modules/tabs/` | Tab Manager: dashboard New Tab ala Toby (ruang → koleksi → kartu tab) |
| `my-chrome-universe/modules/adblock/` | Ad Blocker ala Adblock Plus (declarativeNetRequest); `filters.js`, `updater.js`, ruleset bawaan |
| `filter-bot/` | Bot yang menggabungkan filter list dari banyak sumber → feed harian di GitHub Pages |
| `tests/` | Unit test (`core`, `browser-lock`, `tab-manager`, `ad-blocker` `.test.mjs`), E2E Chromium (`universe.e2e.mjs`), cek langsung (`*.live.mjs`), harness UI |
| `docs/superpowers/` | Spesifikasi desain penyatuan dan rencana |
| `.github/workflows/filter-bot.yml` | CI harian 01:17 UTC: unit test → bangun feed → verifikasi di Chromium → terbitkan ke `gh-pages` |

Satu extension, Manifest V3, JavaScript murni (ES module), **tanpa build step dan tanpa dependensi npm**.

## Perintah

```bash
# Unit test (Node 24; tidak butuh browser)
node --test tests/core.test.mjs tests/browser-lock.test.mjs tests/tab-manager.test.mjs tests/ad-blocker.test.mjs

# E2E seluruh extension di Chromium sungguhan (butuh Chromium Playwright + openssl)
npx playwright@1 install chromium        # sekali; di Linux tanpa GUI tambahkan --with-deps
node --test tests/universe.e2e.mjs        # CHROME_PATH=/path/chrome untuk memilih browser lain

# Filter bot
node filter-bot/bot.mjs                      # ambil semua sumber → feed/ (feed/ diabaikan git)
node filter-bot/bot.mjs --update-extension   # sekaligus perbarui ruleset bawaan modules/adblock/
node filter-bot/bot.mjs --offline            # bangun ulang dari feed/raw tanpa internet

# Cek langsung (butuh internet)
node tests/feed.live.mjs      # extension mengambil update dari feed GitHub Pages asli
node tests/youtube.live.mjs   # iklan video YouTube asli: modul mati vs hidup

# UI Tab Manager di browser biasa (API chrome tiruan)
node tests/harness/serve.mjs  # lalu buka http://localhost:8765/my-chrome-universe/modules/tabs/newtab.html?harness

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
  (selain layar kunci/setup) `await guardPage('tab'|'popup'|'frame')` sebelum membaca data.
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
- Maksimal 4 shortcut ber-`suggested_key` per extension (terpakai 3: Alt+Shift+L/S/D).
- Commit diakhiri `Co-Authored-By: Claude …`; commit/push hanya bila pengguna meminta.
- Tulis skrip edit panjang ke file lalu jalankan (heredoc ber-kutip di shell sering gagal); path Windows di JS pakai `/`.
