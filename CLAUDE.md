# CLAUDE.md — koleksi extension Chrome (E:\AI\ext → repo `ad-blocker-filters`)

Dibaca otomatis oleh Claude Code. Briefing lanjutan ada di `HANDOFF.md`; riwayat lengkap, temuan
reverse-engineering, dan alasan setiap keputusan ada di `docs/PROJECT_HISTORY.md`. Baca keduanya sebelum
mengubah arsitektur.

## Tentang pengguna

- Berkomunikasi dalam **bahasa Indonesia**; jawab dalam bahasa Indonesia. Teks UI extension juga berbahasa Indonesia.
- Pola kerjanya: menyebut extension Chrome Web Store yang sudah ia pasang ("buatkan yang serupa dengan X"), lalu kita
  membaca file extension yang terpasang, menjelaskan cara kerjanya, dan membangun versi sendiri yang lebih baik/aman.
- Rencana jangka panjang: mengumpulkan beberapa extension lalu **menyatukannya** menjadi satu (lihat "Catatan untuk
  menyatukan" di `README.md`). Saat ini fokus utama: **Ad Blocker**.
- Akun GitHub: `mahalbangetid-beep`. Repo publik: https://github.com/mahalbangetid-beep/ad-blocker-filters
- Prinsip yang ia setujui: lokal/tanpa akun, tanpa telemetri, tanpa "Acceptable Ads", sumber filter berlisensi jelas.

## Struktur

| Folder | Isi |
|---|---|
| `browser-lock/` | Kunci browser dengan password (tiruan "Set password for your browser") |
| `tab-manager/` | Dashboard New Tab ala Toby: ruang → koleksi → kartu tab |
| `ad-blocker/` | Pemblokir iklan ala Adblock Plus (MV3, declarativeNetRequest) |
| `filter-bot/` | Bot yang menggabungkan filter list dari banyak sumber → feed harian di GitHub Pages |
| `tests/` | Unit test (`*.test.mjs`), E2E Chromium (`ad-blocker.e2e.mjs`), cek langsung (`*.live.mjs`), harness UI |
| `.github/workflows/filter-bot.yml` | CI harian 01:17 UTC: unit test → bangun feed → verifikasi di Chromium → terbitkan ke `gh-pages` |

Semua extension adalah Manifest V3, JavaScript murni (ES module), **tanpa build step dan tanpa dependensi npm**.

## Perintah

```bash
# Unit test (Node 24; tidak butuh browser)
node --test tests/browser-lock.test.mjs tests/tab-manager.test.mjs tests/ad-blocker.test.mjs

# E2E Ad Blocker di Chromium sungguhan (butuh Chromium Playwright + openssl)
npx playwright@1 install chromium        # sekali; di Linux tanpa GUI tambahkan --with-deps
node --test tests/ad-blocker.e2e.mjs     # CHROME_PATH=/path/chrome untuk memilih browser lain

# Filter bot
node filter-bot/bot.mjs                      # ambil semua sumber → feed/ (feed/ diabaikan git)
node filter-bot/bot.mjs --update-extension   # sekaligus perbarui ruleset bawaan ad-blocker/
node filter-bot/bot.mjs --offline            # bangun ulang dari feed/raw tanpa internet

# Cek langsung (butuh internet)
node tests/feed.live.mjs      # extension mengambil update dari feed GitHub Pages asli
node tests/youtube.live.mjs   # iklan video YouTube asli: modul mati vs hidup

# UI Tab Manager di browser biasa (API chrome tiruan)
node tests/harness/serve.mjs  # lalu buka http://localhost:8765/tab-manager/newtab.html?harness

# CI
gh workflow run filter-bot.yml --ref main && gh run list --workflow filter-bot.yml --limit 1
```

Branded Google Chrome sejak v137 **mengabaikan `--load-extension`**; tes otomatis harus memakai Chromium Playwright.
Untuk mencoba manual: `chrome://extensions` → Developer mode → Load unpacked → pilih folder extension.

## Konvensi yang wajib dijaga

- **Awalan namespace** (supaya bisa disatukan): Tab Manager → pesan & storage `tm:`; Ad Blocker → `ab:`.
  Browser Lock belum berawalan (`getState`, `unlock`, `settings`, …) — beri awalan `lock:` saat penggabungan.
- Service worker MV3 **tidak boleh top-level await** dan bisa mati kapan saja: simpan state di `chrome.storage`,
  daftarkan listener di top level, muat data secara lazy.
- Ad Blocker: `ad-blocker/filters.js` adalah satu-satunya konverter (dipakai bot di Node *dan* extension untuk filter
  pengguna) — harus tetap JS murni tanpa `chrome.*`. Filter yang tidak bisa diterjemahkan dengan setia **dilewati dan
  dihitung**, jangan pernah diterjemahkan secara mendekati.
- Prioritas DNR: block 1, allow 2, important 3, allow+important 4, allowlist pengguna 100 (`PRIORITY` di filters.js).
- Feed hanya data. `ad-blocker/updater.js` memvalidasi: aksi hanya `block`/`allow`/`allowAllRequests`, prioritas ≤ 10,
  kunci kondisi dari daftar putih, selector tanpa `{}`; SHA-256 tiap file harus cocok dengan `index.json`.
- Domain di ruleset dikelompokkan per **hash FNV-1a** (maks. 700/aturan) agar satu perubahan filter = satu aturan berubah.
  Jangan kembali ke pengelompokan berurutan (diff harian jadi besar).
- Batas Chrome: ≥30.000 aturan statis dijamin per extension (kategori bawaan saat ini ±18.000), 30.000 aturan dinamis
  (updater menyisakan 5.000 untuk allowlist + filter pengguna), 5.000 aturan statis yang dinonaktifkan.
- Komentar kode ringkas berbahasa Inggris (seperti kode yang ada); teks UI berbahasa Indonesia.
- Commit diakhiri `Co-Authored-By: Claude …`; commit/push hanya bila pengguna meminta.
- Tulis skrip edit panjang ke file lalu jalankan (heredoc ber-kutip di shell sering gagal); path Windows di JS pakai `/`.
