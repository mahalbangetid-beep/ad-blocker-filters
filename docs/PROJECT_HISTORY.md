# Riwayat proyek

Dibangun dalam satu sesi Claude Code di Windows (16 Oktober 2026), lalu dilanjutkan di Linux.
Dokumen ini menyimpan hal yang **tidak** bisa dibaca ulang dari kode: apa yang ditemukan di extension aslinya,
mengapa keputusan diambil, dan kesalahan yang sudah pernah terjadi. Extension asli dianalisis dari folder instalasi
Chrome di Windows (`%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\<id>\<versi>`); di Linux lokasinya
`~/.config/google-chrome/Default/Extensions/<id>/<versi>`. ABP dan Toby sudah dicopot pengguna setelah dianalisis.

Urutan kerja: Browser Lock → Tab Manager → Ad Blocker → iklan video YouTube → filter bot + GitHub → update harian.

---

## 1. Browser Lock (`browser-lock/`)

**Asli:** "Set password for your browser (chrome lock)" v9.1, id `cjmjgijhapgicbhmniemjkjeaedanank`, 4 file JS kecil.

Temuan:
- Saat `onStartup`, semua tab ditutup (URL disimpan), lalu dibuka `options-1.html` untuk meminta password; pindah ke
  tab lain menutup jendela; password benar → tab dibuka kembali.
- Celah: password disimpan **plaintext** di `chrome.storage.local` (`key`); `options.html` (setup) bisa dibuka siapa saja
  dan **menimpa password tanpa password lama**; status kunci hanya di variabel service worker (MV3 mematikan SW setelah
  ±30 detik → kunci bisa jebol); tanpa batas percobaan; tanpa kunci manual/idle.

Versi kita: PBKDF2-SHA256 310k iterasi + salt + perbandingan constant-time (`crypto.js`); status "terbuka" di
`storage.session` (otomatis hilang saat browser ditutup → setiap startup terkunci); penegakan lewat listener tab di top
level (tab baru/navigasi/aktivasi → disimpan & ditutup, tab kunci dipastikan ada dulu agar browser tidak keluar);
jeda bertingkat setelah 5 kali salah (30 detik → maks 15 menit, penghitung di `storage.local` agar tidak reset saat
restart); kunci sekarang (Alt+Shift+L), kunci saat idle, kunci saat layar komputer dikunci; ganti/hapus password wajib
password lama.

Pelajaran: halaman `chrome://` yang dicoba dibuka saat terkunci sempat ikut dipulihkan setelah buka kunci → tab yang
muncul saat terkunci hanya diingat bila bukan URL internal (`INTERNAL_URL` di background.js).
Batasan yang diakui: DevTools pada halaman kunci, profil Chrome lain, atau `--disable-extensions` bisa melewati kunci.

## 2. Tab Manager (`tab-manager/`)

**Asli:** "Toby: Tab Manager & Session Saver" v2.0.0.14, id `hddnkoipeenegfoeaoibdmnaalmgkpip`; React + Tailwind
(±2 MB JS), backend `api2.gettoby.com`.

Temuan: mengganti New Tab; sidebar Spaces/Workspaces, koleksi kartu, panel tab terbuka untuk di-drag; Save Session
(tutup/biarkan), tab groups, hapus duplikat, bintang, pencarian, impor bookmark, ekspor/impor, tema; popup atau side
panel; menu klik kanan "Toby → Save Session / Open Toby"; omnibox `to/` untuk short link server; favicon dari
`google.com/s2/favicons`. Akun, sinkronisasi, tim, berbagi publik, dan "smart features" berbayar butuh server.

Versi kita: lokal saja; satu kunci `tm:data` di storage; **service worker adalah satu-satunya penulis** (antrean
promise) agar banyak tab dashboard + popup tidak saling menimpa; model data murni di `store.js` (dites di Node);
favicon dari cache Chrome (`_favicon/`, izin `favicon`) — tidak ada request keluar; omnibox `tm` mencari tab tersimpan;
pengelompokan tab group; impor format ekspor Toby (`{lists:[{title,cards}]}`, ditebak, belum diuji dengan file asli).

Pelajaran: `replaceChildren()` tidak meratakan array dan menulis `undefined` sebagai teks (bug dialog); atribut
`[hidden]` kalah oleh `display:flex` → aturan `[hidden]{display:none!important}`; `prompt()` di popup tidak andal;
simulasi drag dari tool browser tidak andal → uji drag & drop dengan `DragEvent` sintetis; screenshot pane bisa basi →
verifikasi state lewat JS.

## 3. Ad Blocker (`ad-blocker/`)

**Asli:** Adblock Plus v4.47.0 (id `cfhdojbkjhnklbpkdaibdccddilifddb`, eyeo) — dianalisis lewat source map
(`background.js.map` berisi `sourcesContent`; mesin `@eyeo/webext-ad-filtering-solution`, "EWE").
Kemudian AdBlock v6.49.0 (id `gighmmpiobklfepjocnamgkkbiglidom`, juga eyeo, masih terpasang di Windows).

Temuan ABP:
- Filter list dibundel sebagai teks (`data/rules/abp/<uuid>`) **dan** sudah dikonversi ke ruleset DNR statis
  (`data/rules/dnr/<uuid>`, ±6 MB per list). Aktif bawaan: EasyList, ABP filters (anti-circumvention), **Acceptable Ads**
  ("Allow nonintrusive advertising" — model bisnis eyeo; sengaja tidak kita tiru).
- Penyembunyian elemen: CSS `selector {display: none !important;}` per selector, disuntik per frame lewat
  `scripting.insertCSS` origin USER. Allowlist situs: aturan dinamis `allowAllRequests`.
  Hitungan blokir: `webRequest.onErrorOccurred` dengan `net::ERR_BLOCKED_BY_CLIENT`.
- Update: `data/rules/index.json` tiap list punya `url` (`easylist-downloads.adblockplus.org/v3/full/<list>.txt`) dan
  `diff_url` (`…/v3/diff/<list>/<hash-versi-bundel>.json`) → ABP mengunduh **diff** terhadap versi bundel lalu memasangnya
  sebagai aturan dinamis (sejak ABP 3.22). Header `Expires`: EasyList 1–4 hari, ABP anti-cv 1 jam.
- Ekstra AdBlock: Fanboy's Annoyance, NoCoin, Adblock Warning Removal List, `adblock_custom.txt` dan Distraction
  Control (`cdn.adblockcdn.com`) — dua terakhir **tanpa lisensi** → dinonaktifkan di bot.
- uBlock Origin Lite tidak memperbarui list di luar update extension; AdGuard MV3 memakai "Quick Fixes" lewat aturan dinamis.

Versi kita:
- `filters.js`: konverter sintaks ABP/uBO/AdGuard → DNR + data kosmetik. Didukung: `||`, `|`, `*`, `^`, tipe & ~tipe,
  1p/3p, `domain=`/`from=`, `to=`, `denyallow=`, `method=`, `match-case`, `important`, `document`, `all`, `reason=`
  (diabaikan), `@@` + `$document/$elemhide/$generichide/$specifichide`, `$badfilter` lintas list, baris hosts, hostname
  polos (flavor ubo/adguard), `!#if/!#else/!#endif`, `##`, `#@#`, `#?#` yang hanya `:-abp-has()` (→ `:has()`).
  Dilewati & dihitung: regex, snippet/scriptlet (`#$#`, `##+js()`), HTML filtering, injeksi CSS AdGuard (`#$?#`, `$$`),
  `$redirect`, `$removeparam`, `$csp`, `$popup`, selector prosedural, domain wildcard `example.*`.
- `cosmetic.js`: mesin CSS per hostname (generic di-cache sekali, exception per domain, no-generic/no-specific).
- Popup (sakelar per situs, jeda global, hitungan, blokir elemen), opsi (daftar filter, situs diizinkan, filter saya,
  umum, tentang), picker "Blokir elemen" di shadow DOM, ikon abu-abu saat diizinkan/dijeda.
- Hasil konversi awal: EasyList 53.577 filter jaringan → 3.767 aturan DNR (domain digabung).

Pelajaran: E2E harus mencari service worker extension **berdasarkan nama manifest** (Chromium punya component
extension sendiri); nilai punycode jangan ditebak di tes.

## 4. Iklan video YouTube (`ad-blocker/youtube-main.js`, `youtube.css`)

Masalah dari pengguna: "masih ada video iklan di YouTube". Penyebab: jadwal iklan ada di data pemutar
(`adPlacements`, `playerAds`, `adSlots`), dikirim dari domain yang sama dengan video → aturan jaringan tidak berguna.
ABP/uBO memakai snippet (`json-prune`, `set-constant`).

Solusi: content script **MAIN world** di `document_start`, didaftarkan dinamis (`scripting.registerContentScripts`) hanya
saat aktif (ikut jeda/allowlist/sakelar): setter `ytInitialPlayerResponse`, hook `JSON.parse` dan
`Response.prototype.json` yang membuang data iklan (+ `auxiliaryUi.messageRenderers.enforcementMessageViewModel`);
cadangan: bisukan & lompati iklan yang tetap diputar, klik "Lewati"; tutup dialog "ad blocker tidak diizinkan".
Bukti di YouTube asli (`tests/youtube.live.mjs`, Despacito, 25 detik): tanpa modul → data iklan ada & iklan diputar;
dengan modul → data iklan kosong, video langsung jalan.

Pelajaran: Chromium baru memaksa HTTPS untuk `youtube.com` (HSTS) → halaman tiruan E2E disajikan lewat HTTPS dengan
sertifikat self-signed (openssl) + `--ignore-certificate-errors` (gagal di CI Linux sebelum diperbaiki).

## 5. Filter bot + GitHub (`filter-bot/`, `.github/workflows/filter-bot.yml`)

Permintaan pengguna: "buat bot yang mengambil update filter list dari beberapa extension dan menjadikannya satu".
Keputusan: ambil dari **sumber asli** list (bukan server privat extension) — hasil sama, legal, stabil.

`filter-bot/sources.json` → 5 kategori (= 5 ruleset statis):
- **Iklan** (aktif): EasyList, ABP Anti-CV, Adblock Warning Removal, uBO filters + quick-fixes + unbreak,
  AdGuard Base tanpa EasyList (`filters.adtidy.org/extension/ublock/filters/2_without_easylist.txt`).
- **Indonesia** (aktif bila bahasa `id`): ABPindo, AdBlockID (`realodix/AdBlockID`; AdGuard tidak punya list Indonesia sendiri).
- **Keamanan** (aktif): uBO badware, uBO resource-abuse, NoCoin.
- **Privasi**: EasyPrivacy, uBO privacy. AdGuard Tracking Protection **dinonaktifkan** (352 ribu baris → ±240 ribu aturan).
- **Gangguan**: Fanboy Annoyance, uBO annoyances + cookies, AdGuard Annoyances.

Bot: unduh (3 kali coba) + `!#include` same-origin, simpan `feed/raw/` sebagai cadangan bila sumber mati, `$badfilter`
global, gabung & dedupe per kategori, tulis `index.json` (versi `YYYYMMDDHHmm`, SHA-256 & ukuran file, status tiap
sumber), `rules/`, `cosmetic/`, `changes.json`; exit 1 bila ada sumber hilang tanpa cadangan.
Hasil awal: total 39.591 aturan, bawaan 18.061; CI ±3 menit.

GitHub: repo publik `mahalbangetid-beep/ad-blocker-filters`, Pages dari branch `gh-pages`,
feed `https://mahalbangetid-beep.github.io/ad-blocker-filters/index.json`.
Pelajaran: token `gh` awalnya tanpa scope `workflow` → push file workflow ditolak; pengguna menjalankan
`gh auth refresh -h github.com -s workflow`. Run CI pertama gagal (HSTS YouTube, lihat §4) dan karena itu tidak menerbitkan apa-apa — pengaman bekerja.

## 6. Update harian di extension (`ad-blocker/updater.js`)

`chrome.alarms` 24 jam + tombol "Perbarui sekarang": ambil `index.json` → untuk kategori aktif unduh rules + cosmetic,
cek SHA-256, validasi, bandingkan dengan ruleset bawaan berdasarkan isi aturan (tanpa id):
baru → aturan dinamis; hilang → `updateStaticRules({disableRuleIds})`; kosmetik → disimpan di `storage.local`
(`ab:feed:cosmetic:<id>`) dan dipakai menggantikan bawaan. Feed ≤ versi bundel → semua update dihapus ("current").
Perubahan melebihi batas Chrome → aturan jaringan bawaan dipertahankan (`networkSkipped`), kosmetik tetap diperbarui.
Setelah update extension (`onInstalled` reason `update`) semua update dihapus lalu dihitung ulang.

Pelajaran: pengelompokan domain berurutan (1000/aturan) membuat satu perubahan menggeser semua kelompok → diganti
bucket hash FNV-1a (maks 700) → 1 tambah + 1 hapus di EasyList = 1 aturan berubah. `runUpdate` semula berbagi promise
yang sedang berjalan (update manual setelah ganti URL feed bisa memakai pengaturan lama) → antrean berurutan.
Uji langsung ke feed asli: bundel `202610160902`, feed `202610160904` → status `updated`, 0 perubahan (sumber belum berubah).

## Kebiasaan lingkungan Windows yang tidak berlaku di Linux

- Pengguna menjalankan Claude Code desktop (Windows) dengan Git Bash + PowerShell; Python 3.11, Node 24, gh 2.95.
- Chromium Playwright ada di `%LOCALAPPDATA%\ms-playwright\chromium-1223`; di Linux pasang dengan `npx playwright@1 install chromium`.
- Memori claude-mem sesi ini tersimpan lokal di Windows dan **tidak ikut** ke Linux; isinya sudah dirangkum di sini.
