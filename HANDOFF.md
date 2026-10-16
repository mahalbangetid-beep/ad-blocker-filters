# Handoff

> Diperbarui: 2026-10-17 (redesign "Universe" selesai)
> Project: E:\AI\ext (Linux: /media/yusuf/Simpan1/AI/ext) → https://github.com/mahalbangetid-beep/ad-blocker-filters
> Session summary: seluruh tampilan **My Chrome Universe** (`my-chrome-universe/`) diganti dengan sistem desain "Universe"
> (tema gelap "Malam" + terang "Fajar", penuh animasi) sesuai prototipe yang disetujui pengguna. Pekerjaan ada di branch
> `universe-redesign` (dibuat dari `my-chrome-universe`/`main` lokal `a9c1860`) yang **belum di-merge dan belum di-push**.

## Goal

Pengguna (berbahasa Indonesia) mengumpulkan tiruan extension Chrome yang ia pakai, versi yang lebih aman/lokal, dan
menyatukannya menjadi satu extension. Penyatuan selesai (desain: `docs/superpowers/specs/2026-10-16-my-chrome-universe-design.md`),
lalu redesign global selesai (desain: `docs/superpowers/specs/2026-10-16-global-redesign-design.md`, prototipe:
`docs/superpowers/specs/assets/2026-10-16-universe-prototype.html`, rencana: `docs/superpowers/plans/2026-10-16-global-redesign.md`).
Filter list Ad Blocker tetap digabung dari banyak sumber dan diperbarui otomatis setiap hari lewat bot di GitHub.

## Current State

**Working (terverifikasi di branch `universe-redesign`):**
- 91 unit test lolos: `node --test tests/core.test.mjs tests/browser-lock.test.mjs tests/tab-manager.test.mjs tests/ad-blocker.test.mjs tests/ui.test.mjs`
  (core 17, browser-lock 31, tab-manager 20, ad-blocker 13, ui 10).
- 42 E2E di Chromium sungguhan lolos (`node --test tests/universe.e2e.mjs`, tiga kali berturut-turut di akhir Task 9):
  semua cakupan lama (iklan, filter saya, allowlist, jeda, sakelar modul, picker, YouTube tiruan, update feed, popup,
  pengaturan, gerbang kunci, kode pemulihan) + baru: sambutan saat startup → login, unlock mengubah tab kunci menjadi
  dashboard, kunci manual tanpa sambutan, pesan "Password salah" seketika di gerak Minim, tombol Kunci meruntuhkan
  dashboard, panduan sekali, arrival hanya di tab kunci, tema berubah di semua halaman tanpa reload, Minim mematikan loop
  kanvas, halaman extension tanpa request ke host lain, kartu `.guard-notice`, login tetap muncul bila kanvas gagal,
  simpan cepat di pengaturan tidak hilang.
- Permukaan baru: sambutan + login + setup (`modules/lock/lock.*`, `setup.*`, `screen.css`), dashboard empat zona
  (`modules/tabs/newtab.*`, `dashboard/*.js`), popup kartu modul + panel (`popup.*`, `modules/*/panel.js`), satu halaman
  pengaturan tanpa iframe (`options.*`, `settings-general.js`, `modules/*/settings.js`), pemberitahuan gerbang
  (`core/page-guard.js`), picker bergaya baru, ikon logo orbit (`icons/*.png`, dibuat `tools/make-icons.mjs`).
  Halaman lama `modules/{lock,adblock}/options.html` tinggal pengalih ke `options.html#<id>`; folder `modules/*/icons` dihapus.
- Tangkapan layar semua permukaan × dua tema sudah dibandingkan dengan prototipe (laporan Task 9 di
  `.superpowers/sdd/2026-10-16-global-redesign/task-9-report.md`; folder `.superpowers/` lokal, diabaikan git).

**Belum dilakukan / perlu pengguna:**
- Branch `universe-redesign` belum di-merge ke `main` dan belum di-push (`main` lokal `a9c1860` juga belum di-push ke
  `origin/main`). Push + CI hanya setelah pengguna setuju.
- Uji manual di Chrome pengguna: Load unpacked `my-chrome-universe/`, restart Chrome → sambutan → login → dashboard.
  Periksa juga: impor bookmark dari palet (izin opsional dipanggil ±120 ms setelah Enter; belum diuji di Chrome bermerek),
  Pengaturan → Tampilan (tema/animasi/aksen), mode Incognito.
- `node tests/feed.live.mjs` dan `node tests/youtube.live.mjs` (butuh internet) belum dijalankan ulang setelah redesign.

**Broken:** tidak ada yang diketahui. Catatan kecil yang ditunda ada di `.superpowers/sdd/2026-10-16-global-redesign/progress.md`
(baris "minor (deferred)"), mis. Escape di panel popup kembali ke beranda (bukan menutup), adblock section di
pengaturan tidak sinkron langsung bila diubah dari popup.

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

1. Pengguna meninjau dan menguji manual branch `universe-redesign` (lihat "Belum dilakukan").
2. Bila pengguna setuju: merge ke `main`, push, jalankan CI
   (`gh workflow run filter-bot.yml --ref main && gh run list --workflow filter-bot.yml --limit 1`) dan pastikan hijau.
3. (Disarankan) Otomatiskan penyegaran bundel: workflow mingguan `node filter-bot/bot.mjs --update-extension`, naikkan
   `version` di manifest, jalankan E2E, lalu commit/PR.
4. Kandidat peningkatan Ad Blocker: `$redirect`/`$redirect-rule` dengan resource netral, domain wildcard `example.*`,
   subset scriptlet aman, pengemasan Chrome Web Store.
5. Modul baru: ikuti README "Menambah modul baru" (registry, `panel.js` + `settings.js`, token/ikon dari `ui/`, `guardPage`).

## Key Constraints

- Jawab dan tulis UI dalam bahasa Indonesia.
- Commit/push, membuat repo, atau tindakan yang terlihat publik hanya setelah pengguna setuju.
- Tanpa request ke host lain dari halaman extension (font/ikon lokal); tanpa build step/dependensi npm.
- Jangan aktifkan Acceptable Ads, telemetri, atau list tanpa lisensi tanpa persetujuan.
- Jangan menerjemahkan filter secara "mendekati"; lewati dan hitung. Feed hanya data; validasi `updater.js` jangan dilonggarkan.

## Memory Pointers

claude-mem dari mesin Windows tidak tersedia di Linux; ringkasannya ada di `docs/PROJECT_HISTORY.md`. Catatan kerja
redesign per tugas (brief, laporan, keputusan, temuan tertunda) ada di `.superpowers/sdd/2026-10-16-global-redesign/`
(hanya di mesin ini; diabaikan git). Keputusan pentingnya sudah dirangkum di `docs/PROJECT_HISTORY.md` §8.
