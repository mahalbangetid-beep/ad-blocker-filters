# Handoff

> Diperbarui: 2026-10-17 (redesign "Universe" selesai, di-merge ke `main` dan di-push)
> Project: E:\AI\ext (Linux: /media/yusuf/Simpan1/AI/ext) → https://github.com/mahalbangetid-beep/ad-blocker-filters
> Session summary: seluruh tampilan **My Chrome Universe** (`my-chrome-universe/`) diganti dengan sistem desain "Universe"
> (tema gelap "Malam" + terang "Fajar", penuh animasi) sesuai prototipe yang disetujui pengguna. Pengguna sudah menguji
> manual dan menyetujui; branch `universe-redesign` di-fast-forward ke `main` (`1437e9c`) dan di-push ke `origin/main`.
> CI run 39004277525 (`build` + `ui-e2e`) hijau, feed terbit ke `gh-pages`.

## Goal

Pengguna (berbahasa Indonesia) mengumpulkan tiruan extension Chrome yang ia pakai, versi yang lebih aman/lokal, dan
menyatukannya menjadi satu extension. Penyatuan selesai (desain: `docs/superpowers/specs/2026-10-16-my-chrome-universe-design.md`),
lalu redesign global selesai (desain: `docs/superpowers/specs/2026-10-16-global-redesign-design.md`, prototipe:
`docs/superpowers/specs/assets/2026-10-16-universe-prototype.html`, rencana: `docs/superpowers/plans/2026-10-16-global-redesign.md`).
Filter list Ad Blocker tetap digabung dari banyak sumber dan diperbarui otomatis setiap hari lewat bot di GitHub.

## Current State

**Working (terverifikasi di `main` = `1437e9c`, dijalankan ulang sebelum merge):**
- 92 unit test lolos: `node --test tests/core.test.mjs tests/browser-lock.test.mjs tests/tab-manager.test.mjs tests/ad-blocker.test.mjs tests/ui.test.mjs`
  (core 17, browser-lock 32, tab-manager 20, ad-blocker 13, ui 10).
- 44 E2E di Chromium sungguhan lolos (`node --test tests/universe.e2e.mjs`, dua kali berturut-turut setelah perbaikan
  review akhir); 13 tes Ad Blocker/feed berawalan `adblock: ` adalah gerbang terbit CI
  (`node --test --test-name-pattern="^adblock: " tests/universe.e2e.mjs`), E2E penuh berjalan di job `ui-e2e` terpisah.
  Cakupan:
  semua cakupan lama (iklan, filter saya, allowlist, jeda, sakelar modul, picker, YouTube tiruan, update feed, popup,
  pengaturan, gerbang kunci, kode pemulihan) + baru: sambutan saat startup → login, unlock mengubah tab kunci menjadi
  dashboard, kunci manual tanpa sambutan, pesan "Password salah" seketika di gerak Minim, tombol Kunci meruntuhkan
  dashboard, panduan sekali, arrival hanya di tab kunci, tema berubah di semua halaman tanpa reload, Minim mematikan loop
  kanvas, halaman extension tanpa request ke host lain, kartu `.guard-notice`, login tetap muncul bila kanvas gagal,
  simpan cepat di pengaturan tidak hilang, zona tab terbuka (simpan sesi + tutup, hapus duplikat, simpan satu tab ke
  "Disimpan", `newtab.html?q=`), tombol Kunci di popup dan Pengaturan juga meruntuhkan halaman dulu.
- Permukaan baru: sambutan + login + setup (`modules/lock/lock.*`, `setup.*`, `screen.css`), dashboard empat zona
  (`modules/tabs/newtab.*`, `dashboard/*.js`), popup kartu modul + panel (`popup.*`, `modules/*/panel.js`), satu halaman
  pengaturan tanpa iframe (`options.*`, `settings-general.js`, `modules/*/settings.js`), pemberitahuan gerbang
  (`core/page-guard.js`), picker bergaya baru, ikon logo orbit (`icons/*.png`, dibuat `tools/make-icons.mjs`).
  Halaman lama `modules/{lock,adblock}/options.html` tinggal pengalih ke `options.html#<id>`; folder `modules/*/icons` dihapus.
- Tangkapan layar semua permukaan × dua tema sudah dibandingkan dengan prototipe (buat ulang dengan
  `SHOT_DIR=/tmp/shots node --test tests/universe.e2e.mjs`).

**Belum dilakukan / perlu pengguna:**
- Branch lokal `universe-redesign` identik dengan `main`; boleh dihapus bila pengguna setuju.
- `node tests/feed.live.mjs` dan `node tests/youtube.live.mjs` (butuh internet) belum dijalankan ulang setelah redesign.

**Broken:** tidak ada yang diketahui. Catatan kecil yang ditunda: Escape di panel popup kembali ke beranda (bukan
menutup), bagian Ad Blocker di pengaturan tidak sinkron langsung bila diubah dari popup.

## Files in Play

| File | Why It Matters |
|------|---------------|
| `CLAUDE.md` | Aturan kerja, perintah, konvensi (termasuk tampilan Universe) — dibaca otomatis |
| `docs/PROJECT_HISTORY.md` | Temuan + alasan keputusan + pelajaran (§7 penyatuan, §8 redesign) |
| `docs/superpowers/specs/2026-10-16-global-redesign-design.md` + `assets/…prototype.html` | Desain redesign (otoritas visual: prototipe) |
| `my-chrome-universe/ui/` | Sistem desain: token dua tema, komponen, ikon, font lokal, appearance, motion, sky, welcome |
| `my-chrome-universe/core/` | Registry, gerbang kunci (`gate.js`, `page-guard.js`), menu, helper panel/pengaturan, `core:setAppearance` |
| `my-chrome-universe/modules/lock/background.js` | Kunci, setup, kode pemulihan, penyapuan, handoff tab kunci → dashboard |
| `my-chrome-universe/modules/tabs/` | Dashboard (satu penulis data: service worker); `dashboard/*.js` per zona |
| `my-chrome-universe/modules/adblock/filters.js`, `updater.js` | Konverter filter → DNR; update harian |
| `tests/universe.e2e.mjs`, `tests/ui.test.mjs` | E2E (tes gerbang kunci tetap terakhir) dan penjaga sistem desain |
| `tools/make-icons.mjs` | PNG ikon dari `logo()` lewat Chromium (tanpa dependensi) |

## What Has Been Tried (and Why It Failed)

Semuanya sudah diperbaiki; jangan diulangi (lengkapnya di `docs/PROJECT_HISTORY.md`):
- **`--load-extension` di Google Chrome bermerek** → diabaikan sejak v137. Pakai Chromium Playwright.
- **Ambil SW pertama di CDP** → itu component extension Chromium; cari berdasarkan `getManifest().name`.
- **Iklan video YouTube via aturan jaringan** → mustahil; pakai `youtube-main.js`.
- **Pengelompokan domain berurutan** → diff harian membengkak; diganti bucket hash FNV-1a.
- **`chrome.contextMenus.removeAll` di tiap modul** → saling menghapus menu; sekarang hanya `core/menus.js`.
- **`location.replace`/`tabs.update` ke `chrome://newtab/` saat Tab Manager mati** → diblokir / loop; pakai `chrome://new-tab-page/`.
- **Tab dashboard baru setelah unlock** → terasa seperti ganti tab; kini tab kunci itu sendiri yang menjadi dashboard (`lock:handoff`).
- **Flag "baru tiba" berupa boolean** → tab lain yang terbuka bersamaan ikut memutar arrival; kini `tm:arrive` = id tab kunci.
- **Menyimpan seluruh `core:appearance` yang dinormalkan** → default `prefers-reduced-motion` terkunci; kini hanya kunci yang diubah pengguna.
- **Pengaturan yang membandingkan dengan balasan terakhir / membangun dari data lama** → nilai hilang saat diubah cepat;
  kini dibandingkan dengan nilai terakhir yang dikirim, dibangun dari kontrol di halaman, dan dikirim berurutan.
- **E2E menunggu "ada tab aktif ber-URL"** setelah unlock → bisa masih URL layar kunci; kini menunggu URL dashboard,
  dan `waitFor` menganggap evaluasi yang gagal saat navigasi sebagai "belum".
- **Heredoc ber-kutip berisi kode di shell** → error parsing; tulis skrip ke file lalu jalankan.

## Current Best Theory

Arsitektur extension dan sistem desain sudah stabil. Risiko jangka panjang tetap di Ad Blocker: bundel makin tertinggal
dari feed → diff mendekati batas (30.000 dinamis / 5.000 dinonaktifkan). Jawabannya: memperbarui bundel berkala.

## Next Steps

1. Jalankan ulang tes langsung `node tests/feed.live.mjs` dan `node tests/youtube.live.mjs` (butuh internet).
2. (Disarankan) Otomatiskan penyegaran bundel: workflow mingguan `node filter-bot/bot.mjs --update-extension`, naikkan
   `version` di manifest, jalankan E2E, lalu commit/PR.
3. Kandidat peningkatan Ad Blocker: `$redirect`/`$redirect-rule` dengan resource netral, domain wildcard `example.*`,
   subset scriptlet aman, pengemasan Chrome Web Store.
4. Modul baru: ikuti README "Menambah modul baru" (registry, `panel.js` + `settings.js`, token/ikon dari `ui/`, `guardPage`).

## Key Constraints

- Jawab dan tulis UI dalam bahasa Indonesia.
- Commit/push, membuat repo, atau tindakan yang terlihat publik hanya setelah pengguna setuju.
- Tanpa request ke host lain dari halaman extension (font/ikon lokal); tanpa build step/dependensi npm.
- Jangan aktifkan Acceptable Ads, telemetri, atau list tanpa lisensi tanpa persetujuan.
- Jangan menerjemahkan filter secara "mendekati"; lewati dan hitung. Feed hanya data; validasi `updater.js` jangan dilonggarkan.

## Memory Pointers

claude-mem dari mesin Windows tidak tersedia di Linux; ringkasannya ada di `docs/PROJECT_HISTORY.md`. Keputusan penting
redesign dirangkum di `docs/PROJECT_HISTORY.md` §8.
