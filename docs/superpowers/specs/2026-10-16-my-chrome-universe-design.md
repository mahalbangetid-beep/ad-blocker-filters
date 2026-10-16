# My Chrome Universe — desain penyatuan (tahap 1)

> Tanggal: 2026-10-16 · Status: draf untuk disetujui pengguna
> Lingkup: menyatukan Browser Lock, Tab Manager, dan Ad Blocker menjadi **satu** extension Chrome bernama
> "My Chrome Universe". Redesign tampilan global adalah **proyek terpisah berikutnya**, bukan bagian dokumen ini.

## 1. Maksud dan alasan

Pengguna mengumpulkan tiruan extension Chrome yang ia pakai (versi lokal, lebih aman, tanpa telemetri) dan akan terus
menambah fitur baru dari extension lain. Saat ini ketiganya tiga extension terpisah dengan tiga ikon di toolbar. Ia ingin
**satu ikon, satu wadah dengan banyak fitur**, dan wadah itu harus mudah ditambah fitur berikutnya.

Satu ikon hanya mungkin bila ketiganya benar-benar menjadi satu extension (Chrome selalu memberi satu ikon per extension) —
jadi ini penyatuan sungguhan, bukan "bundel" tiga extension.

Urutan yang disepakati: **satukan dulu dengan tampilan yang ada → semua tes hijau → baru redesign global.**

## 2. Pengalaman yang diinginkan (keputusan pengguna)

**Saat Chrome dibuka:**
1. Layar kunci Browser Lock tampil dan meminta password.
2. Password benar → tab yang tadinya terbuka dipulihkan **dan** dashboard Tab Manager (halaman New Tab) dibuka sebagai
   tab yang **aktif/terlihat** (keputusan pengguna). Sekarang `restoreTabs()` hanya membuka tab baru bila tidak ada yang
   dipulihkan — ini berubah. Bila Tab Manager nonaktif, cukup pulihkan tab (tanpa tab dashboard tambahan).
3. Ad Blocker aktif otomatis di belakang.

**Ikon toolbar (popup):**
- Satu ikon "My Chrome Universe".
- Klik → **grid ikon fitur** (🛡 Ad Blocker, 🗂 Tab Manager, 🔒 Browser Lock; ada ruang untuk fitur berikutnya).
- Klik satu ikon → **panel fitur itu memenuhi popup** dengan isi setara popup fitur tersebut sekarang
  (mis. Ad Blocker: sakelar "blokir iklan di situs ini", hitungan diblokir, "Blokir elemen", "Jeda").
- Pindah fitur lewat tombol **← kembali** ke grid. **Tidak ada** baris tab ikon di panel.
- Mockup yang dipilih: `.superpowers/brainstorm/*/content/popup-layout-v2.html`, varian "1 — Tombol ← kembali".

**Sakelar per fitur:**
- Setiap fitur punya sakelar **Aktif/Nonaktif** (keputusan pengguna: "agar mempermudah").
- **Browser Lock wajib** (keputusan pengguna) — lihat §5.3 untuk cara "wajib" diterjemahkan.

**Data:** tidak ada data dari extension lama yang perlu dipindahkan (pengguna baru memasangnya). My Chrome Universe
dipasang dari nol. Pengguna sendiri yang mencopot tiga extension lama di `chrome://extensions` setelah yang baru jalan.

## 3. Tujuan, bukan tujuan, anti-tujuan

**Tujuan**
- Satu extension MV3 "My Chrome Universe", satu ikon, tiga fitur sebagai modul.
- Arsitektur modul: menambah fitur baru = menambah satu folder modul + satu entri pendaftaran, tanpa mengubah modul lain.
- Semua perilaku fitur sekarang tetap bekerja (lihat kriteria berhasil §8).
- Filter bot dan CI harian tetap memperbarui ruleset Ad Blocker di lokasi barunya; URL feed tidak berubah.

**Bukan tujuan (tahap ini)**
- Redesign tampilan (proyek berikutnya). Panel dan halaman memakai tampilan/CSS yang ada sekarang; hanya kerangka baru
  (grid popup, kerangka halaman pengaturan) yang perlu dibuat, cukup rapi dan konsisten dengan gaya sekarang.
- Fitur baru di luar penyatuan (redirect, wildcard domain, scriptlet, Chrome Web Store, dsb.).
- Mempertahankan tiga extension lama sebagai build terpisah.
- Migrasi data dari extension lama.

**Anti-tujuan (gagal walau "jalan")**
- **Penyatuan membuka celah kunci**: apa pun yang bisa dibaca/diubah saat browser terkunci (koleksi tab, pengaturan,
  filter, menonaktifkan kunci) lewat popup, halaman extension, menu, omnibox, atau shortcut.
- Satu modul diam-diam merusak modul lain (menu klik kanan hilang, aturan DNR tertimpa, pesan salah dijawab).
- Ada telemetri, request ke server pihak ketiga baru, atau Acceptable Ads.
- Filter yang tidak bisa diterjemahkan setia dipaksa "mendekati".

## 4. Batasan

- Semua batasan di `CLAUDE.md` tetap berlaku: MV3, JS murni ES module, tanpa build step/dependensi npm; SW tanpa
  top-level await, state di `chrome.storage`, listener di top level; `filters.js` tetap murni tanpa `chrome.*`;
  validasi `updater.js` tidak dilonggarkan; prioritas DNR; bucket hash FNV-1a; batas aturan Chrome.
- Teks UI bahasa Indonesia; komentar kode ringkas bahasa Inggris.
- Maksimal 4 shortcut ber-`suggested_key` per extension (sekarang dipakai 3: Alt+Shift+L, Alt+Shift+S, Alt+Shift+D).
- `chrome_url_overrides.newtab` tidak bisa dilepas saat runtime.
- Commit/push hanya dengan persetujuan pengguna.

## 5. Desain

### 5.1 Struktur folder

Repo tetap `ad-blocker-filters` (alamat feed `https://mahalbangetid-beep.github.io/ad-blocker-filters/` bergantung
pada nama ini). *Keputusan Claude:* folder extension baru `my-chrome-universe/`; isi tiga folder lama **dipindahkan**
(`git mv`) ke modul agar riwayat git terjaga; folder lama hilang.

```
my-chrome-universe/
  manifest.json            gabungan (lihat 5.6)
  background.js            titik masuk SW: impor core + semua modul
  core/                    registry modul, sakelar modul, menu klik kanan bersama, gerbang kunci
  popup.html/.js/.css      grid + wadah panel
  options.html/.js         kerangka pengaturan: menu samping per modul
  icons/                   ikon My Chrome Universe (sementara; final saat redesign)
  modules/
    lock/                  dari browser-lock/  (lock.html, setup.html, crypto.js, …)
    tabs/                  dari tab-manager/   (newtab.html, store.js, …)
    adblock/               dari ad-blocker/    (filters.js, updater.js, rules/, cosmetic/, lists.json, …)
```

### 5.2 Registry modul (kunci "mudah ditambah")

Satu daftar deklaratif (mis. `core/modules.js`) berisi tiap modul: `id` (`lock`, `tabs`, `adblock`), nama tampilan,
ikon grid, panel popup, bagian halaman pengaturan, dan fungsi status singkat untuk petak grid. Popup dan halaman
pengaturan dibangun dari daftar ini; service worker mengimpor modul background masing-masing. Menambah fitur =
folder `modules/<id>/` + satu entri registry (+ izin manifest bila perlu).

Bentuk persis registry, cara panel dimuat ke popup (impor modul JS yang merender ke wadah, atau halaman per modul) dan
cara bagian pengaturan dimuat diserahkan ke pembangun — syaratnya: modul tidak saling mengimpor, dan panel tiap modul
tetap memakai isi/kontrol popup-nya yang sekarang.

### 5.3 Sakelar Aktif/Nonaktif

State di `chrome.storage.local` kunci `core:modules` (mis. `{ lock: true, tabs: true, adblock: true }`), default semua
aktif. Sakelar ada di panel popup tiap fitur dan di halaman pengaturan.

- **Ad Blocker nonaktif**: setara "jeda" tetapi permanen dan terpisah dari jeda: semua ruleset & aturan dinamis tidak
  berlaku, kosmetik dan skrip YouTube tidak disuntik, badge hitungan mati, menu "Blokir elemen…" hilang, update harian
  boleh tetap berjalan. Mengaktifkan kembali memulihkan pengaturan sebelumnya (allowlist, filter saya, kategori).
- **Tab Manager nonaktif**: menu klik kanan, shortcut, dan omnibox `tm` tidak bekerja; New Tab tidak menampilkan
  dashboard. *Dugaan yang harus dicek pembangun:* bila memungkinkan, New Tab diarahkan ke New Tab bawaan Chrome; bila
  tidak, tampilkan halaman kosong sederhana (dengan tautan "Aktifkan Tab Manager"). Data koleksi tidak dihapus.
- **Browser Lock "wajib"**:
  - Saat pertama dipasang, halaman pembuatan password langsung terbuka (perilaku sekarang). Ad Blocker **tidak** lagi
    membuka halaman pengaturannya saat install *(keputusan Claude)*.
  - **Sebelum password dibuat, semua fitur dipaksa menunggu** (keputusan pengguna): dashboard New Tab, popup, halaman
    pengaturan, menu, omnibox, dan shortcut hanya mengarah ke halaman "Buat password". Ini status baru
    "perlu setup" yang diperlakukan seperti terkunci oleh gerbang §5.4 (bedanya: yang boleh terbuka adalah halaman
    setup, bukan layar kunci). Ad Blocker tetap memblokir. Sakelar Browser Lock tidak bisa dimatikan sebelum ada password.
  - Menonaktifkan Browser Lock **mewajibkan password saat ini** *(usulan Claude, tidak dibantah pengguna)*. Saat
    nonaktif: tidak ada kunci saat startup, idle, layar terkunci, maupun shortcut. Password tetap tersimpan, sehingga
    mengaktifkan kembali tidak perlu password baru.
  - Tombol "Hapus password" yang sekarang ada **diganti** oleh sakelar ini.
  - **Kode pemulihan** (keputusan pengguna; satu-satunya tambahan fitur di tahap ini, karena tanpa itu lupa password =
    mencopot seluruh Universe dan kehilangan koleksi tab, filter, pengaturan):
    - saat password dibuat, tampilkan **sekali** kode pemulihan acak (dari `crypto.getRandomValues`, cukup panjang
      untuk tidak bisa ditebak, mudah dicatat) dengan peringatan untuk menyimpannya;
    - simpan hanya hash-nya (PBKDF2 seperti password, `lock:recovery`);
    - di layar kunci ada "Lupa password?" → masukkan kode → buka kunci dan **wajib** membuat password baru; kode lama
      hangus dan kode baru ditampilkan sekali;
    - percobaan kode memakai penghitung & jeda bertingkat yang sama dengan password;
    - dari pengaturan Browser Lock bisa membuat kode baru (perlu password saat ini).

### 5.4 Browser Lock sebagai gerbang (wajib benar)

Setelah disatukan, semua halaman fitur berbagi satu origin `chrome-extension://<id>/`. Saat ini Browser Lock
memperlakukan origin extension-nya sebagai milik sendiri (`isWorthRestoring`, `INTERNAL_URL`) — aman dulu karena
extension-nya hanya berisi halaman kunci, **tidak aman lagi** sekarang. Invarian yang wajib dijaga dan diuji:

- Saat terkunci, satu-satunya halaman extension yang boleh terbuka adalah layar kunci (dan halaman setup bila belum ada
  password). Dashboard New Tab, halaman pengaturan, dan halaman lain milik extension ditutup seperti tab biasa.
- Popup saat terkunci hanya menampilkan "Browser terkunci" + tombol membuka layar kunci; tidak ada grid/panel.
- Penutupan tab bersifat reaktif (halaman bisa sempat tampil sekejap), dan dashboard/popup Tab Manager membaca
  `chrome.storage.local` langsung (`store.js`/`common.js`), bukan lewat pesan. Karena itu *(keputusan Claude)* **setiap
  halaman extension selain layar kunci/setup memeriksa status kunci sebelum merender isi** dan mengosongkan dirinya bila
  status berubah menjadi terkunci (mis. lewat `storage.onChanged`). Ini lapis utama di dalam halaman.
- Service worker juga menolak pesan modul lain (`tm:*`, `ab:*`, `core:*` yang membaca/mengubah data) saat terkunci
  atau perlu setup. Pesan layar kunci/setup (`lock:unlock`, `lock:getState`, `lock:setup`, pemulihan) tetap dilayani.
- **Bukan tujuan:** mengenkripsi data di storage. Orang yang bisa membuka DevTools/profil Chrome tetap bisa membaca data
  — batasan yang sama dengan Browser Lock sekarang (lihat `docs/PROJECT_HISTORY.md` §1).
- Menu klik kanan, omnibox, dan shortcut fitur lain tidak bekerja saat terkunci.
- Halaman extension yang dibuka saat terkunci tidak dipulihkan setelah buka kunci (perilaku sekarang untuk URL internal).
- Ad Blocker tetap memblokir selama terkunci (tidak membuka data apa pun).

### 5.5 Konflik antarmodul yang sudah ditemukan

- **Menu klik kanan**: Ad Blocker (`applyMenu`) dan Tab Manager (`createMenus`) sama-sama memanggil
  `contextMenus.removeAll()` → saling menghapus. Ganti dengan satu pengelola menu di `core/` tempat modul mendaftarkan
  menunya; menu tiap modul mengikuti sakelar modul dan status kunci.
- **Ikon toolbar**: Ad Blocker mengganti ikon per tab menjadi abu-abu saat situs diizinkan/dijeda. *Keputusan Claude:*
  ikon tidak lagi diganti (ikon mewakili seluruh Universe); status Ad Blocker ditampilkan di petak grid dan panelnya.
  Badge hitungan diblokir (`displayActionCountAsBadgeText`, pengaturan `showBadge`) tetap.
- **Nama pesan & storage Browser Lock** diberi awalan `lock:` (pesan `lock:getState`, `lock:unlock`, …; storage
  `lock:auth`, `lock:settings`, `lock:failures`, `lock:lockoutUntil`, `lock:unlocked`, `lock:savedTabs`). Tab Manager
  (`tm:`) dan Ad Blocker (`ab:`) tetap. Core memakai `core:`.
- **onMessage**: tiap modul tetap mendaftarkan listener sendiri dan hanya menjawab tipe berawalannya (`return false`
  untuk yang lain) — pola yang sudah ada.
- **Aturan dinamis DNR** tetap milik Ad Blocker seluruhnya (ia menulis ulang semuanya); modul lain tidak boleh memakai
  aturan dinamis.
- **onInstalled / onStartup**: Browser Lock membuka setup saat install; Tab Manager membuat menu; Ad Blocker mengatur
  ruleset & alarm. Ketiganya harus tetap berjalan dan tidak saling bergantung urutan.
- **Path di dalam Ad Blocker** yang berubah karena pindah folder: `rule_resources` di manifest
  (`modules/adblock/rules/*.json`), skrip yang didaftarkan dinamis (`youtube-main.js`, `youtube.css`, `picker.js`),
  `cosmetic/`, `lists.json`, ikon. Sama untuk `_favicon` / `newtab.html` di Tab Manager dan `lock.html`/`setup.html`.

### 5.6 Manifest gabungan

- `name`: "My Chrome Universe"; `short_name`: "Universe" *(keputusan Claude)*; `version` "1.0.0";
  `minimum_chrome_version` = maksimum dari ketiganya ("121").
- `permissions`: gabungan (`declarativeNetRequest`, `storage`, `unlimitedStorage`, `tabs`, `tabGroups`, `scripting`,
  `webNavigation`, `webRequest`, `contextMenus`, `alarms`, `idle`, `favicon`); `optional_permissions: ["bookmarks"]`;
  `host_permissions: ["<all_urls>"]`.
- Satu `action` → `popup.html`; satu `options_ui` → `options.html` (buka di tab) dengan menu samping per modul;
  tombol ⚙ di panel popup membuka bagian modul itu.
- `chrome_url_overrides.newtab` → `modules/tabs/newtab.html`; `omnibox.keyword` "tm"; tiga `commands` yang ada.
- `declarative_net_request.rule_resources` dengan path baru; tetap dibuat ulang oleh bot.
- Ikon sementara sederhana untuk My Chrome Universe *(keputusan Claude; final saat redesign)*.

### 5.7 Filter bot, CI, dokumentasi

- `filter-bot/bot.mjs`: `EXT_DIR` dan path impor `filters.js` mengikuti lokasi baru; `--update-extension` menulis ruleset,
  `cosmetic/`, `lists.json` ke `modules/adblock/` dan memperbarui `rule_resources` di manifest gabungan **tanpa**
  menyentuh bagian manifest lain.
- `.github/workflows/filter-bot.yml`: path tes diperbarui; feed tetap diterbitkan ke `gh-pages` di URL yang sama.
- Perbarui `README.md`, `CLAUDE.md`, `HANDOFF.md`, `docs/PROJECT_HISTORY.md` (tambahkan bagian penyatuan),
  dan masukkan `.superpowers/` ke `.gitignore`.
- **Git** *(keputusan Claude)*: 17 file di working copy saat ini hanya berbeda akhir baris (CRLF dari Windows;
  `git diff --ignore-cr-at-eol` kosong). Sebelum memindahkan, kembalikan ke LF agar tidak ikut tercampur. Pemindahan
  (`git mv`) dijadikan commit tersendiri tanpa perubahan isi, supaya git mengenalinya sebagai pindahan dan riwayat
  terjaga; perubahan isi menyusul di commit berikutnya. Setiap commit tetap menunggu persetujuan pengguna.

## 6. Pengujian

- Unit test yang ada dipertahankan dengan path/nama baru (`tests/browser-lock.test.mjs`, `tests/tab-manager.test.mjs`,
  `tests/ad-blocker.test.mjs` — boleh diganti nama per modul); background tiap modul tetap bisa diimpor sendiri dengan
  `chrome` tiruan.
- E2E (`tests/ad-blocker.e2e.mjs`, atau suite E2E baru untuk Universe) memuat `my-chrome-universe/` dan mencari service
  worker berdasarkan nama manifest "My Chrome Universe". Ke-13 skenario Ad Blocker tetap ada.
- **Perbaiki tes picker yang flaky** (gagal ±3 dari 6 run penuh di Linux: `display` tetap `block`; dugaan: menunggu
  dengan `sleep` tetap lalu mengklik koordinat hasil hitungan) — tunggu kondisi, bukan waktu.
- Tes baru minimal:
  - popup: grid menampilkan ketiga modul; panel terbuka dan ← kembali bekerja; saat terkunci popup hanya "terkunci";
  - gerbang kunci (§5.4): saat terkunci dashboard New Tab & halaman pengaturan ditutup dan tidak merender isi,
    pesan `tm:`/`ab:` ditolak; sebelum setup semua fitur mengarah ke halaman "Buat password";
  - setelah buka kunci: tab lama dipulihkan dan dashboard menjadi tab aktif;
  - kode pemulihan: kode benar membuka kunci dan memaksa password baru; kode salah dihitung ke jeda bertingkat;
  - E2E perlu cara menyiapkan password di awal (status "perlu setup" kini memblokir fitur);
  - sakelar modul: Ad Blocker nonaktif → iklan tidak diblokir, aktif lagi → diblokir; Tab Manager nonaktif → New Tab
    bukan dashboard; Browser Lock nonaktif hanya dengan password benar;
  - menu klik kanan: menu Ad Blocker dan Tab Manager ada bersamaan.
- `tests/feed.live.mjs`, `tests/youtube.live.mjs`, `tests/harness/serve.mjs` diperbarui ke path baru.

## 7. Diserahkan ke pembangun

Bentuk registry dan cara memuat panel/pengaturan (§5.2); detail visual grid dan kerangka pengaturan (sederhana, gaya
sekarang); urutan langkah pemindahan; nama file tes; cara teknis New Tab saat Tab Manager nonaktif (§5.3);
cara gerbang kunci diterapkan di SW (§5.4) selama invariannya terpenuhi.

## 8. Kriteria berhasil

1. `chrome://extensions` hanya berisi satu extension "My Chrome Universe" dengan satu ikon; Load unpacked folder
   `my-chrome-universe/` tanpa error/peringatan manifest.
2. Alur startup: kunci → buka → tab lama dipulihkan + dashboard Tab Manager aktif; Ad Blocker memblokir tanpa
   disentuh. Pemasangan baru: semua fitur menunggu sampai password dibuat; kode pemulihan ditampilkan sekali.
3. Popup: grid → panel → ← kembali, untuk ketiga fitur, dengan kontrol setara popup lama.
4. Sakelar tiap fitur bekerja seperti §5.3; invarian kunci §5.4 terpenuhi.
5. Semua unit test dan E2E hijau, E2E stabil (mis. 5 run penuh berturut-turut tanpa gagal).
6. `node filter-bot/bot.mjs --update-extension` memperbarui `my-chrome-universe/modules/adblock/` dengan benar;
   CI `filter-bot.yml` lolos di GitHub.
