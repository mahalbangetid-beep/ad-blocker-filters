# Koleksi extension

Setiap folder adalah extension Chrome (Manifest V3) yang berdiri sendiri, tanpa build step.
Pasang lewat `chrome://extensions` → Developer mode → **Load unpacked** → pilih foldernya.

| Folder | Meniru | Isi |
|---|---|---|
| `browser-lock/` | Set password for your browser (Chrome Lock) | Kunci browser dengan password (hash PBKDF2), kunci saat startup/idle/layar terkunci, jeda setelah salah 5x |
| `tab-manager/` | Toby: Tab Manager & Session Saver | Dashboard New Tab: ruang → koleksi → kartu tab, simpan sesi, drag & drop, grup tab, pencarian, omnibox `tm`, impor/ekspor |
| `ad-blocker/` | Adblock Plus | Filter list (EasyList, ABPindo, EasyPrivacy, …) dikompilasi ke aturan declarativeNetRequest, sembunyikan elemen, izinkan situs, jeda, filter sendiri, "Blokir elemen" |

## Tes

```bash
node --test tests/browser-lock.test.mjs tests/tab-manager.test.mjs tests/ad-blocker.test.mjs
node --test tests/ad-blocker.e2e.mjs
```

Iklan video YouTube tidak bisa diblokir lewat aturan jaringan; `ad-blocker/youtube-main.js` membuang data iklan
dari respons pemutar. Cek langsung ke YouTube asli (butuh internet): `node tests/youtube.live.mjs [url-video]`.

Tes E2E Ad Blocker memuat extension ke Chromium milik Playwright (`npx playwright@1 install chromium`; dicari oleh
`tests/chromium.mjs` di Windows/Linux/macOS, atau atur `CHROME_PATH`), karena Chrome bermerek tidak lagi menerima
`--load-extension`. `node tests/feed.live.mjs` menguji update dari feed GitHub Pages yang asli.

Konteks untuk Claude Code: `CLAUDE.md` (aturan kerja), `HANDOFF.md` (briefing lanjutan), `docs/PROJECT_HISTORY.md`
(riwayat, temuan reverse-engineering, keputusan).

## Filter bot (update filter list Ad Blocker)

`filter-bot/bot.mjs` mengambil filter list dari banyak proyek, menggabungkannya per kategori, mengompilasinya
dengan `ad-blocker/filters.js`, dan menerbitkan satu *feed*:

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
node filter-bot/bot.mjs --update-extension   # sekaligus perbarui ruleset bawaan ad-blocker/
node filter-bot/bot.mjs --offline            # bangun ulang dari salinan feed/raw tanpa internet
```

Isi feed: `index.json` (versi, kategori, status tiap sumber), `rules/<kategori>.json`, `cosmetic/<kategori>.json`,
`raw/` (salinan terakhir tiap sumber, dipakai bila sumber sedang mati) dan `changes.json` (perubahan dari versi sebelumnya).

Feed publik: https://mahalbangetid-beep.github.io/ad-blocker-filters/index.json
(repo: https://github.com/mahalbangetid-beep/ad-blocker-filters).

GitHub Actions (`.github/workflows/filter-bot.yml`) menjalankannya setiap hari pukul 08.17 WIB: unit test → bangun feed →
muat ruleset baru ke Chromium dan pastikan iklan masih terblokir → terbitkan ke branch `gh-pages`. Bila ada sumber yang
tidak tersedia sama sekali, atau verifikasi gagal, feed tidak diterbitkan.

**Pembaruan otomatis di extension** (`ad-blocker/updater.js`): sekali sehari (chrome.alarms) dan lewat tombol
"Perbarui sekarang" di Pengaturan, extension mengambil `index.json`, mengunduh kategori yang aktif, memeriksa SHA-256,
lalu membandingkannya dengan ruleset bawaan: aturan baru → aturan dinamis (maks. 30.000, 5.000 disisakan untuk
allowlist/filter sendiri), aturan yang dihapus → `updateStaticRules` (maks. 5.000), filter elemen → diganti seluruhnya.
Feed hanya berisi data dan divalidasi: aksi selain `block`/`allow`/`allowAllRequests` dan selector berisi `{}` ditolak.
Bila perubahan melebihi batas Chrome, aturan jaringan bawaan dipertahankan sampai extension diperbarui. Domain
dikelompokkan per hash agar satu perubahan filter hanya mengubah satu aturan.

Lisensi sumber: EasyList/EasyPrivacy (GPLv3 / CC BY-SA 3.0), Fanboy (CC BY 3.0), uBlock Origin & AdGuard & ABPindo &
AdBlockID (GPLv3), NoCoin (MIT), ABP Anti-Circumvention (CC BY-SA 3.0).

UI Tab Manager bisa dicoba di browser biasa dengan API `chrome` tiruan:
`node tests/harness/serve.mjs`, lalu buka `http://localhost:8765/tab-manager/newtab.html?harness`.

## Catatan untuk menyatukan

- **Pesan runtime**: Tab Manager memakai tipe pesan berawalan `tm:`. Browser Lock masih memakai nama polos
  (`getState`, `unlock`, `lock`, …) — beri awalan (mis. `lock:`) saat digabung agar tidak bentrok.
- **Storage**: Tab Manager menyimpan satu kunci `tm:data`. Browser Lock memakai `auth`, `settings`, `failures`,
  `lockoutUntil` (local) dan `unlocked`, `savedTabs` (session) — `settings` sebaiknya diganti nama, misalnya `lock:settings`.
- **Service worker**: keduanya modul ES; gabungkan dengan satu `background.js` yang meng-`import` masing-masing modul.
  Setiap modul mendaftarkan listener `chrome.runtime.onMessage` sendiri dan hanya menjawab tipe pesannya (`return false` untuk yang lain), jadi bisa hidup berdampingan.
- **Interaksi**: saat browser terkunci, Browser Lock menutup semua tab selain layar kunci — termasuk dashboard Tab Manager.
  Itu perilaku yang benar; pastikan halaman `newtab.html` tidak dikecualikan dari penguncian.
- **Ad Blocker**: pesan berawalan `ab:`, storage `ab:settings`/`ab:total`/`ab:tabs`. `declarative_net_request.rule_resources`
  dibuat ulang oleh `filter-bot/bot.mjs --update-extension` — ubah `EXT_DIR` di skrip itu bila foldernya pindah saat digabung.
  Aturan dinamis (allowlist + filter saya) ditulis ulang seluruhnya oleh Ad Blocker; extension gabungan tidak boleh memakai
  aturan dinamis untuk keperluan lain tanpa membagi rentang ID.
- **Manifest**: gabungkan `permissions`, `commands` (maksimal 4 shortcut yang punya `suggested_key`), dan pilih satu `action.default_popup`.
