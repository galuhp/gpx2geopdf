# TrailMap — GPX to GeoPDF for Avenza

Convert GPX tracks (dari Strava, Garmin, Komoot, dll) menjadi GeoPDF yang bisa langsung diimport ke **Avenza Maps** untuk navigasi offline saat mendaki.

## Requirements

- Docker & Docker Compose
- RapidAPI key dengan akses ke **Retina Tiles** API (OSM)

## Setup

1. **Clone / copy project ini**

2. **Buat file `.env`** di root folder:
   ```
   RAPIDAPI_KEY=your_rapidapi_key_here
   ```

3. **Build & run:**
   ```bash
   docker compose up --build
   ```

4. **Buka browser:** http://localhost:8000

## Cara pakai

1. Upload file `.gpx` (drag & drop atau klik)
2. Preview rute di peta
3. Klik **Export GeoPDF for Avenza**
4. File `nama_avenza.pdf` otomatis terdownload
5. Transfer ke HP → Avenza Maps → `+` → **From Device**

## Output

- Format: **GeoPDF (OGC)** — compatible dengan Avenza Maps
- Basemap: **OpenStreetMap Retina** (via RapidAPI)
- CRS: **EPSG:4326**
- Track ditampilkan sebagai garis merah, titik start (hijau) dan end (merah)

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite + Leaflet |
| Backend | Python + FastAPI |
| Geo | GDAL |
| Tile | OSM Retina via RapidAPI |
| Container | Docker |

## Notes

- Zoom level dipilih otomatis berdasarkan extent GPX (max 16 tiles)
- GeoPDF dibuat dengan `gdal_translate` — same engine yang dipakai QGIS
- File temp dibersihkan otomatis setelah download
