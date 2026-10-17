# Riwayat proyek

Dibangun dalam satu sesi Claude Code di Windows (16 Oktober 2026), lalu dilanjutkan di Linux.
Dokumen ini menyimpan hal yang **tidak** bisa dibaca ulang dari kode: apa yang ditemukan di extension aslinya,
mengapa keputusan diambil, dan kesalahan yang sudah pernah terjadi. Extension asli dianalisis dari folder instalasi
Chrome di Windows (`%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\<id>\<versi>`); di Linux lokasinya
`~/.config/google-chrome/Default/Extensions/<id>/<versi>`. ABP dan Toby sudah dicopot pengguna setelah dianalisis.

Urutan kerja: Browser Lock → Tab Manager → Ad Blocker → iklan video YouTube → filter bot + GitHub → update harian → penyatuan → redesign "Universe" (§8).

Catatan path: §1-§6 ditulis saat ketiga extension masih folder terpisah (`browser-lock/`, `tab-manager/`, `ad-blocker/`).
Setelah §7 isinya ada di `my-chrome-universe/modules/lock|tabs|adblock/`; nama file di dalamnya tidak berubah.

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

## 7. Penyatuan My Chrome Universe (`my-chrome-universe/`)

Desain lengkap: `docs/superpowers/specs/2026-10-16-my-chrome-universe-design.md`. Dikerjakan di branch `my-chrome-universe`
(belum di-merge/push saat dokumen ini ditulis), satu commit per tugas.

**Keputusan**
- **Satu extension**, tiga modul di `modules/{lock,tabs,adblock}/`, satu service worker (`background.js` meng-import core
  lalu tiap modul). Modul tidak saling mengimpor; yang dipakai bersama ada di `core/`.
- **Registry `MODULES`** (`core/modules.js`) menjadi sumber tunggal untuk popup, halaman pengaturan, sakelar, dan menu klik kanan.
  Menambah fitur = folder modul + satu entri (lihat README "Menambah modul baru").
- **Popup berupa grid modul** → ketuk satu ubin → panel modul (isi/kontrol popup lama, kini `panel.js` per modul dengan `render`/`status`).
- **Sakelar Aktif per modul** (`core:modules` di storage; default semua aktif). Ad Blocker nonaktif terpisah dari "jeda";
  Tab Manager nonaktif mengembalikan New Tab bawaan Chrome. Browser Lock hanya bisa dimatikan lewat `lock:setEnabled`
  dan **wajib password saat ini** (kolom inline, bukan `prompt()`); tombol "Hapus password" diganti sakelar ini.
- **Browser Lock = gerbang wajib** dengan status baru `setup`: sebelum password dibuat, dashboard/popup/pengaturan/menu/omnibox/shortcut
  hanya mengarah ke halaman "Buat password". Status dibaca dari storage setiap kali (`lockStatus`), tanpa cache. Pengaman dua lapis:
  `messageAllowed` di service worker (pesan modul ditolak `{ok:false,error:'locked'}`) dan `guardPage` di setiap halaman extension.
- **Kode pemulihan** sekali pakai (hash PBKDF2 di `lock:recovery`, jeda bertingkat sama dengan password) — satu-satunya fitur tambahan,
  karena lupa password tanpa itu berarti mencopot seluruh extension dan kehilangan koleksi/filter.
- **Pengelola menu klik kanan** di `core/menus.js`: modul mendaftar lewat `registerMenuProvider`; satu pembangunan ulang berurutan.
- **Ikon toolbar tidak lagi diganti** per tab (dulu Ad Blocker mengabukan ikon saat situs diizinkan/dijeda); status Ad Blocker
  tampil di ubin dan panel. Badge hitungan tetap.
- **Halaman pengaturan bersama** `options.html#<id>`: menu samping dari `MODULES`, sakelar, dan halaman opsi modul dalam `<iframe>`
  (halaman itu memanggil `guardPage('frame')`; jenis ini hilang setelah redesign §8 karena iframe dihapus); Tab Manager tanpa halaman opsi → sakelar + tombol "Buka dashboard".
- Awalan: `lock:` (Browser Lock, dulu tanpa awalan), `tm:`, `ab:`, `core:`. Maksimal 4 shortcut ber-`suggested_key`; terpakai 3.

**Bentrokan yang ditemukan**
- `chrome.contextMenus.removeAll()` dipanggil Ad Blocker dan Tab Manager → menu saling menghapus → pengelola menu bersama; hanya `core/menus.js` yang boleh memanggilnya.
- **Pengecualian origin extension di Browser Lock**: `INTERNAL_URL`/`isWorthRestoring` memperlakukan `chrome-extension:` sebagai miliknya
  sendiri. Aman saat extension hanya berisi layar kunci, tidak aman setelah satu origin berisi dashboard, popup, dan pengaturan →
  saat terkunci hanya layar kunci (dan setup) yang boleh terbuka; halaman extension lain ditutup dan tidak dipulihkan setelah buka kunci.
- **Halaman opsi Ad Blocker terbuka saat install** (`openOptionsPage` di `onInstalled`) → akan tampil sebelum password ada; dihapus,
  yang terbuka saat install hanya halaman setup password.
- Dashboard/popup Tab Manager membaca `chrome.storage.local` langsung (bukan lewat pesan) → penolakan di service worker saja tidak cukup,
  maka `guardPage` memeriksa status sebelum merender dan mengosongkan halaman bila status berubah (`storage.onChanged`).

**Spike New Tab (Tab Manager nonaktif)** — cara mengembalikan New Tab bawaan Chrome dari halaman `chrome_url_overrides`:
- `chrome.tabs.update(ownTab, { url: 'chrome://new-tab-page/' })` **berhasil**.
- `location.replace('chrome://…')` dari halaman extension **diblokir**.
- `chrome.tabs.update` ke `chrome://newtab/` **berulang** (loop ±100–170 kali reload) karena URL itu kembali ke override.
- Cadangan tetap ada: halaman pemberitahuan dengan tautan "Aktifkan Tab Manager" bila pembaruan tab gagal.

**Pelajaran**
- Penyapuan Browser Lock menutup halaman extension yang sedang dipakai E2E (`bg()`), sehingga balasan `lock:lock` tidak pernah tiba →
  di E2E kirim `lock:lock` fire-and-forget dan lupakan halaman `bg()` (buka yang baru pada panggilan berikutnya).
- Tes picker "Blokir elemen" tidak stabil tanpa menunggu kondisi (`waitFor`) → semua langkah kini menunggu kondisi, bukan `sleep`.
- Tes gerbang kunci mengunci browser sungguhan, jadi harus tetap **terakhir** di `tests/universe.e2e.mjs`; tes baru ditaruh sebelum bagian itu.
- Pesan yang boleh dilayani saat terkunci didaftar eksplisit (`PUBLIC_MESSAGES`); default menolak (fail closed).

## 8. Redesign global "Universe" (`my-chrome-universe/ui/` dan semua halaman)

Desain: `docs/superpowers/specs/2026-10-16-global-redesign-design.md`; acuan visual = prototipe interaktif yang disetujui
pengguna ("aku suka sekali"), salinannya `docs/superpowers/specs/assets/2026-10-16-universe-prototype.html`; rencana
sembilan tugas `docs/superpowers/plans/2026-10-16-global-redesign.md`. Dikerjakan di branch `universe-redesign`
(belum di-merge/push saat dokumen ini ditulis), satu commit per tugas.

**Keputusan**
- **Satu sistem desain di `ui/`** (bukan di `core/`, yang berisi logika SW): token dua tema, komponen, ikon SVG + logo
  orbit, gerak, kanvas bintang, sambutan. Komponen hanya memakai token; nilai token disalin dari prototipe, kecuali
  `--faint` gelap `#787FA3` (nilai prototipe `#747CA0` gagal kontras 4,5:1). Tema terang "Fajar" atas permintaan pengguna.
- **Font lokal**: Unbounded, Plus Jakarta Sans, JetBrains Mono sebagai tiga woff2 *variable* (subset latin) + `OFL.txt`,
  bukan tujuh file statis. Halaman extension tidak boleh meminta apa pun dari host lain (dijaga E2E lewat CDP `Network`).
- **Cermin localStorage**: `core:appearance` ada di `chrome.storage` (asinkron), tetapi tema harus terpasang sebelum render
  pertama. `applyAppearance` menulis `localStorage['mcu:appearance']`, dan `ui/boot.js` (skrip klasik di `<head>`)
  membacanya secara sinkron → tidak ada kilatan tema yang salah.
- **Penyimpanan tampilan jarang**: `core:setAppearance` hanya menyimpan kunci yang diubah pengguna (patch tidak valid
  diabaikan). Menyimpan objek yang sudah dinormalkan mengunci `motion: 'full'` selamanya walau OS kemudian meminta
  *reduce motion*. Pembaca menormalkan sendiri (`readAppearance`).
- **Handoff tab** (alur buka kunci tanpa ganti tab): setelah `lock:unlock`, layar kunci memutar warp lalu mengirim
  `lock:handoff`; SW memindahkan tab kunci ke akhir dan `chrome.tabs.update(id, { url: 'chrome://newtab/' })` sehingga tab
  itu sendiri menjadi dashboard (bilah alamat kosong seperti New Tab biasa; dari halaman kunci ini tidak memicu loop,
  beda dengan spike §7 yang memanggilnya dari halaman override itu sendiri). Tab tersimpan pulih di latar belakang lebih
  dulu (`finishUnlock` menunggu `restoring`). **Cadangan**: penanda `lock:handoffPending` + timer 4 dtk di SW; bila layar
  kunci tidak sempat mengirim, SW tetap menghasilkan dashboard aktif di akhir jendela.
- **Arrival khusus tab**: `tm:arrive` berisi id tab kunci, bukan boolean; hanya tab itu yang memutar animasi tiba
  (sebelumnya New Tab lain yang dibuka bersamaan bisa "mencuri" animasinya).
- **Sambutan** hanya saat browser baru dibuka (penanda session `core:welcome` dari `onStartup`), bagian dari `lock.html`
  (tanpa halaman extension tambahan saat terkunci); bila Browser Lock mati, diputar di dashboard pertama.
- **Panduan sekali**: panduan bernomor dashboard tampil otomatis sampai benar-benar terlihat lalu ditutup (`tm:guideSeen`),
  bukan sekadar "pernah dirender".
- **Pengaturan tanpa iframe**: `options.html` satu halaman gulir; registry memakai `settings` (`render(root, ctx)`)
  sejajar dengan `panel`. Halaman opsi lama tinggal pengalih agar bookmark/tes lama tidak 404.
- **Picker di situs orang lain** tetap di shadow DOM tertutup dengan palet sendiri dan font sistem (tidak memuat aset
  extension ke halaman); geometri panel tidak diubah karena E2E mengklik berdasarkan koordinat.
- **Ikon** dibuat sekali dari `logo()` dengan `tools/make-icons.mjs` (Chromium + CDP `Page.captureScreenshot`, latar
  transparan, tanpa dependensi); ukuran 16/32 memakai matahari lebih besar dan cincin lebih tebal agar tetap terbaca.

**Pelajaran**
- **Data sebelum gerbang**: animasi masuk tidak boleh merender data sebelum `guardPage` resolve; kartu `.guard-notice`
  menggantikan halaman tanpa membaca data modul. Karena halaman extension ditutup penyapuan saat terkunci, E2E memuat
  popup di dalam iframe layar kunci untuk memeriksa pemberitahuan itu.
- **Satu-satunya UI pembuka harus tahan gagal**: bila kanvas/sambutan melempar error, form login tetap harus aktif
  (`try/finally` di `lock.js`/`setup.js`; `playWelcome` menelan error kanvas). Diuji dengan `getContext` yang dirusak.
- **Penyimpanan cepat di pengaturan**: membandingkan slider dengan *balasan* terakhir (bukan nilai terakhir yang
  dikirim), membangun daftar filter dari data (bukan dari sakelar di halaman), dan dua baris yang mengirim objek
  `lock:settings` utuh dari salinan lokal masing-masing → perubahan hilang. Kini: nilai terakhir yang dikirim, status
  dari DOM, satu antrean berisi nilai terbaru yang diinginkan. E2E memperlambat balasan 400 ms untuk membuktikannya.
- **Teks jujur**: catatan "Tab disimpan…" setelah kunci manual kini memakai jumlah dari `lock:getState().savedTabs`
  (hanya angka, menunggu penyimpanan yang sedang berjalan) dan tidak muncul bila tidak ada tab yang disimpan.
- **E2E yang flaky** (`unlock restores tabs…`, 1 dari 4 run di Task 7): tes menunggu "ada tab aktif ber-URL", yang bisa
  masih URL layar kunci karena URL target CDP berubah sebelum `chrome.tabs` melaporkan URL dashboard yang sudah
  di-commit; `waitFor` juga langsung gagal bila evaluasi jatuh di tengah navigasi. Perbaikan: tunggu kondisi akhir (tab
  aktif = dashboard) dan anggap evaluasi gagal saat navigasi sebagai "belum" — bukan menaikkan timeout.
- **Minim = tanpa loop**: tes menghitung `requestAnimationFrame` lewat skrip yang dipasang sebelum halaman dimuat
  (`Page.addScriptToEvaluateOnNewDocument`), dengan kontrol: gerak Penuh harus menghasilkan banyak frame.

## 9. Catatan Tempel — tiruan Note Anywhere (`my-chrome-universe/modules/notes/`, 2026-10-17)

**Temuan reverse engineering** (Note Anywhere v1.2.0, `bohahkiiknkelflnjjlipnaeapefmjbh`, oleh "William"/myatoms.io; REA
`analyze_javascript_application` + bundel webpack yang dirapikan dengan js-beautify):
- Bundel berisi `webextension-polyfill`, polyfill custom elements, `idb`, `nanoid`, `jscolor`. Content script di semua
  http/https membuat `<note-anywhere-sticky>` (shadow DOM *open*) per catatan: `position:absolute` (Pin → `fixed`),
  seret lewat bilah, ubah ukuran di pojok 15 px (min 150×180), `contenteditable` disimpan sebagai **HTML** 600 ms setelah
  mengetik, menu 7 warna + Pin + Delete, mode Iconize dan Hide/Show per halaman.
- Data di IndexedDB `note-anywhere` v2, store `notes` (indeks `url` tanpa hash, `timestamp`, `syncId`, `deleted`), hapus
  lunak. Badge = jumlah catatan di tab. Pengaturan (warna, font, ukuran, tanggal di bilah) di `storage.sync`.
- Sync ke `beta.myatoms.io`: token dititipkan lewat `externally_connectable` dari situs myatoms, dikirim di query string,
  tiap 60 menit/saat jendela ditutup/startup (teks Options bilang 5 menit); balasan server menimpa catatan lokal.
- Kelemahan: XSS (HTML catatan dipasang dengan `innerHTML` di situs, popup, dan Summary — data sync ikut), scan z-index
  seluruh elemen di setiap halaman, catatan terikat URL persis.

**Keputusan** (pengguna memilih "langsung mulai"; tidak ada sesi tanya-jawab):
- Langsung jadi modul My Chrome Universe (bukan extension terpisah), awalan `nt:`, kartu berwarna token baru `--nebula`.
- Teks biasa (`<textarea>`), tanpa sync/akun, tanpa badge (milik Ad Blocker). Penyimpanan `chrome.storage.local`:
  `nt:p:<url>` per halaman + `nt:index` ringkasan (status popup/daftar pengaturan tanpa membaca semua catatan).
- Content script didaftarkan `chrome.scripting.registerContentScripts` hanya saat modul aktif; satu host `<mcu-notes>`
  (shadow DOM *closed*, z-index maksimum — tanpa scan) yang baru dipasang bila ada catatan. Dibangun dengan DOM API +
  constructed stylesheet (tanpa string markup). Tombol keyboard di catatan tidak diteruskan ke situs.
- Tambahan dibanding aslinya: klik kanan pada teks terpilih → catatan berisi teks itu; urungkan hapus; salin teks;
  navigasi SPA memuat catatan URL baru; tab lain di URL yang sama ikut diperbarui; ekspor JSON + impor (gabung/ganti).

**Pelajaran**
- **`sender.url` tidak mengikuti `history.pushState`**: setelah navigasi SPA, pesan content script masih membawa URL
  dokumen awal, sementara `sender.tab.url` sudah URL baru. Handler catatan memakai `sender.tab.url` (frame utama saja).
  Ditemukan lewat E2E navigasi SPA + log `webNavigation.onHistoryStateUpdated`.
- **Trusted Types tidak berlaku di isolated world**: di halaman ber-`require-trusted-types-for 'script'`, `innerHTML` di
  main world ditolak tetapi di content script tetap jalan (dibuktikan E2E; tes halaman ketat juga memastikan halaman itu
  memang ketat). Membangun DOM tanpa markup tetap dipilih agar teks catatan mustahil menjadi HTML.
- **Konteks content script di E2E**: shadow DOM tertutup hanya bisa dijangkau dari isolated world extension;
  E2E mencari konteks `auxData.type === 'isolated'` bernama "My Chrome Universe" (Runtime.disable/enable memancarkan
  ulang semua konteks) dan `content.js` memaparkan `window.__mcuNotes.shadow` hanya di world itu.
- **Popup di tab latar belakang tidak beranimasi** (tangkapan kosong): buka popup di latar (agar tab situs tetap aktif
  untuk panel), lalu `Target.activateTarget` sebelum memotret.

**Papan semua catatan** (permintaan pengguna setelah mencoba: "belum ada tempat lihat semua catatan"). Rekomendasi yang
disetujui: dashboard Tab Manager, karena itu "rumah" yang muncul setelah login dan di setiap tab baru.
- `modules/notes/board.js` + `board.css` dimuat `newtab.html`; mode tampilan `view` (`space`/`notes`) di `newtab.js`,
  URL `?view=catatan`. Kartu halaman memakai `.col` dashboard; catatan mini memakai palet catatan dari `store.js`
  (`COLORS` kini memuat bg/bg2/ink/sub; tes memastikan sama dengan CSS `content.js`).
- Pesan baru (hanya halaman extension): `nt:all`, `nt:open` (pakai tab halaman yang sudah terbuka, kalau tidak buka tab,
  tunggu `complete`, lalu `nt:focus` — content script menunggu muat awalnya dulu), `nt:deleteNote` + `nt:restoreNote`
  (urungkan dari toast).
- Ctrl K: grup "Catatan" (`searchNotes` di `store.js`). Pengaturan: tombol "Buka papan" dan halaman yang bisa
  dibentangkan untuk melihat isi catatan (cadangan saat Tab Manager mati).
- Pelajaran: animasi masuk catatan mini hanya saat papan dibuka (`.nb-enter` sementara), bukan setiap gambar ulang;
  tombol popup yang memanggil `window.close()` menutup tab popup di E2E, jadi langkah itu harus terakhir.

## 10. CI tidak stabil (2026-10-17)

- **Bot crash di `fetch` Node 24 (job `build`)**: `AssertionError: assert(!this.paused)` dari dalam undici
  (`Parser.finish`, event socket) — dilempar di luar promise sehingga retry dan cadangan "salinan terakhir" tidak jalan dan
  feed tidak terbit. Tidak terulang dalam 5 run lokal dengan Node 24.21.0 yang sama; tidak ada laporan yang persis sama.
  Perbaikan: `filter-bot/bot.mjs` mengunduh dengan `node:http(s)` (redirect, gzip/deflate/br, batas 60 dtk); isi unduhan
  dibandingkan dengan hasil `fetch` (15/18 identik, sisanya hanya versi upstream EasyList yang berganti). Run berikutnya:
  `build` lolos dan feed terbit.
- **E2E memakai feed produksi tanpa sengaja (job `ui-e2e`)**: extension yang baru terpasang langsung mengunduh feed
  GitHub Pages (lebih baru dari ruleset di repo; job `build` tidak kena karena membangun ulang ruleset). Kontrol lokal:
  119 aturan dinamis ditambah dan 117 aturan bawaan dimatikan di tengah tes. Kini host feed dipetakan ke 127.0.0.1 di
  Chromium tes (`LIVE_FEED_HOST`) dan tes pertama Ad Blocker memastikan tidak ada update yang diterapkan.
- **Masih terbuka**: kegagalan sesekali "turning Ad Blocker off…" (jaringan sudah diblokir tapi `#ad_banner` belum
  tersembunyi — CSS dari service worker datang terlambat atau tidak?) dan "startup shows the welcome…" (lolos sendirian,
  sesekali gagal di urutan penuh). Keduanya kini mencetak `DIAGNOSE …` saat gagal; perbaiki setelah datanya ada.

## Kebiasaan lingkungan Windows yang tidak berlaku di Linux

- Pengguna menjalankan Claude Code desktop (Windows) dengan Git Bash + PowerShell; Python 3.11, Node 24, gh 2.95.
- Chromium Playwright ada di `%LOCALAPPDATA%\ms-playwright\chromium-1223`; di Linux pasang dengan `npx playwright@1 install chromium`.
- Memori claude-mem sesi ini tersimpan lokal di Windows dan **tidak ikut** ke Linux; isinya sudah dirangkum di sini.
