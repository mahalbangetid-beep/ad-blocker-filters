# My Chrome Universe — redesign global "Universe"

> Tanggal: 2026-10-16 · Status: draf untuk disetujui pengguna
> Acuan visual yang **disetujui pengguna** ("aku suka sekali"): prototipe interaktif
> https://claude.ai/artifact/93JHVKqV3Vy7RK1K7MYZF1 (salinan sumber: `docs/superpowers/specs/assets/2026-10-16-universe-prototype.html`).
> Dokumen ini menjelaskan cara memindahkan prototipe itu ke extension sungguhan tanpa merusak perilaku yang ada.

## 1. Maksud dan alasan

Penyatuan (spesifikasi `2026-10-16-my-chrome-universe-design.md`) sudah selesai, tetapi tampilannya masih tiga gaya
visual berbeda yang dibungkus iframe. Pengguna ingin **mengganti seluruh tampilan, tidak meneruskan desain lama**, dengan
satu bahasa visual "luar angkasa" yang **penuh animasi di setiap elemen** (klik, hover, transisi, tampil). Kata-kata
pengguna, urutan alurnya:

1. Saat browser dibuka: animasi layar penuh "Welcome to My Chrome Universe", lalu transisi halus ke halaman login yang
   juga penuh animasi (hanya form di tengah).
2. Setelah login, Tab Manager muncul dengan transisi halus.
3. Tab Manager adalah desain terbesar; pengguna meminta rekomendasi kerangka "yang mudah dipahami semua orang".
4. Popup ikon extension didesain ulang, penuh animasi di setiap klik/hover/tampilan.
5. Pengaturan disatukan: "lebih mudah untuk mengatur segala sesuatu di 1 pengaturan", penuh animasi.

## 2. Tujuan, bukan tujuan, anti-tujuan

**Tujuan**
- Semua permukaan extension memakai satu sistem desain (token warna, tipografi, ikon, gerak) sesuai prototipe:
  layar sambutan, layar kunci, halaman setup password, dashboard Tab Manager (New Tab), popup + panel modul,
  halaman pengaturan tunggal, pemberitahuan gerbang kunci (`page-guard`), dan panel picker "Blokir elemen" di situs web.
- Semua fitur yang ada sekarang tetap ada dan tetap bekerja (lihat §6 kriteria berhasil). Redesign tidak menghapus fitur.
- Pengaturan semua modul dalam **satu halaman tanpa iframe**, dengan pencarian.
- Pengguna bisa mengurangi animasi (pengaturan "Tingkat animasi"), dan setelan *reduce motion* sistem operasi dihormati.
- Dua tema: **Gelap "Malam"** (prototipe asli) dan **Terang "Fajar"** (keputusan pengguna: "boleh diadakan tema terangnya",
  dirancang dengan skill UI/UX Pro Max dan harus menyesuaikan desain baru), plus Otomatis mengikuti sistem.

**Bukan tujuan**
- Mengubah logika modul (filter, DNR, updater, kriptografi kunci, model data Tab Manager) kecuali yang disebut di §4.
- Fitur baru di luar yang ada di prototipe.
- Migrasi data tampilan lama (pengaturan tema lama boleh diabaikan/dipetakan, lihat §4.2).

**Anti-tujuan (gagal walau "jalan")**
- Extension mengirim request ke server pihak ketiga untuk tampilan (mis. Google Fonts, CDN). Semua aset lokal.
- Animasi membuat browser terasa berat: New Tab lambat terbuka, CPU terus terpakai saat tab tidak dilihat, atau input
  terblokir menunggu animasi.
- Redesign membuka celah gerbang kunci: data modul terlihat atau bisa diubah sebelum `guardPage` mengizinkan, atau
  transisi login→dashboard menampilkan data saat status belum `open`.
- Animasi yang menyembunyikan informasi penting (pesan error, kode pemulihan) di balik delay atau gerak.
- Emoji sebagai ikon (ganti ikon registry `🛡🗂🔒` dengan ikon SVG).

## 3. Batasan

- Semua batasan `CLAUDE.md` berlaku: MV3, ES module murni, **tanpa build step dan tanpa dependensi npm**; SW tanpa
  top-level await; awalan namespace; gerbang kunci; `senderAllowed`/`messageAllowed`; menu hanya lewat `core/menus.js`.
- UI bahasa Indonesia; komentar kode ringkas bahasa Inggris.
- Popup Chrome maksimal 800×600 px.
- Content script picker berjalan di situs orang lain: gayanya harus tetap terisolasi di shadow DOM-nya.
- Lisensi font harus jelas (OFL) dan disertakan.

## 4. Desain

### 4.1 Sistem desain bersama (`my-chrome-universe/ui/`)

Satu folder yang dipakai semua halaman extension (*keputusan Claude*: `ui/` di akar extension, bukan di `core/`, karena
`core/` berisi logika SW):

- `tokens.css`: token dari prototipe untuk **kedua tema** (`:root` = gelap, `:root[data-ui="light"]` = terang, persis
  seperti prototipe) — warna (`--void #06080F`, `--panel`, `--line`, `--star #EEF1FF`, `--dust #A3ABCB`,
  `--faint`, `--solar #FFB547`, `--ion #5EEAD4`, `--nova #FF8FA8`, `--danger`, `--accent`, `--accent-ink`), font
  (`--f-display` Unbounded, `--f-body` Plus Jakarta Sans, `--f-mono` JetBrains Mono), easing (`--ease-out`, `--ease-in`,
  `--spring`), durasi, radius; token turunan yang membuat komponen tidak pernah memakai warna literal (`--tint`,
  `--shade`, `--glass`, `--line-rgb`, `--scrim`, varian teks `--solar-text/--ion-text/--nova-text/--ok-text/--danger-text/
  --accent-text` untuk kontras ≥ 4,5:1 di tema terang, warna favicon, bingkai browser, gradien judul, mode campur
  nebula); plus aturan tingkat gerak `[data-motion="minimal"|"balanced"]`.
- **Tema terang "Fajar"**: alam semesta yang sama saat fajar — langit pucat kebiruan `#EEF1F8`, aurora pastel (nebula
  dengan `mix-blend-mode: multiply`), bintang berupa bintik tinta gelap tipis, kaca putih buram, warna isi merek tetap
  (Surya/Ion/Nova), teks memakai varian yang lebih gelap. Font, tata letak, dan semua animasi sama dengan tema gelap.
- `fonts/`: file woff2 ketiga font (subset latin, bobot seperti prototipe) + `OFL.txt`; `@font-face` lokal dengan
  `font-display: swap` dan fallback system-ui.
- `components.css`: tombol (`.btn`, primary/ghost/sm/block, kilap hover), `.icon-btn`, sakelar `.sw` (pegas), checkbox,
  input + fokus bercahaya, `.pill`, `kbd`, toast, menu, dialog, ripple, spotlight `.glow`, `.fav`, keyframe bersama
  (`rise`, `depth`, `pop`, `from-left/right/top`).
- `icons.js`: set ikon SVG gaya Lucide dari prototipe (`ic(name)`), plus logo orbit. Registry modul memakai nama ikon.
- `motion.js`: membaca pengaturan tampilan (§4.2) dan menerapkan `data-motion` + aksen ke `<html>`; ripple, spotlight,
  tilt, `countUp`, toast, `wait()` yang menyesuaikan tingkat gerak.
- `sky.js`: kanvas bintang + nebula (mode `welcome/orbit/drift/calm`, warp maju/mundur, partikel teks, percikan). Wajib:
  punya palet per tema (`setTheme(light)`), berhenti total saat `document.hidden`, DPR dibatasi 2, jumlah bintang menyesuaikan luas layar dan tingkat gerak; pada
  tingkat "Minim" hanya digambar statis sekali.

Setiap halaman memuat `tokens.css` + `components.css` + skrip yang perlu. Prototipe adalah sumber kebenaran untuk nilai
token, keyframe, dan perilaku gerak; detail yang tidak ada di prototipe diserahkan ke pembangun selama konsisten.

### 4.2 Pengaturan tampilan baru (core)

Kunci storage baru `core:appearance` = `{ theme: 'auto'|'light'|'dark', motion: 'full'|'balanced'|'minimal', accent: 'solar'|'ion'|'nova', welcome: boolean }`.
Default: `theme` `'auto'`; `motion` = `'minimal'` bila `prefers-reduced-motion`, selain itu `'full'`; `accent` `'solar'`; `welcome` `true`.
Dibaca/ditulis lewat pesan `core:getAppearance` / `core:setAppearance` (validasi nilai di SW; `core:getAppearance`
masuk `PUBLIC_MESSAGES` karena layar kunci/setup juga perlu tampil sesuai pengaturan — isinya tidak sensitif).
Halaman menerapkannya sebelum render pertama dan mengikuti perubahan lewat `storage.onChanged`.

Tema berlaku untuk **semua** permukaan (layar kunci, setup, dashboard, popup, pengaturan, pemberitahuan gerbang). Pengaturan
tema lama Tab Manager (`tm:data.settings.theme`) dipindahkan sekali ke `core:appearance.theme` bila `core:appearance` belum
ada, lalu diabaikan; model data `store.js` tidak diubah (*keputusan Claude*). Tombol tema di bilah atas dashboard
berganti terang/gelap dan menulis `core:appearance`. Panel picker di situs web memakai tema gelap/terang mengikuti
`prefers-color-scheme` halaman (tidak membaca storage extension).

### 4.3 Alur buka browser: sambutan → login → dashboard

- **Sambutan** adalah bagian dari halaman layar kunci (`modules/lock/lock.html`), bukan halaman terpisah, sehingga tidak
  ada halaman extension tambahan saat terkunci. Ditampilkan hanya saat **browser baru dibuka** (dan `welcome` aktif):
  `onStartup`/`init` yang menyapu saat startup membuka layar kunci dengan penanda (mis. `lock.html#welcome`); kunci
  manual, idle, layar terkunci, dan shortcut membuka layar kunci tanpa sambutan.
  Isi dan waktu seperti prototipe: kilatan + cincin, "Welcome to" per huruf, partikel membentuk "My Chrome Universe",
  tagline, bilah progres, tombol "Lewati" dan klik di mana saja untuk lanjut, ±4,8 detik; pada "Minim" teks langsung
  tampil dan lanjut otomatis lebih cepat.
- **Login**: kartu kaca dengan bingkai cahaya berputar, orbit planet, bintang jatuh, umpan balik saat mengetik, tombol
  dengan status memeriksa/berhasil, getar saat salah, dan **semua perilaku lama `lock.js` tetap**: jeda bertingkat
  dengan hitung mundur, sisa percobaan, form kode pemulihan (dibalik seperti kartu), tampilan kode pemulihan baru,
  lalu membuka dengan password baru. Pesan error dan kode pemulihan tidak boleh tertunda animasi.
- **Login → dashboard tanpa ganti tab yang terlihat** (*keputusan Claude*, agar transisinya benar-benar mulus): setelah
  `lock:unlock` sukses, layar kunci memainkan warp (≈1 detik) lalu **mengarahkan tab itu sendiri** ke dashboard
  (*keputusan Claude*, saran peninjau: `chrome.tabs.update(tabId, { url: 'chrome://newtab/' })` agar bilah alamat tetap
  kosong seperti New Tab biasa, dengan penanda "baru tiba" di `storage.session`; pembangun memastikan ini memuat override
  Tab Manager tanpa loop — bila tidak bisa, pakai `modules/tabs/newtab.html` dan catat alasannya), dan dashboard
  memainkan masuk dari kedalaman. Karena itu `restoreTabs()` berubah:
  tab tersimpan tetap dipulihkan di latar belakang, tetapi bila Tab Manager aktif SW **tidak** membuat tab dashboard baru
  dan **tidak** menutup tab kunci — tab kunci yang menjadi dashboard. Bila Tab Manager nonaktif: layar kunci memainkan
  warp lalu menutup dirinya setelah tab pertama yang dipulihkan diaktifkan (atau membuka New Tab bawaan bila tidak ada
  yang dipulihkan, seperti sekarang). **Cadangan wajib**: bila halaman kunci tidak sempat berpindah (ditutup, crash), SW
  tetap memastikan hasil akhir yang sama dengan sekarang (ada tab dashboard aktif / tab dipulihkan), mis. dengan pemeriksa
  beberapa detik setelah unlock. Invarian lama "hanya satu tab kunci" dan penyapuan saat terkunci tidak berubah.
- **Dashboard → layar kunci**: tombol Kunci di dashboard/popup/pengaturan memainkan animasi runtuh singkat
  (≤ 450 ms) sebelum mengirim `lock:lock`; layar kunci yang terbuka memainkan masuk "warp mundur".
- **Setup pertama kali** (`setup.html`): sambutan yang sama, lalu kartu "Atur password" dan tampilan kode pemulihan
  dengan gaya login. Setelah dicatat, menuju pengaturan bagian Browser Lock (sekarang ke `options.html` modul lock).
- Bila Browser Lock dimatikan pengguna, tidak ada layar kunci; *keputusan Claude*: sambutan dimainkan di dashboard
  pertama yang dibuka setelah browser start (penanda di `storage.session`), lalu langsung masuk dashboard.

### 4.4 Dashboard Tab Manager (New Tab)

Kerangka empat zona dari prototipe (rekomendasi yang disetujui):

1. **Ruang** (rail kiri): jam besar + sapaan, daftar ruang dengan "planet" berwarna dan jumlah tab, indikator aktif yang
   meluncur, tombol ruang baru, daftar Berbintang.
2. **Koleksi** (tengah): judul ruang + meta "n koleksi · n tab", "Lipat semua", "Koleksi baru"; grid kartu koleksi
   (lipat beranimasi, bintang dengan percikan, buka semua, menu opsi); baris tab dengan favicon, judul, URL; zona
   "Tarik tab ke sini untuk membuat koleksi baru".
3. **Tab terbuka** (panel kanan; laci di layar < 1180 px): per jendela, tanda duplikat, "Simpan sesi", "Tutup tab
   setelah disimpan", "Hapus duplikat", tarik ke koleksi, simpan satu tab ke "Disimpan".
4. **Cari & perintah** (bilah atas, Ctrl K dan `/`): satu palet untuk mencari tab/koleksi tersimpan dan menjalankan
   perintah. Menggantikan kotak pencarian lama; hasil pencarian harus mencakup apa yang dicari kotak lama.

Bilah atas juga memuat chip Ad Blocker (jumlah **total** diblokir dari data yang ada — prototipe menulis "hari ini",
tetapi tidak ada penghitung harian; *keputusan Claude*: pakai total, tanpa fitur penghitung baru), tombol Kunci,
Panduan (?), dan Pengaturan. Panduan bernomor 1–4 tampil otomatis sekali (penanda di storage), dan kapan saja lewat (?).

**Semua fitur dashboard lama tetap ada**, dipetakan ke tempat barunya: edit kartu (judul/URL) dan hapus dengan
"Urungkan"; reorder tab lewat tarik; buka koleksi di jendela ini / jendela baru / sebagai grup tab; ganti nama; pindah
ke ruang lain; hapus tab ganda di koleksi; salin semua URL; hapus koleksi; ganti nama/hapus ruang; ekspor/impor JSON;
impor bookmark; tautan pintasan keyboard. Ekspor/impor/bookmark juga ada di halaman pengaturan (§4.6). Dialog
(`<dialog>`) dan menu memakai komponen bersama. Semua penulisan data tetap lewat pesan `tm:*` ke SW seperti sekarang.

### 4.5 Popup ikon extension

Seperti prototipe, lebar 370 px: kepala (logo orbit berputar, judul, status "Browser terbuka · kunci otomatis …",
tombol kembali yang muncul di panel, roda gigi ke pengaturan), lalu:
- **Beranda**: kartu situs aktif (domain + jumlah diblokir di halaman ini, menghitung naik — bila modul Ad Blocker aktif
  dan halaman didukung), daftar kartu modul dari registry (ikon beranimasi, nama, baris status dari `panel.status()`,
  sakelar Aktif; Browser Lock memakai sakelarnya sendiri yang meminta password untuk dimatikan), kaki: "Tab Manager" dan
  "Kunci sekarang".
- **Panel modul** (bergeser masuk, judul kepala berganti): isi dan perilaku panel yang ada sekarang (`modules/*/panel.js`)
  dengan tampilan baru — Ad Blocker: cincin hitungan, sakelar situs, total, aturan aktif, Blokir elemen, Jeda, Atur
  daftar filter; Tab Manager: tab saat ini, pilih koleksi (termasuk "koleksi baru"), simpan tab (tombol berubah jadi
  "Tersimpan di …"), simpan jendela, tutup setelah disimpan, buka Tab Manager; Browser Lock: ikon gembok, fakta
  (kunci otomatis, layar dikunci, pintasan), Kunci sekarang, Atur Browser Lock, matikan dengan password.
- Popup tetap dibangun dari `MODULES`; kontrak panel (`status()`, `render(root)`) dipertahankan atau diperluas, dan
  pembersihan `<head>` saat panel ditutup tetap ada. Sakelar modul dipindah dari dalam panel ke kartu beranda
  (*keputusan Claude*, sesuai prototipe); panel modul yang nonaktif menampilkan pemberitahuan nonaktif seperti sekarang.

### 4.6 Halaman pengaturan tunggal (`options.html`)

Satu halaman gulir, tanpa iframe: navigasi kiri (Umum, Browser Lock, Tab Manager, Ad Blocker, Tentang; indikator
meluncur, mengikuti posisi gulir), bilah atas lengket (judul, pencarian pengaturan, penanda "Tersimpan" berdenyut).
`options.html#<id>` menggulir ke bagian itu (dipakai tombol roda gigi/“Atur …”).

- Registry: field `options` (halaman) diganti `settings` (modul JS yang mengekspor `render(root)` bagian modul itu),
  sejalan dengan `panel`. Halaman `modules/lock/options.html` dan `modules/adblock/options.html` dihapus; tautan lama ke
  path itu dialihkan ke `options.html#<id>` (*keputusan Claude*: pertahankan berkas kecil yang hanya mengalihkan, agar
  bookmark/tes lama tidak 404).
- **Umum**: Tema (Otomatis/Terang/Gelap), Tingkat animasi (Penuh/Seimbang/Minim), Warna aksen (Surya/Ion/Nova), Animasi sambutan, sakelar modul
  Ad Blocker dan Tab Manager.
- **Browser Lock**: semua yang ada di `modules/lock/options.html` sekarang — aktif/nonaktif (mematikan perlu password),
  kunci otomatis (slider 0–240 menit), kunci saat layar dikunci, Kunci sekarang + pintasan, ganti password, kode
  pemulihan baru, dan status "Atur Password" bila belum ada password. Browser Lock tetap bisa dimatikan dengan password
  saat ini (perilaku sekarang; prototipe versi 2 sudah menunjukkannya).
- **Tab Manager**: tutup tab setelah disimpan, ekspor/impor JSON, impor bookmark.
- **Ad Blocker**: semua yang ada di `modules/adblock/options.html` sekarang — daftar filter per kategori dengan jumlah
  aturan dan meteran terhadap batas 30.000, perbarui sekarang + waktu update terakhir, URL feed, situs diizinkan,
  filter saya (dengan hitungan aktif/dilewati), angka di ikon, YouTube, menu klik kanan, kredit sumber filter.
- **Tentang**: versi, versi feed, prinsip (lokal tanpa akun, tanpa telemetri, tanpa Acceptable Ads, sumber berlisensi).
- Perubahan disimpan langsung (tanpa tombol simpan global), kecuali form yang butuh password atau teks panjang.

### 4.7 Lain-lain

- `page-guard` "Browser terkunci." / "Buat password terlebih dahulu." memakai gaya baru (tetap tanpa membaca data modul).
- Panel picker "Blokir elemen" di situs memakai palet dan bentuk baru di dalam shadow DOM-nya; font sistem (bukan
  font extension) agar tidak memuat aset ke halaman orang lain.
- Ikon toolbar dan ikon extension (16/32/48/128) diganti logo orbit; PNG dibuat sekali dan di-commit (cara membuatnya
  diserahkan ke pembangun, tanpa menambah dependensi proyek).
- Navigasi "Prototipe" (dock 1–5) **tidak** ikut ke extension.

## 5. Yang diserahkan ke pembangun

Pembagian berkas di `ui/`, cara panel/bagian pengaturan dimuat, detail responsif di luar yang ada di prototipe,
mekanisme pemeriksa cadangan setelah unlock (§4.3), cara menghasilkan PNG ikon, pembaruan selector tes E2E, dan urutan
pengerjaan — selama §2, §3, dan §6 terpenuhi.

## 6. Kriteria berhasil

- Semua unit test lolos; E2E (`tests/universe.e2e.mjs`) lolos dengan selector diperbarui dan **cakupan perilaku yang
  sama atau lebih** (popup, sakelar modul, pengaturan, gerbang kunci, picker, Ad Blocker, update feed).
- E2E baru: startup terkunci menampilkan sambutan lalu login; unlock membuat tab kunci berubah menjadi dashboard (tab
  aktif = `newtab.html`) dan tab tersimpan pulih; kunci manual tidak menampilkan sambutan; pengaturan "Minim" mematikan
  animasi (mis. tidak ada loop kanvas); halaman extension tidak membuat request ke host selain extension itu sendiri.
- Setiap permukaan diperiksa di **kedua tema**; teks memenuhi kontras 4,5:1 (teks kecil) di keduanya.
- Tidak ada error konsol di semua halaman; tidak ada geser horizontal pada lebar 400 px untuk dashboard dan pengaturan.
- Tangkapan layar tiap permukaan dibandingkan dengan prototipe oleh Claude sebelum diserahkan.
- Dokumentasi (`README.md`, `CLAUDE.md`, `HANDOFF.md`, `docs/PROJECT_HISTORY.md`) diperbarui.

## 7. Keputusan yang sudah diambil

- Tema terang: **ya** (pengguna). Desain "Fajar" ada di prototipe versi 2 (sakelar Tema di Pengaturan → Umum, atau tombol
  matahari/bulan di bilah atas Tab Manager).
- Butir bertanda *keputusan Claude* di atas boleh dikoreksi pengguna saat meninjau dokumen ini.
