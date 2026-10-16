# My Chrome Universe

Satu extension Chrome (Manifest V3, JavaScript murni, tanpa build step) yang menyatukan tiga modul. Semua data lokal,
tanpa akun, tanpa telemetri, tanpa "Acceptable Ads".

| Modul | Meniru | Isi |
|---|---|---|
| Browser Lock (`modules/lock/`) | Set password for your browser (Chrome Lock) | Kunci browser dengan password (hash PBKDF2), kode pemulihan sekali pakai, kunci saat startup/idle/layar terkunci, jeda setelah salah 5x. **Gerbang wajib**: sebelum password dibuat, modul lain belum bisa dipakai |
| Tab Manager (`modules/tabs/`) | Toby: Tab Manager & Session Saver | Dashboard New Tab: ruang → koleksi → kartu tab, simpan sesi, drag & drop, grup tab, pencarian, omnibox `tm`, impor/ekspor |
| Ad Blocker (`modules/adblock/`) | Adblock Plus | Filter list (EasyList, ABPindo, EasyPrivacy, …) dikompilasi ke aturan declarativeNetRequest, sembunyikan elemen, izinkan situs, jeda, filter sendiri, "Blokir elemen", iklan video YouTube |

Struktur folder:

```
my-chrome-universe/
  manifest.json, background.js     satu service worker; meng-import core lalu tiap modul
  popup.html/.js/.css              popup toolbar: grid modul → panel modul
  options.html/.js                 halaman pengaturan bersama (menu samping per modul)
  core/                            registry modul, gerbang kunci, menu klik kanan bersama, helper panel
  modules/{lock,tabs,adblock}/     kode tiap modul (background, panel.js, halaman, aset)
```

## Memasang

`chrome://extensions` → Developer mode → **Load unpacked** → pilih folder `my-chrome-universe/`.
Bila sebelumnya memasang tiga extension lama (Browser Lock, Tab Manager, Ad Blocker), **hapus ketiganya** dulu agar
shortcut, menu klik kanan, dan New Tab tidak bentrok. Data lama tidak ikut pindah. Saat pertama dibuka, extension
meminta pembuatan password (Browser Lock) dan menampilkan kode pemulihan sekali; simpan kode itu.

Ikon toolbar membuka popup berisi grid modul; ketuk satu modul untuk panelnya, sakelar "Aktif" di tiap panel
mematikan/menyalakan modul itu. Tombol ⚙ membuka halaman pengaturan bersama (`options.html#<id>`): menu samping per
modul, sakelar, dan pengaturan lengkap modul. Mematikan Browser Lock selalu meminta password saat ini.

## Tes

```bash
node --test tests/core.test.mjs tests/browser-lock.test.mjs tests/tab-manager.test.mjs tests/ad-blocker.test.mjs
node --test tests/universe.e2e.mjs      # E2E seluruh extension di Chromium sungguhan
```

Iklan video YouTube tidak bisa diblokir lewat aturan jaringan; `modules/adblock/youtube-main.js` membuang data iklan
dari respons pemutar. Cek langsung ke YouTube asli (butuh internet): `node tests/youtube.live.mjs [url-video]`.

Tes E2E memuat extension ke Chromium milik Playwright (`npx playwright@1 install chromium`; dicari oleh
`tests/chromium.mjs` di Windows/Linux/macOS, atau atur `CHROME_PATH`), karena Chrome bermerek tidak lagi menerima
`--load-extension`. `node tests/feed.live.mjs` menguji update dari feed GitHub Pages yang asli.

Konteks untuk Claude Code: `CLAUDE.md` (aturan kerja), `HANDOFF.md` (briefing lanjutan), `docs/PROJECT_HISTORY.md`
(riwayat, temuan reverse-engineering, keputusan), `docs/superpowers/specs/2026-10-16-my-chrome-universe-design.md` (desain penyatuan).

## Filter bot (update filter list Ad Blocker)

`filter-bot/bot.mjs` mengambil filter list dari banyak proyek, menggabungkannya per kategori, mengompilasinya
dengan `my-chrome-universe/modules/adblock/filters.js`, dan menerbitkan satu *feed*:

| Kategori | Sumber | Bawaan |
|---|---|---|
| Iklan | EasyList, ABP Anti-Circumvention, Adblock Warning Removal (AdBlock), uBlock filters + Quick fixes + Unbreak, AdGuard Base | aktif |
| Indonesia | ABPindo, AdBlockID | aktif bila bahasa browser Indonesia |
| Keamanan | uBlock Badware, uBlock Resource abuse, NoCoin (AdBlock) | aktif |
| Privasi | EasyPrivacy, uBlock Privacy | — |
| Gangguan | Fanboy's Annoyance (AdBlock), uBlock Annoyances + Cookie Notices, AdGuard Annoyances | — |

Sumber diatur di `filter-bot/sources.json`. Dinonaktifkan: AdGuard Tracking Protection (~240.000 aturan, melebihi
batas Chrome) dan dua list AdBlock tanpa lisensi (`adblock_custom`, Distraction Control).

```bash
node filter-bot/bot.mjs                      # ambil semua sumber → feed/
node filter-bot/bot.mjs --update-extension   # sekaligus perbarui ruleset bawaan my-chrome-universe/modules/adblock/
node filter-bot/bot.mjs --offline            # bangun ulang dari salinan feed/raw tanpa internet
```

Isi feed: `index.json` (versi, kategori, status tiap sumber), `rules/<kategori>.json`, `cosmetic/<kategori>.json`,
`raw/` (salinan terakhir tiap sumber, dipakai bila sumber sedang mati) dan `changes.json` (perubahan dari versi sebelumnya).

Feed publik: https://mahalbangetid-beep.github.io/ad-blocker-filters/index.json
(repo: https://github.com/mahalbangetid-beep/ad-blocker-filters).

GitHub Actions (`.github/workflows/filter-bot.yml`) menjalankannya setiap hari pukul 08.17 WIB: unit test → bangun feed →
muat ruleset baru ke Chromium dan pastikan iklan masih terblokir → terbitkan ke branch `gh-pages`. Bila ada sumber yang
tidak tersedia sama sekali, atau verifikasi gagal, feed tidak diterbitkan.

**Pembaruan otomatis di extension** (`modules/adblock/updater.js`): sekali sehari (chrome.alarms) dan lewat tombol
"Perbarui sekarang" di Pengaturan, extension mengambil `index.json`, mengunduh kategori yang aktif, memeriksa SHA-256,
lalu membandingkannya dengan ruleset bawaan: aturan baru → aturan dinamis (maks. 30.000, 5.000 disisakan untuk
allowlist/filter sendiri), aturan yang dihapus → `updateStaticRules` (maks. 5.000), filter elemen → diganti seluruhnya.
Feed hanya berisi data dan divalidasi: aksi selain `block`/`allow`/`allowAllRequests` dan selector berisi `{}` ditolak.
Bila perubahan melebihi batas Chrome, aturan jaringan bawaan dipertahankan sampai extension diperbarui. Domain
dikelompokkan per hash agar satu perubahan filter hanya mengubah satu aturan.

Lisensi sumber: EasyList/EasyPrivacy (GPLv3 / CC BY-SA 3.0), Fanboy (CC BY 3.0), uBlock Origin & AdGuard & ABPindo &
AdBlockID (GPLv3), NoCoin (MIT), ABP Anti-Circumvention (CC BY-SA 3.0).

UI Tab Manager bisa dicoba di browser biasa dengan API `chrome` tiruan:
`node tests/harness/serve.mjs`, lalu buka `http://localhost:8765/my-chrome-universe/modules/tabs/newtab.html?harness`.

## Menambah modul baru

1. Buat folder `my-chrome-universe/modules/<id>/` berisi `background.js` (opsional), `panel.js`, dan halaman/aset modul.
2. Daftarkan di `MODULES` (`core/modules.js`): `id`, `name`, `icon` (nama ikon dari `ui/icons.js`), `panel`, `options`
   (path halaman opsi atau `null`). Kartu modul di popup (dengan sakelar aktif/nonaktif) dan menu samping halaman
   pengaturan otomatis mengikuti daftar ini.
3. `panel.js` mengekspor `render(root, opts)` (isi panel di popup; helper `offNotice`/`messageLine`/`loadStyles`/`favTile`
   ada di `core/panel.js`; gaya panel di `panel.css` modul lewat `loadStyles`), `status()` (teks kecil di kartu, mis.
   "aktif"), dan opsional `hero()` (`{ title, subtitle, value, favUrl? }` atau `null`) untuk kartu situs di beranda popup.
4. Pakai awalan sendiri untuk tipe pesan dan kunci storage (`lock:`, `tm:`, `ab:`; `core:` milik core).
5. Di `background.js` modul: daftarkan listener di top level, jangan top-level await, simpan state di `chrome.storage`.
   Handler pesan memanggil `messageAllowed(type)` (`core/gate.js`) sehingga tertolak (`{ok:false,error:'locked'}`)
   saat browser terkunci; tipe yang boleh dipakai layar kunci masuk `PUBLIC_MESSAGES`.
6. Setiap halaman extension (kecuali layar kunci dan setup) memanggil `await guardPage('tab' | 'popup' | 'frame')`
   (`core/page-guard.js`) sebelum membaca data apa pun.
7. Item menu klik kanan didaftarkan lewat `registerMenuProvider(id, async () => [props])` (`core/menus.js`); jangan memanggil
   `chrome.contextMenus.removeAll` sendiri. Menu dibangun ulang bila modul dinyalakan/dimatikan.
8. `import './modules/<id>/background.js'` di `background.js`; tambahkan `permissions`/`commands` ke manifest
   (maksimal 4 shortcut ber-`suggested_key`; terpakai 3). Aturan dinamis declarativeNetRequest seluruhnya milik modul adblock.
9. Tambahkan unit test (`tests/<id>.test.mjs`) dan satu tes di `tests/universe.e2e.mjs` (tes gerbang kunci tetap di akhir berkas).
