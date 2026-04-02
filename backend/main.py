import os
import math
import asyncio
import tempfile
import logging
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional
import random

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("gpx2geopdf")

import httpx
from PIL import Image
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="GPX to GeoPDF")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

RAPIDAPI_KEY = os.environ.get("RAPIDAPI_KEY", "")
MAPBOX_TOKEN = os.environ.get("MAPBOX_TOKEN", "")
TILE_URL_RAPIDAPI = "https://retina-tiles.p.rapidapi.com/local/osm@2x/v1/{z}/{x}/{y}.png"
TILE_SIZE = 512
TEMP_DIR = Path(tempfile.gettempdir()) / "gpx2geopdf"
TEMP_DIR.mkdir(exist_ok=True)

BASEMAP_URLS = {
    "osm":            ("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", False),
    "topo":           ("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", False),
    "cyclosm":        ("https://tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png", False),
    "humanitarian":   ("https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png", False),
    "mapbox-outdoor": ("https://api.mapbox.com/styles/v1/mapbox/outdoors-v12/tiles/512/{z}/{x}/{y}@2x?access_token={token}", False),
}


def deg2num(lat, lon, zoom):
    lat_r = math.radians(lat)
    n = 2 ** zoom
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(lat_r)) / math.pi) / 2.0 * n)
    return x, y


def num2deg(x, y, zoom):
    n = 2 ** zoom
    lon = x / n * 360.0 - 180.0
    lat_r = math.atan(math.sinh(math.pi * (1 - 2 * y / n)))
    return math.degrees(lat_r), lon


def parse_gpx(content: bytes):
    root = ET.fromstring(content)
    ns = {"gpx": "http://www.topografix.com/GPX/1/1"}
    points = []
    for pt in root.findall(".//gpx:trkpt", ns):
        points.append((float(pt.attrib["lat"]), float(pt.attrib["lon"])))
    if not points:
        for pt in root.findall(".//gpx:wpt", ns):
            points.append((float(pt.attrib["lat"]), float(pt.attrib["lon"])))
    if not points:
        raise ValueError("No track points found in GPX file")
    lats = [p[0] for p in points]; lons = [p[1] for p in points]
    return {"points": points, "min_lat": min(lats), "max_lat": max(lats), "min_lon": min(lons), "max_lon": max(lons)}


def choose_zoom(min_lat, max_lat, min_lon, max_lon, max_tiles=16):
    for zoom in range(16, 8, -1):
        x0, y0 = deg2num(max_lat, min_lon, zoom)
        x1, y1 = deg2num(min_lat, max_lon, zoom)
        if (abs(x1-x0)+1) * (abs(y1-y0)+1) <= max_tiles:
            return zoom
    return 9


async def fetch_tile(client, z, x, y, tile_url_template, use_rapidapi=False, use_mapbox=False):
    if use_rapidapi:
        url = TILE_URL_RAPIDAPI.format(z=z, x=x, y=y)
        headers = {"x-rapidapi-key": RAPIDAPI_KEY, "x-rapidapi-host": "retina-tiles.p.rapidapi.com"}
    elif use_mapbox:
        url = tile_url_template.replace('{z}', str(z)).replace('{x}', str(x)).replace('{y}', str(y))
        headers = {"User-Agent": "TrailMap/1.0 (personal hiking tool)"}
    else:
        sub = random.choice(['a', 'b', 'c'])
        url = tile_url_template.replace('{s}', sub).replace('{z}', str(z)).replace('{x}', str(x)).replace('{y}', str(y))
        headers = {"User-Agent": "TrailMap/1.0 (personal hiking tool)"}
    try:
        r = await client.get(url, headers=headers, timeout=15)
        if r.status_code == 200:
            return r.content
        logger.warning(f"Tile fetch HTTP {r.status_code}: {url[:120]}")
    except Exception as e:
        logger.error(f"Tile fetch exception: {e} — url={url[:120]}")
    return None


async def stitch_tiles(min_lat, max_lat, min_lon, max_lon, zoom, job_id, tile_url_template, use_rapidapi=False, use_mapbox=False):
    x0, y0 = deg2num(max_lat, min_lon, zoom)
    x1, y1 = deg2num(min_lat, max_lon, zoom)
    x0 -= 1; y0 -= 1; x1 += 1; y1 += 1

    tile_w = TILE_SIZE if (use_rapidapi or use_mapbox) else 256
    canvas = Image.new("RGB", ((x1-x0+1)*tile_w, (y1-y0+1)*tile_w), (240, 240, 240))

    async with httpx.AsyncClient() as client:
        tasks = [fetch_tile(client, zoom, tx, ty, tile_url_template, use_rapidapi, use_mapbox)
                 for ty in range(y0, y1+1) for tx in range(x0, x1+1)]
        coords = [(tx, ty) for ty in range(y0, y1+1) for tx in range(x0, x1+1)]
        results = await asyncio.gather(*tasks)

    for (tx, ty), tile_bytes in zip(coords, results):
        if tile_bytes:
            from io import BytesIO
            tile_img = Image.open(BytesIO(tile_bytes)).convert("RGB")
            if tile_img.size != (tile_w, tile_w):
                tile_img = tile_img.resize((tile_w, tile_w), Image.LANCZOS)
            canvas.paste(tile_img, ((tx-x0)*tile_w, (ty-y0)*tile_w))

    img_path = str(TEMP_DIR / f"{job_id}_map.png")
    canvas.save(img_path)
    top_lat, left_lon = num2deg(x0, y0, zoom)
    bot_lat, right_lon = num2deg(x1+1, y1+1, zoom)
    return img_path, left_lon, top_lat, right_lon, bot_lat


def hex_to_rgba(hex_str, alpha=220):
    h = hex_str.lstrip('#')
    try:
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except Exception:
        r, g, b = 255, 60, 60
    return (r, g, b, alpha)


def resolve_basemap(basemap_id: str):
    """Return (tile_url_template, use_rapidapi, use_mapbox)"""
    if basemap_id == "osm" and RAPIDAPI_KEY:
        return TILE_URL_RAPIDAPI, True, False
    if basemap_id == "mapbox-outdoor":
        if not MAPBOX_TOKEN:
            raise HTTPException(500, "MAPBOX_TOKEN belum dikonfigurasi di server (.env)")
        tile_url_tmpl = BASEMAP_URLS["mapbox-outdoor"][0].replace("{token}", MAPBOX_TOKEN)
        logger.info(f"resolve_basemap: mapbox-outdoor, token prefix={MAPBOX_TOKEN[:8]}...")
        return tile_url_tmpl, False, True
    tile_url_tmpl, _ = BASEMAP_URLS.get(basemap_id, BASEMAP_URLS["osm"])
    return tile_url_tmpl, False, False


@app.get("/api/debug")
async def debug_config():
    return {
        "RAPIDAPI_KEY_set": bool(RAPIDAPI_KEY),
        "MAPBOX_TOKEN_set": bool(MAPBOX_TOKEN),
        "MAPBOX_TOKEN_prefix": MAPBOX_TOKEN[:8] + "..." if MAPBOX_TOKEN else "(kosong)",
    }


@app.get("/api/config")
async def get_config():
    return {
        "mapbox_token": MAPBOX_TOKEN if MAPBOX_TOKEN else None,
    }


def draw_track_overlay(img_path, points, left_lon, top_lat, right_lon, bot_lat, out_path, color_rgba=(255,60,60,220)):
    from PIL import ImageDraw
    img = Image.open(img_path).convert("RGBA")
    w, h = img.size
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    def to_px(lat, lon):
        return (int((lon-left_lon)/(right_lon-left_lon)*w), int((top_lat-lat)/(top_lat-bot_lat)*h))

    pixel_points = [to_px(lat, lon) for lat, lon in points]
    for i in range(len(pixel_points)-1):
        draw.line([pixel_points[i], pixel_points[i+1]], fill=color_rgba, width=6)
    if pixel_points:
        sx, sy = pixel_points[0]
        draw.ellipse([sx-10,sy-10,sx+10,sy+10], fill=(0,200,80,255), outline=(255,255,255,255), width=2)
        ex, ey = pixel_points[-1]
        draw.ellipse([ex-10,ey-10,ex+10,ey+10], fill=(220,50,50,255), outline=(255,255,255,255), width=2)

    Image.alpha_composite(img, overlay).convert("RGB").save(out_path)


# ── FIX: Pipeline georeferencing yang benar untuk Avenza Maps ──
# Pipeline lama (SALAH):
#   PNG → gdal_translate (GTiff+GCP) → gdal_translate (PDF OGC)
#   GCP yang di-embed di GTiff tidak otomatis menjadi proyeksi valid di PDF.
#
# Pipeline baru (BENAR):
#   PNG → gdal_translate (GTiff+GCP) → gdalwarp (warp ke EPSG:4326) → gdal_translate (PDF OGC)
#   gdalwarp mengubah GCP menjadi proyeksi nyata sehingga PDF dibaca sebagai peta referensi valid.

def create_geopdf(img_path, left_lon, top_lat, right_lon, bot_lat, out_path):
    import subprocess
    w, h = Image.open(img_path).size

    gcps = [
        f"-gcp 0 0 {left_lon} {top_lat}",
        f"-gcp {w} 0 {right_lon} {top_lat}",
        f"-gcp {w} {h} {right_lon} {bot_lat}",
        f"-gcp 0 {h} {left_lon} {bot_lat}",
    ]

    georef_gcp = out_path.replace(".pdf", "_georef_gcp.tif")
    georef_warped = out_path.replace(".pdf", "_georef_warped.tif")

    # Step 1: embed GCP ke GTiff
    subprocess.run(
        f"gdal_translate -of GTiff {' '.join(gcps)} -a_srs EPSG:4326 {img_path} {georef_gcp}",
        shell=True, check=True
    )
    # Step 2: warp GCP → proyeksi nyata EPSG:4326 (FIX UTAMA)
    subprocess.run(
        f"gdalwarp -t_srs EPSG:4326 -r lanczos {georef_gcp} {georef_warped}",
        shell=True, check=True
    )
    # Step 3: ekspor ke PDF OGC GeoPDF
    subprocess.run(
        f"gdal_translate -of PDF -co GEO_ENCODING=OGC {georef_warped} {out_path}",
        shell=True, check=True
    )

    for p in [georef_gcp, georef_warped]:
        try: os.remove(p)
        except: pass


@app.post("/api/preview")
async def preview_gpx(file: UploadFile = File(...)):
    content = await file.read()
    try:
        gpx = parse_gpx(content)
    except Exception as e:
        raise HTTPException(400, str(e))
    zoom = choose_zoom(gpx["min_lat"], gpx["max_lat"], gpx["min_lon"], gpx["max_lon"])
    points = gpx["points"]
    total_dist = sum(
        6371 * 2 * math.atan2(
            math.sqrt((math.sin((math.radians(points[i][0]-points[i-1][0]))/2))**2 +
                      math.cos(math.radians(points[i-1][0])) * math.cos(math.radians(points[i][0])) *
                      (math.sin((math.radians(points[i][1]-points[i-1][1]))/2))**2),
            math.sqrt(1 - ((math.sin((math.radians(points[i][0]-points[i-1][0]))/2))**2 +
                           math.cos(math.radians(points[i-1][0])) * math.cos(math.radians(points[i][0])) *
                           (math.sin((math.radians(points[i][1]-points[i-1][1]))/2))**2))
        ) for i in range(1, len(points))
    )
    return JSONResponse({"min_lat": gpx["min_lat"], "max_lat": gpx["max_lat"], "min_lon": gpx["min_lon"], "max_lon": gpx["max_lon"], "point_count": len(points), "distance_km": round(total_dist, 2), "zoom": zoom})


@app.post("/api/generate")
async def generate_geopdf(
    file: UploadFile = File(...),
    track_color: str = Form("#ff3c3c"),
    basemap_id: str = Form("osm"),
):
    if not RAPIDAPI_KEY and basemap_id != "mapbox-outdoor":
        raise HTTPException(500, "RAPIDAPI_KEY not configured")

    content = await file.read()
    try:
        gpx = parse_gpx(content)
    except Exception as e:
        raise HTTPException(400, str(e))

    import uuid
    job_id = str(uuid.uuid4())[:8]
    zoom = choose_zoom(gpx["min_lat"], gpx["max_lat"], gpx["min_lon"], gpx["max_lon"])

    tile_url_template, use_rapidapi, use_mapbox = resolve_basemap(basemap_id)

    try:
        img_path, left_lon, top_lat, right_lon, bot_lat = await stitch_tiles(
            gpx["min_lat"], gpx["max_lat"], gpx["min_lon"], gpx["max_lon"], zoom, job_id,
            tile_url_template=tile_url_template, use_rapidapi=use_rapidapi, use_mapbox=use_mapbox
        )
    except Exception as e:
        raise HTTPException(500, f"Tile fetch error: {e}")

    color_rgba = hex_to_rgba(track_color)
    tracked_path = str(TEMP_DIR / f"{job_id}_tracked.png")
    draw_track_overlay(img_path, gpx["points"], left_lon, top_lat, right_lon, bot_lat, tracked_path, color_rgba)

    pdf_path = str(TEMP_DIR / f"{job_id}_output.pdf")
    try:
        create_geopdf(tracked_path, left_lon, top_lat, right_lon, bot_lat, pdf_path)
    except Exception as e:
        raise HTTPException(500, f"GeoPDF generation error: {e}")

    for p in [img_path, tracked_path]:
        try: os.remove(p)
        except: pass

    fname = Path(file.filename).stem if file.filename else "trail"
    return FileResponse(pdf_path, media_type="application/pdf", filename=f"{fname}_avenza.pdf")


# ── Paper sizes mm ──
PAPER_SIZES_MM = {
    "a4p": (210, 297), "a4l": (297, 210),
    "a3p": (297, 420), "a3l": (420, 297),
    "a5p": (148, 210), "ltr": (216, 279),
}
DPI = 150


# ── NOTE: create_print_pdf adalah untuk cetak biasa (tanpa georeferencing) ──
# Print PDF tidak bisa di-georeferensikan karena map di-resize dan di-paste
# ke canvas kertas dengan margin/footer — koordinat pixel tidak linear terhadap geo.
# Untuk output yang bisa dibuka di Avenza, gunakan /api/generate atau /api/generate-geofit.
def create_print_pdf(img_path: str, pw_mm: float, ph_mm: float, out_path: str):
    import subprocess
    from PIL import ImageDraw
    pw_px = int(pw_mm / 25.4 * DPI)
    ph_px = int(ph_mm / 25.4 * DPI)
    margin_px = int(10 / 25.4 * DPI)
    footer_px = int(12 / 25.4 * DPI)

    map_img = Image.open(img_path).convert("RGB")
    mw, mh = map_img.size
    avail_w = pw_px - 2 * margin_px
    avail_h = ph_px - 2 * margin_px - footer_px
    scale = min(avail_w / mw, avail_h / mh)
    new_w, new_h = int(mw * scale), int(mh * scale)
    map_resized = map_img.resize((new_w, new_h), Image.LANCZOS)

    canvas = Image.new("RGB", (pw_px, ph_px), (255, 255, 255))
    x_off = margin_px + (avail_w - new_w) // 2
    y_off = margin_px
    canvas.paste(map_resized, (x_off, y_off))

    draw = ImageDraw.Draw(canvas)
    draw.rectangle([x_off-1, y_off-1, x_off+new_w, y_off+new_h], outline=(180,180,180), width=1)
    footer_y = y_off + new_h + int(4 / 25.4 * DPI)
    draw.text((margin_px, footer_y), "Generated by TrailMap  •  © OpenStreetMap contributors", fill=(140,140,140))

    tmp_png = out_path.replace(".pdf", "_canvas.png")
    canvas.save(tmp_png, dpi=(DPI, DPI))
    subprocess.run(f"gdal_translate -of PDF {tmp_png} {out_path}", shell=True, check=True)
    os.remove(tmp_png)


@app.post("/api/generate-print")
async def generate_print_pdf(
    file: UploadFile = File(...),
    track_color: str = Form("#ff3c3c"),
    basemap_id: str = Form("osm"),
    paper_size: str = Form("a4p"),
):
    if not RAPIDAPI_KEY and basemap_id != "mapbox-outdoor":
        raise HTTPException(500, "RAPIDAPI_KEY not configured")

    content = await file.read()
    try:
        gpx = parse_gpx(content)
    except Exception as e:
        raise HTTPException(400, str(e))

    import uuid
    job_id = str(uuid.uuid4())[:8]
    zoom = choose_zoom(gpx["min_lat"], gpx["max_lat"], gpx["min_lon"], gpx["max_lon"])

    tile_url_template, use_rapidapi, use_mapbox = resolve_basemap(basemap_id)

    try:
        img_path, left_lon, top_lat, right_lon, bot_lat = await stitch_tiles(
            gpx["min_lat"], gpx["max_lat"], gpx["min_lon"], gpx["max_lon"], zoom, job_id,
            tile_url_template=tile_url_template, use_rapidapi=use_rapidapi, use_mapbox=use_mapbox
        )
    except Exception as e:
        raise HTTPException(500, f"Tile fetch error: {e}")

    color_rgba = hex_to_rgba(track_color)
    tracked_path = str(TEMP_DIR / f"{job_id}_tracked.png")
    draw_track_overlay(img_path, gpx["points"], left_lon, top_lat, right_lon, bot_lat, tracked_path, color_rgba)

    pw_mm, ph_mm = PAPER_SIZES_MM.get(paper_size, (210, 297))
    pdf_path = str(TEMP_DIR / f"{job_id}_print.pdf")
    try:
        create_print_pdf(tracked_path, pw_mm, ph_mm, pdf_path)
    except Exception as e:
        raise HTTPException(500, f"Print PDF error: {e}")

    for p in [img_path, tracked_path]:
        try: os.remove(p)
        except: pass

    fname = Path(file.filename).stem if file.filename else "trail"
    return FileResponse(pdf_path, media_type="application/pdf", filename=f"{fname}_{paper_size.upper()}.pdf")


def create_geopdf_fit(img_path: str, left_lon: float, top_lat: float,
                      right_lon: float, bot_lat: float,
                      pw_mm: float, ph_mm: float, out_path: str):
    """GeoPDF yang di-fit ke ukuran kertas, georeferencing tetap valid."""
    import subprocess
    from PIL import ImageDraw

    DPI_GEO = 150
    pw_px = int(pw_mm / 25.4 * DPI_GEO)
    ph_px = int(ph_mm / 25.4 * DPI_GEO)
    margin_px = int(8 / 25.4 * DPI_GEO)
    footer_px = int(10 / 25.4 * DPI_GEO)

    map_img = Image.open(img_path).convert("RGB")
    mw, mh = map_img.size

    avail_w = pw_px - 2 * margin_px
    avail_h = ph_px - 2 * margin_px - footer_px
    scale = min(avail_w / mw, avail_h / mh)
    new_w, new_h = int(mw * scale), int(mh * scale)
    map_resized = map_img.resize((new_w, new_h), Image.LANCZOS)

    canvas = Image.new("RGB", (pw_px, ph_px), (255, 255, 255))
    x_off = margin_px + (avail_w - new_w) // 2
    y_off = margin_px
    canvas.paste(map_resized, (x_off, y_off))

    draw = ImageDraw.Draw(canvas)
    draw.rectangle([x_off-1, y_off-1, x_off+new_w, y_off+new_h], outline=(180,180,180), width=1)
    footer_y = y_off + new_h + int(3 / 25.4 * DPI_GEO)
    draw.text((margin_px, footer_y), "Generated by TrailMap  •  © OpenStreetMap contributors", fill=(140,140,140))

    tmp_png = out_path.replace(".pdf", "_geofit_canvas.png")
    canvas.save(tmp_png, dpi=(DPI_GEO, DPI_GEO))

    # Georeferencing: GCP pada posisi pixel map di canvas final
    gcps = [
        f"-gcp {x_off} {y_off} {left_lon} {top_lat}",
        f"-gcp {x_off+new_w} {y_off} {right_lon} {top_lat}",
        f"-gcp {x_off+new_w} {y_off+new_h} {right_lon} {bot_lat}",
        f"-gcp {x_off} {y_off+new_h} {left_lon} {bot_lat}",
    ]

    georef_gcp = out_path.replace(".pdf", "_geofit_georef_gcp.tif")
    georef_warped = out_path.replace(".pdf", "_geofit_georef_warped.tif")

    # Step 1: embed GCP
    subprocess.run(
        f"gdal_translate -of GTiff {' '.join(gcps)} -a_srs EPSG:4326 {tmp_png} {georef_gcp}",
        shell=True, check=True
    )
    # Step 2: warp GCP → proyeksi nyata (FIX UTAMA untuk Avenza)
    subprocess.run(
        f"gdalwarp -t_srs EPSG:4326 -r lanczos {georef_gcp} {georef_warped}",
        shell=True, check=True
    )
    # Step 3: ekspor ke PDF OGC GeoPDF
    subprocess.run(
        f"gdal_translate -of PDF -co GEO_ENCODING=OGC {georef_warped} {out_path}",
        shell=True, check=True
    )

    for p in [tmp_png, georef_gcp, georef_warped]:
        try: os.remove(p)
        except: pass


@app.post("/api/generate-geofit")
async def generate_geofit(
    file: UploadFile = File(...),
    track_color: str = Form("#ff3c3c"),
    basemap_id: str = Form("osm"),
    paper_size: str = Form("a4p"),
):
    if not RAPIDAPI_KEY and basemap_id != "mapbox-outdoor":
        raise HTTPException(500, "RAPIDAPI_KEY not configured")

    content = await file.read()
    try:
        gpx = parse_gpx(content)
    except Exception as e:
        raise HTTPException(400, str(e))

    import uuid
    job_id = str(uuid.uuid4())[:8]
    zoom = choose_zoom(gpx["min_lat"], gpx["max_lat"], gpx["min_lon"], gpx["max_lon"])

    tile_url_template, use_rapidapi, use_mapbox = resolve_basemap(basemap_id)

    try:
        img_path, left_lon, top_lat, right_lon, bot_lat = await stitch_tiles(
            gpx["min_lat"], gpx["max_lat"], gpx["min_lon"], gpx["max_lon"], zoom, job_id,
            tile_url_template=tile_url_template, use_rapidapi=use_rapidapi, use_mapbox=use_mapbox
        )
    except Exception as e:
        raise HTTPException(500, f"Tile fetch error: {e}")

    color_rgba = hex_to_rgba(track_color)
    tracked_path = str(TEMP_DIR / f"{job_id}_tracked.png")
    draw_track_overlay(img_path, gpx["points"], left_lon, top_lat, right_lon, bot_lat, tracked_path, color_rgba)

    pw_mm, ph_mm = PAPER_SIZES_MM.get(paper_size, (210, 297))
    pdf_path = str(TEMP_DIR / f"{job_id}_geofit.pdf")
    try:
        create_geopdf_fit(tracked_path, left_lon, top_lat, right_lon, bot_lat, pw_mm, ph_mm, pdf_path)
    except Exception as e:
        raise HTTPException(500, f"GeoPDF fit error: {e}")

    for p in [img_path, tracked_path]:
        try: os.remove(p)
        except: pass

    fname = Path(file.filename).stem if file.filename else "trail"
    return FileResponse(pdf_path, media_type="application/pdf", filename=f"{fname}_avenza_{paper_size}.pdf")


# ── Static files HARUS di-mount PALING AKHIR ──
frontend_dist = Path("/app/frontend/dist")
if frontend_dist.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dist), html=True), name="static")
