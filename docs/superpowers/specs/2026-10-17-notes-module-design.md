# Modul "Catatan Tempel" (tiruan Note Anywhere) — desain

> 2026-10-17. Sumber: Note Anywhere v1.2.0 (`bohahkiiknkelflnjjlipnaeapefmjbh`) yang terpasang di Chrome pengguna,
> dibedah dengan REA + pembacaan bundel yang dirapikan. Pengguna memilih "langsung mulai" (tanpa sesi tanya-jawab);
> keputusan di bawah yang bertanda **(keputusan kita)** belum dikonfirmasi pengguna.

## Tujuan

Menempel catatan seperti sticky note di halaman web mana pun, tersimpan per halaman, muncul lagi saat halaman dibuka.
Fiturnya setara Note Anywhere, tetapi lokal, aman, dan bergaya "Universe", sebagai modul keempat My Chrome Universe.

## Yang ditiru dari Note Anywhere (temuan reverse engineering)

| Note Anywhere | Modul kita |
|---|---|
| Content script di semua http/https, `<note-anywhere-sticky>` + shadow DOM *open* | Content script terdaftar lewat `chrome.scripting` hanya saat modul aktif; satu host `<mcu-notes>` dengan shadow DOM *closed* |
| Posisi `absolute` (ikut gulir), Pin → `fixed` | Sama |
| Seret lewat bilah, ubah ukuran di pojok kanan bawah, min 150×180 | Sama (pointer events + `setPointerCapture`) |
| Isi `contenteditable`, disimpan sebagai **HTML** | **Teks biasa** (`<textarea>`), dirender dengan `value`/`textContent` — menutup celah XSS **(keputusan kita)** |
| Simpan otomatis 600 ms setelah mengetik | Sama |
| Menu: 7 warna, Pin, Delete; animasi hapus | Menu: 7 warna palet Universe, Sematkan, Hapus; animasi masuk/hapus mengikuti tingkat gerak |
| Iconize (ikon 24 px), Hide/Show semua | Sama ("Jadikan ikon" → orb berwarna; "Sembunyikan") |
| Klik kanan "Add Note Here" di titik klik; popup "Add Note" di posisi acak | Klik kanan "Tempel catatan di sini"; popup "Tempel catatan" di dekat tengah layar (bertingkat) |
| IndexedDB, kunci URL tanpa `#hash`, hapus lunak `deleted:1` | `chrome.storage.local`: `nt:p:<url>` per halaman + `nt:index` ringkasan; hapus sungguhan (tidak ada sync) |
| Badge jumlah catatan per tab | **Tidak** (badge milik Ad Blocker); jumlah tampil di kartu/panel popup **(keputusan kita)** |
| Popup: Add, Hide/Show, Iconize, Delete semua, daftar catatan halaman | Panel popup modul: sama + klik catatan di daftar → catatan disorot di halaman |
| Options: Summary (URL per jumlah, hapus per URL, ekspor CSV), Settings (warna, font, ukuran, tanggal di bilah) | Bagian "Catatan Tempel" di `options.html`: warna bawaan, huruf, ukuran, tanggal di bilah, daftar halaman (buka/hapus, cari), ekspor JSON/CSV, impor JSON, hapus semua |
| Sync ke My Atoms (token di URL, data server menimpa lokal, `externally_connectable`) | **Dibuang** — prinsip lokal tanpa akun |
| Scan z-index semua elemen di setiap halaman | Tidak: host tunggal ber-z-index maksimum; urutan antar catatan di dalam shadow DOM |

Tambahan: navigasi SPA (`history.pushState`, mis. YouTube) memuat ulang catatan untuk URL baru
(`webNavigation.onHistoryStateUpdated`); perubahan dari tab lain di URL yang sama ikut tampil.

## Arsitektur

- `modules/notes/store.js` — logika murni (tanpa `chrome.*`, diuji di Node): `pageKey(url)`, `cleanNote`,
  `cleanSettings`, palet/huruf/ukuran, `toCsv`, `parseBackup`, `mergeBackup`.
- `modules/notes/background.js` — satu-satunya penulis data. Pesan:
  - dari content script (masuk `WEB_MESSAGES`, hanya frame utama tab http/https; URL halaman diambil dari
    `sender.tab.url`, bukan dari isi pesan — `sender.url` tidak mengikuti `history.pushState`): `nt:load`, `nt:save`, `nt:delete`.
  - dari halaman extension: `nt:pageState`, `nt:command` (new / toggleHidden / toggleIcons / focus),
    `nt:clearPage`, `nt:list`, `nt:getSettings`, `nt:saveSettings`, `nt:export`, `nt:import`, `nt:clearAll`.
  - Semua lewat `senderAllowed` + `messageAllowed` (terkunci → `locked`).
  - Content script didaftarkan/dicabut mengikuti sakelar modul; saat dinyalakan juga disuntikkan ke tab yang sudah
    terbuka, saat dimatikan semua tab diberi tahu `nt:off`.
- `modules/notes/content.js` — skrip klasik (IIFE; salinan baru mengganti salinan lama lewat `window.__mcuNotes.destroy`),
  dibangun dengan DOM API + constructed stylesheet (tanpa string markup), palet sendiri di shadow DOM, font sistem,
  menu gelap/terang mengikuti `prefers-color-scheme` halaman (pola picker), gerak mengikuti `core:appearance.motion`.
- `modules/notes/panel.js`, `panel.css`, `settings.js` — kontrak panel/pengaturan standar.
- Registry: `{ id: 'notes', name: 'Catatan Tempel', icon: 'note' }` (sebelum Browser Lock). Ikon `note` dan `pin` baru
  di `ui/icons.js`. Menu klik kanan lewat `registerMenuProvider`. Perintah keyboard `new-note` tanpa `suggested_key`
  (slot shortcut tetap 3/4).

## Data

```
nt:p:<url>   { url, title, notes: [{ id, text, x, y, w, h, z, color, pinned, created, updated }] }
nt:index     { [url]: { title, count, updated } }
nt:settings  { color: 'surya', font: 'sans'|'serif'|'mono', size: 's'|'m'|'l', showDate: true }
```

`<url>` = URL http(s) tanpa `#hash` (query dipertahankan, seperti aslinya). Batas: teks ≤ 20.000 karakter,
≤ 200 catatan per halaman, koordinat dibatasi 0…1.000.000, ukuran 150…2000 × 120…2000.

## Gerbang kunci

Saat terkunci semua tab ditutup oleh Browser Lock; selain itu `nt:load` dari tab yang tersisa dijawab `locked` sehingga
tidak ada catatan yang tampil. Halaman extension memakai `guardPage` seperti biasa.

## Pengujian

- `tests/notes.test.mjs` (unit, Node): store.js.
- `tests/universe.e2e.mjs`: buat catatan dari panel → ketik → muat ulang → tetap ada; seret/ubah ukuran tersimpan;
  warna + sematkan; hapus; daftar di pengaturan + ekspor; modul dimatikan → catatan hilang dari halaman.
