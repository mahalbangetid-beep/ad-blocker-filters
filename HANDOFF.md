# Handoff

> Diperbarui: 2026-10-16 (penyatuan selesai)
> Project: E:\AI\ext → https://github.com/mahalbangetid-beep/ad-blocker-filters
> Session summary: tiga tiruan extension (Browser Lock, Tab Manager, Ad Blocker) kini disatukan menjadi satu extension
> **My Chrome Universe** (`my-chrome-universe/`), lengkap dengan popup grid modul dan halaman pengaturan bersama.
> Pekerjaan ada di branch `my-chrome-universe` yang **belum di-merge dan belum di-push**.

## Goal

Pengguna (berbahasa Indonesia) mengumpulkan tiruan extension Chrome yang ia pakai, versi yang lebih aman/lokal, dan
menyatukannya menjadi satu extension. Penyatuan sudah selesai (desain: `docs/superpowers/specs/2026-10-16-my-chrome-universe-design.md`).
Filter list Ad Blocker tetap digabung dari banyak sumber dan diperbarui otomatis setiap hari lewat bot di GitHub.

## Current State

**Working (terverifikasi di branch `my-chrome-universe`):**
- 62 unit test lolos: `node --test tests/core.test.mjs tests/browser-lock.test.mjs tests/tab-manager.test.mjs tests/ad-blocker.test.mjs`
  (core 9, browser-lock 21, tab-manager 19, ad-blocker 13).
- 22 E2E di Chromium sungguhan lolos (`node --test tests/universe.e2e.mjs`): blokir/sembunyikan iklan, hitungan, filter
  saya, allowlist, jeda, sakelar modul, picker, YouTube (tiruan), update feed (+ checksum palsu, feed lama), popup grid,
  halaman pengaturan bersama, dan gerbang kunci (kunci menutup halaman extension, buka kunci memulihkan tab, kode pemulihan).
- Satu extension: popup = grid modul → panel; sakelar Aktif per modul; Browser Lock jadi gerbang wajib (status `setup`
  sampai password dibuat) dengan kode pemulihan; menu klik kanan bersama; halaman `options.html#<id>` dengan menu samping.
- Bot memakai `my-chrome-universe/modules/adblock/` sebagai tujuan `--update-extension`; ruleset bawaan = feed
  `202610160902` (aturan dari run bot terbaru identik, jadi tidak ada perubahan bundel); bawaan aktif ±18.130 dari batas 30.000.
- CI `.github/workflows/filter-bot.yml` sudah memakai path dan berkas tes baru, **tetapi belum dijalankan** untuk branch ini
  (belum di-push). Feed publik: https://mahalbangetid-beep.github.io/ad-blocker-filters/index.json.
- `node tests/feed.live.mjs` dan `node tests/youtube.live.mjs` (butuh internet) belum dijalankan ulang setelah penyatuan.

**Belum dilakukan / perlu pengguna:**
- Branch `my-chrome-universe` belum di-merge ke `main` dan belum di-push; push + `gh workflow run filter-bot.yml --ref main`
  hanya setelah pengguna setuju.
- Uji manual di Chrome pengguna: **hapus dulu ketiga extension lama** di `chrome://extensions` (Browser Lock, Tab Manager,
  Ad Blocker) agar shortcut/New Tab/menu tidak bentrok, lalu Load unpacked `my-chrome-universe/`, buat password, simpan
  kode pemulihan, restart Chrome. Data lama tidak dimigrasi.
- Catatan New Tab: bila Tab Manager dimatikan, extension membuka `chrome://new-tab-page/` lewat `chrome.tabs.update`
  (lihat `docs/PROJECT_HISTORY.md` §7); halaman pemberitahuan tetap ada sebagai cadangan.

**Broken:** tidak ada yang diketahui.

## Files in Play

| File | Why It Matters |
|------|---------------|
| `CLAUDE.md` | Aturan kerja, perintah, konvensi (dibaca otomatis) |
| `docs/PROJECT_HISTORY.md` | Temuan reverse-engineering + alasan keputusan + pelajaran (§7 = penyatuan) |
| `docs/superpowers/specs/2026-10-16-my-chrome-universe-design.md` | Desain penyatuan (otoritas) |
| `README.md` | Dokumentasi pengguna, sumber filter, "Menambah modul baru" |
| `my-chrome-universe/core/` | Registry `MODULES`, gerbang kunci (`gate.js`, `page-guard.js`), menu bersama, helper panel |
| `my-chrome-universe/modules/adblock/filters.js` | Konverter filter → DNR (dipakai bot & extension); bucket hash domain |
| `my-chrome-universe/modules/adblock/updater.js` | Update harian: unduh, cek SHA-256, validasi, diff vs bundel |
| `my-chrome-universe/modules/adblock/background.js` | Settings, rulesets, aturan dinamis, kosmetik, hitungan, YouTube, alarm |
| `my-chrome-universe/modules/lock/background.js` | Kunci, setup, kode pemulihan, penyapuan tab |
| `my-chrome-universe/modules/tabs/` | Dashboard Tab Manager (satu penulis data: service worker) |
| `filter-bot/bot.mjs`, `filter-bot/sources.json` | Bot penggabung + daftar sumber/kategori |
| `.github/workflows/filter-bot.yml` | CI harian → branch `gh-pages` |
| `tests/universe.e2e.mjs`, `tests/chromium.mjs` | E2E Chromium (tes gerbang kunci harus tetap terakhir) + pencari Chromium lintas OS |

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
- **`chrome.contextMenus.removeAll` di tiap modul** → saling menghapus menu; sekarang hanya `core/menus.js`.
- **`location.replace`/`tabs.update` ke `chrome://newtab/` untuk New Tab bawaan** → diblokir / loop reload; yang berhasil
  `chrome.tabs.update(tabId, {url:'chrome://new-tab-page/'})`.
- **Ad Blocker membuka halaman opsinya saat install** (`openOptionsPage`) → di extension gabungan halaman itu muncul sebelum password ada; dihapus, yang terbuka saat install adalah halaman setup password.
- **Simulasi drag dari tool browser** → tidak andal; uji DnD dengan `DragEvent` sintetis.

## Current Best Theory

Arsitektur sudah benar dan setara ABP: ruleset bawaan statis + diff harian dari feed (aturan dinamis +
`updateStaticRules`). Risiko utama jangka panjang: bundel makin tertinggal dari feed → diff mendekati batas
(30.000 dinamis / 5.000 dinonaktifkan). Jawabannya: memperbarui bundel secara berkala (lihat langkah 4).

## Next Steps

1. **Redesign global** (proyek berikutnya): satukan tampilan popup, halaman pengaturan, dashboard New Tab, layar kunci, dan
   halaman opsi tiap modul (kini masih tiga gaya visual berbeda, dibungkus iframe di `options.html`). Mulai dengan
   `superpowers:brainstorming`; tanyakan arah visual kepada pengguna.
2. Pengguna menguji manual: hapus tiga extension lama → Load unpacked `my-chrome-universe/` → buat password → simpan
   kode pemulihan → restart Chrome. Laporkan bug ke sini.
3. Bila pengguna setuju: merge branch `my-chrome-universe` ke `main`, push, jalankan CI
   (`gh workflow run filter-bot.yml --ref main && gh run list --workflow filter-bot.yml --limit 1`) dan pastikan hijau.
4. (Disarankan) Otomatiskan penyegaran bundel: workflow mingguan `node filter-bot/bot.mjs --update-extension`, naikkan
   `version` di manifest, jalankan E2E, lalu commit/PR. Saat ini bundel hanya diperbarui manual.
5. Kandidat peningkatan Ad Blocker: `$redirect`/`$redirect-rule` dengan resource netral (±2.500 filter dilewati), domain
   wildcard `example.*` (±2.400), subset scriptlet aman (`set-constant`, `json-prune`), pengemasan Chrome Web Store.
6. Bila pengguna menyebut extension baru untuk ditiru: baca folder instalasinya (`~/.config/google-chrome/Default/Extensions/<id>/<versi>`),
   jelaskan temuan, bangun sebagai modul baru (`README.md` → "Menambah modul baru"), tambahkan tes, catat di `docs/PROJECT_HISTORY.md`.

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
