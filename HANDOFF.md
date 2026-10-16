# Handoff

> Generated: 2026-10-16 (Windows → Linux)
> Project: E:\AI\ext → https://github.com/mahalbangetid-beep/ad-blocker-filters
> Session summary: tiga tiruan extension Chrome (Browser Lock, Tab Manager, Ad Blocker) dibangun dan dites, plus
> filter bot harian di GitHub Actions/Pages dan update otomatis di Ad Blocker. Semua selesai; tidak ada yang rusak.

## Goal

Pengguna (berbahasa Indonesia) mengumpulkan tiruan extension Chrome yang ia pakai, versi yang lebih aman/lokal,
untuk akhirnya **disatukan** menjadi satu extension. Fokus saat ini: **Ad Blocker** yang setara Adblock Plus/AdBlock,
dengan filter list gabungan banyak sumber yang diperbarui otomatis setiap hari lewat bot di GitHub.

## Current State

**Working (terverifikasi):**
- 38 unit test lolos (`node --test tests/browser-lock.test.mjs tests/tab-manager.test.mjs tests/ad-blocker.test.mjs`).
- 13 E2E di Chromium sungguhan lolos (`node --test tests/ad-blocker.e2e.mjs`): blokir jaringan, sembunyikan elemen,
  hitungan, filter saya, allowlist, jeda, semua kategori, picker, YouTube (tiruan), update feed, checksum palsu, feed lama.
- CI `.github/workflows/filter-bot.yml` lolos di GitHub (run terakhir 38877944650); feed terbit di
  https://mahalbangetid-beep.github.io/ad-blocker-filters/index.json (versi 202610160904, `problems: []`).
- `node tests/feed.live.mjs`: extension mengambil feed asli → status `updated`.
- `node tests/youtube.live.mjs`: di YouTube asli iklan video hilang dengan modul aktif.
- Ruleset bawaan di `ad-blocker/` = feed `202610160902` (Iklan 16.942, Indonesia 2.802, Keamanan 1.188,
  Privasi 9.905, Gangguan 8.850 aturan; bawaan aktif ±18.130 dari batas aman 30.000).

**Broken:** tidak ada yang diketahui. Belum diuji di Chrome milik pengguna setelah update terakhir (ia harus reload extension).

## Files in Play

| File | Why It Matters |
|------|---------------|
| `CLAUDE.md` | Aturan kerja, perintah, konvensi (dibaca otomatis) |
| `docs/PROJECT_HISTORY.md` | Temuan reverse-engineering ABP/AdBlock/Toby/Chrome Lock + alasan keputusan + pelajaran |
| `README.md` | Dokumentasi pengguna, tabel sumber filter, catatan penggabungan extension |
| `ad-blocker/filters.js` | Konverter filter → DNR (dipakai bot & extension); bucket hash domain |
| `ad-blocker/updater.js` | Update harian: unduh, cek SHA-256, validasi, diff vs bundel |
| `ad-blocker/background.js` | Service worker: settings, rulesets, aturan dinamis, kosmetik, hitungan, YouTube, alarm |
| `ad-blocker/cosmetic.js` | Mesin CSS penyembunyi elemen |
| `ad-blocker/youtube-main.js` | Buang data iklan dari respons pemutar YouTube (MAIN world) |
| `ad-blocker/lists.json` | Metadata bundel: `feedVersion`, `feedUrl`, kategori (ditulis bot) |
| `filter-bot/bot.mjs`, `filter-bot/sources.json` | Bot penggabung + daftar sumber/kategori |
| `.github/workflows/filter-bot.yml` | CI harian → branch `gh-pages` |
| `tests/ad-blocker.e2e.mjs`, `tests/chromium.mjs` | E2E Chromium + pencari Chromium lintas OS |

## What Has Been Tried (and Why It Failed)

Semuanya sudah diperbaiki; jangan diulangi:
- **`--load-extension` di Google Chrome bermerek** → diabaikan sejak v137. Pakai Chromium Playwright.
- **Ambil SW pertama di CDP** → itu component extension Chromium; cari berdasarkan `getManifest().name`.
- **Iklan video YouTube via aturan jaringan** → mustahil (iklan di data pemutar); pakai `youtube-main.js`.
- **Halaman tiruan YouTube lewat HTTP** → Chromium baru memaksa HTTPS (HSTS); tes memakai HTTPS self-signed.
- **AdGuard Tracking Protection di kategori Privasi** → ±240 ribu aturan, melampaui batas; dinonaktifkan.
- **Pengelompokan domain berurutan** → diff harian membengkak; diganti bucket hash FNV-1a.
- **`runUpdate` berbagi promise berjalan** → update manual bisa memakai feedUrl lama; diganti antrean.
- **Push file workflow dengan token tanpa scope `workflow`** → ditolak; perlu `gh auth refresh -s workflow`.
- **Heredoc ber-kutip berisi kode di shell** → error parsing; tulis skrip ke file lalu jalankan.
- **Simulasi drag dari tool browser** → tidak andal; uji DnD dengan `DragEvent` sintetis.

## Current Best Theory

Arsitektur sudah benar dan setara ABP: ruleset bawaan statis + diff harian dari feed (aturan dinamis +
`updateStaticRules`). Risiko utama jangka panjang: bundel makin tertinggal dari feed → diff mendekati batas
(30.000 dinamis / 5.000 dinonaktifkan). Jawabannya: memperbarui bundel secara berkala (lihat langkah 2).

## Next Steps

1. Siapkan lingkungan Linux: Node 24, `git clone https://github.com/mahalbangetid-beep/ad-blocker-filters`,
   `npx playwright@1 install --with-deps chromium`, pastikan `openssl` ada, `gh auth login` (scope `repo`, `workflow`).
   Jalankan unit test + E2E dari `CLAUDE.md` untuk memastikan semuanya hijau di Linux.
2. (Disarankan) Otomatiskan penyegaran bundel: workflow mingguan yang menjalankan
   `node filter-bot/bot.mjs --update-extension`, menaikkan `version` di `ad-blocker/manifest.json`, menjalankan E2E,
   lalu membuat commit/PR (atau rilis zip untuk Chrome Web Store). Saat ini bundel hanya diperbarui manual.
3. Tanyakan pengguna langkah berikutnya untuk Ad Blocker; kandidat yang sudah teridentifikasi:
   - dukung `$redirect`/`$redirect-rule` dengan resource netral bawaan (±2.500 filter dilewati sekarang);
   - domain wildcard `example.*` (±2.400 filter dilewati) dengan memperluas ke TLD umum;
   - subset scriptlet aman (`set-constant`, `json-prune`) dengan kode dibundel dan parameter dari feed (data, bukan kode);
   - pengemasan & penerbitan ke Chrome Web Store.
4. Bila pengguna menyebut extension baru untuk ditiru: baca folder instalasinya
   (`~/.config/google-chrome/Default/Extensions/<id>/<versi>`), jelaskan temuan, bangun di folder baru dengan
   awalan pesan/storage sendiri, tambahkan unit test, catat di `docs/PROJECT_HISTORY.md` dan README.
5. Penggabungan extension (bila diminta): ikuti "Catatan untuk menyatukan" di README; beri awalan `lock:` pada Browser Lock;
   satu `background.js` yang mengimpor modul tiap fitur; gabungkan manifest (maks 4 shortcut ber-`suggested_key`).

## Key Constraints

- Jawab dan tulis UI dalam bahasa Indonesia.
- Commit/push, membuat repo, atau tindakan yang terlihat publik hanya setelah pengguna setuju.
- Jangan aktifkan Acceptable Ads, telemetri, atau list tanpa lisensi (`adblock_custom`, Distraction Control) tanpa persetujuan.
- Jangan menerjemahkan filter secara "mendekati"; lewati dan hitung.
- Feed hanya boleh berisi data; validasi di `updater.js` jangan dilonggarkan.
- Kategori bawaan harus tetap ≤30.000 aturan (bot mencetak peringatan bila lewat).

## Memory Pointers

claude-mem sesi ini ada di mesin Windows dan tidak tersedia di Linux. Ringkasan isinya (sesi S3, S8, S11, S12, S13:
ad blocker, publikasi GitHub, update harian) sudah dipindahkan ke `docs/PROJECT_HISTORY.md`.
Di Linux, claude-mem akan mulai mencatat dari nol; dokumen inilah sumber konteksnya.
