import os, math, asyncio, tempfile, json, random
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional, List

import httpx
from PIL import Image
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="GPX to GeoPDF")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

RAPIDAPI_KEY   = os.environ.get("RAPIDAPI_KEY", "")
MAPBOX_TOKEN   = os.environ.get("MAPBOX_TOKEN", "")
TILE_RAPIDAPI  = "https://retina-tiles.p.rapidapi.com/local/osm@2x/v1/{z}/{x}/{y}.png"
TILE_SIZE_HI   = 512   # retina / mapbox
TILE_SIZE_STD  = 256
DPI_DEFAULT    = 150
TEMP_DIR = Path(tempfile.gettempdir()) / "gpx2geopdf"
TEMP_DIR.mkdir(exist_ok=True)

THUNDERFOREST_KEY = os.environ.get("THUNDERFOREST_KEY", "")

BASEMAP_URLS = {
    "osm":            ("https://tile.openstreetmap.org/{z}/{x}/{y}.png",                            False),
    "topo":           ("https://tile.opentopomap.org/{z}/{x}/{y}.png",                              False),
    "cyclosm":        ("https://tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png",             False),
    "humanitarian":   ("https://tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",                         False),
    "mapbox-outdoor": (None, False),  # resolved dynamically
    # Thunderforest Outdoors
    "tf-outdoors":    (None, False),
}

PAPER_SIZES_MM = {
    "a4p": (210, 297),  "a4l": (297, 210),
    "a3p": (297, 420),  "a3l": (420, 297),
    "a2p": (420, 594),  "a2l": (594, 420),
    "a1p": (594, 841),  "a1l": (841, 594),
    "a5p": (148, 210),  "ltr": (216, 279),
}

# ── Geo helpers ──────────────────────────────────────────────────────────────

def deg2num(lat, lon, zoom):
    lat_r = math.radians(lat); n = 2**zoom
    return int((lon+180)/360*n), int((1-math.asinh(math.tan(lat_r))/math.pi)/2*n)

def num2deg(x, y, zoom):
    n = 2**zoom
    return math.degrees(math.atan(math.sinh(math.pi*(1-2*y/n)))), x/n*360-180

def choose_zoom(min_lat, max_lat, min_lon, max_lon, max_tiles=16):
    for z in range(16, 8, -1):
        x0,y0 = deg2num(max_lat,min_lon,z); x1,y1 = deg2num(min_lat,max_lon,z)
        if (abs(x1-x0)+1)*(abs(y1-y0)+1) <= max_tiles: return z
    return 9

def parse_gpx(content: bytes):
    root = ET.fromstring(content)
    ns = {"g": "http://www.topografix.com/GPX/1/1"}
    pts = [(float(p.attrib["lat"]), float(p.attrib["lon"])) for p in root.findall(".//g:trkpt", ns)]
    if not pts:
        pts = [(float(p.attrib["lat"]), float(p.attrib["lon"])) for p in root.findall(".//g:wpt", ns)]
    if not pts: raise ValueError("No track points found")
    lats=[p[0] for p in pts]; lons=[p[1] for p in pts]
    return {"points":pts, "min_lat":min(lats), "max_lat":max(lats), "min_lon":min(lons), "max_lon":max(lons)}

def merge_bounds(gpx_list):
    return {
        "min_lat": min(g["min_lat"] for g in gpx_list),
        "max_lat": max(g["max_lat"] for g in gpx_list),
        "min_lon": min(g["min_lon"] for g in gpx_list),
        "max_lon": max(g["max_lon"] for g in gpx_list),
    }

# ── Tile fetching ────────────────────────────────────────────────────────────

async def fetch_tile(client, z, x, y, url_tpl, use_rapidapi=False, use_mapbox=False, use_thunderforest=False):
    if use_rapidapi:
        url = TILE_RAPIDAPI.format(z=z,x=x,y=y)
        headers = {"x-rapidapi-key": RAPIDAPI_KEY, "x-rapidapi-host": "retina-tiles.p.rapidapi.com"}
    elif use_mapbox:
        url = f"https://api.mapbox.com/styles/v1/mapbox/outdoors-v12/tiles/512/{z}/{x}/{y}@2x?access_token={MAPBOX_TOKEN}"
        headers = {"User-Agent": "TrailMap/1.0"}
    else:
        sub = random.choice(['a','b','c'])
        url = url_tpl.replace('{s}',sub).replace('{z}',str(z)).replace('{x}',str(x)).replace('{y}',str(y))
        headers = {"User-Agent": "TrailMap/1.0"}
    try:
        r = await client.get(url, headers=headers, timeout=15)
        if r.status_code == 200: return r.content
    except Exception: pass
    return None

async def stitch_tiles(bounds, zoom, job_id, url_tpl, use_rapidapi=False, use_mapbox=False, use_thunderforest=False):
    x0,y0 = deg2num(bounds["max_lat"],bounds["min_lon"],zoom)
    x1,y1 = deg2num(bounds["min_lat"],bounds["max_lon"],zoom)
    x0-=1; y0-=1; x1+=1; y1+=1
    tw = TILE_SIZE_HI if (use_rapidapi or use_mapbox) else TILE_SIZE_STD
    canvas = Image.new("RGB", ((x1-x0+1)*tw,(y1-y0+1)*tw), (240,240,240))
    coords = [(tx,ty) for ty in range(y0,y1+1) for tx in range(x0,x1+1)]
    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(*[fetch_tile(client,zoom,tx,ty,url_tpl,use_rapidapi,use_mapbox,use_thunderforest) for tx,ty in coords])
    for (tx,ty),tb in zip(coords,results):
        if tb:
            from io import BytesIO
            ti = Image.open(BytesIO(tb)).convert("RGB")
            if ti.size != (tw,tw): ti = ti.resize((tw,tw),Image.LANCZOS)
            canvas.paste(ti,((tx-x0)*tw,(ty-y0)*tw))
    img_path = str(TEMP_DIR/f"{job_id}_map.png")
    canvas.save(img_path)
    top_lat,left_lon = num2deg(x0,y0,zoom)
    bot_lat,right_lon = num2deg(x1+1,y1+1,zoom)
    return img_path, left_lon, top_lat, right_lon, bot_lat

# ── Drawing helpers ──────────────────────────────────────────────────────────

def hex_to_rgba(h, alpha=220):
    h = h.lstrip('#')
    try: r,g,b = int(h[0:2],16),int(h[2:4],16),int(h[4:6],16)
    except: r,g,b = 255,60,60
    return (r,g,b,alpha)

def to_px(lat, lon, left_lon, top_lat, right_lon, bot_lat, w, h):
    return int((lon-left_lon)/(right_lon-left_lon)*w), int((top_lat-lat)/(top_lat-bot_lat)*h)

def draw_tracks(img_path, tracks_data, left_lon, top_lat, right_lon, bot_lat, out_path):
    from PIL import ImageDraw
    img = Image.open(img_path).convert("RGBA")
    w, h = img.size
    overlay = Image.new("RGBA",(w,h),(0,0,0,0))
    draw = ImageDraw.Draw(overlay)
    for track in tracks_data:
        pts = track["points"]
        color = hex_to_rgba(track["color"])
        px_pts = [to_px(lat,lon,left_lon,top_lat,right_lon,bot_lat,w,h) for lat,lon in pts]
        for i in range(len(px_pts)-1):
            draw.line([px_pts[i],px_pts[i+1]], fill=color, width=6)
        if px_pts:
            sx,sy = px_pts[0]
            draw.ellipse([sx-9,sy-9,sx+9,sy+9], fill=hex_to_rgba(track["color"],255), outline=(255,255,255,255), width=2)
            ex,ey = px_pts[-1]
            draw.ellipse([ex-9,ey-9,ex+9,ey+9], fill=(220,50,50,255), outline=(255,255,255,255), width=2)
    Image.alpha_composite(img,overlay).convert("RGB").save(out_path)

def _hex(color: str):
    """Parse '#rrggbb' → (r,g,b)."""
    h = color.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def _draw_circle_badge(d, cx, cy, r, fill_rgb, alpha=230):
    """Draw a filled circle with white border."""
    d.ellipse([cx-r, cy-r, cx+r, cy+r], fill=fill_rgb+(alpha,))
    for t in range(3):
        d.ellipse([cx-r+t, cy-r+t, cx+r-t, cy+r-t],
                  fill=None, outline=(255,255,255, 200-t*30), width=1)

def _render_icon_pil(icon_id: str, size: int = 48) -> "Image":
    """
    Pure-PIL icon renderer — zero external dependencies.
    Draws a coloured circular badge with a recognisable white pictogram
    for each of the 25 icon types used in the frontend.
    """
    from PIL import ImageDraw, ImageFont
    import math

    # (bg_hex, draw_fn)  — draw_fn(d, cx, cy, r) draws white shapes at 2× scale
    S = size * 2          # work at 2× for anti-alias quality, then downscale
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d   = ImageDraw.Draw(img)
    cx = cy = S // 2
    br  = S // 2 - 2      # badge radius

    COLORS = {
        "camp":    "#2e7d32", "peak":    "#1565c0", "tent":    "#558b2f",
        "flag":    "#c62828", "warn":    "#f57f17", "water":   "#0277bd",
        "food":    "#6d4c41", "parking": "#1565c0", "medic":   "#c62828",
        "photo":   "#455a64", "fuel":    "#e65100", "fire":    "#e64a19",
        "rest":    "#795548", "view":    "#00695c", "bridge":  "#4a148c",
        "river":   "#0277bd", "cave":    "#311b92", "village": "#5d4037",
        "mosque":  "#1b5e20", "sos":     "#c62828", "star":    "#f9a825",
        "pin":     "#e53935", "compass": "#01579b", "tree":    "#2e7d32",
    }
    bg_hex = COLORS.get(icon_id, "#e53935")
    bg_rgb = _hex(bg_hex)

    # ── Badge background ────────────────────────────────────────────────────
    _draw_circle_badge(d, cx, cy, br, bg_rgb, 240)

    # ── White pictogram ─────────────────────────────────────────────────────
    W  = (255, 255, 255, 255)
    W2 = (255, 255, 255, 210)
    p  = S // 8          # padding from edge of badge

    def poly(*pts, fill=W): d.polygon(list(pts), fill=fill)
    def rect(x0,y0,x1,y1, fill=W, r=0):
        if r: d.rounded_rectangle([x0,y0,x1,y1], radius=r, fill=fill)
        else: d.rectangle([x0,y0,x1,y1], fill=fill)
    def circ(x,y,r2, fill=W): d.ellipse([x-r2,y-r2,x+r2,y+r2], fill=fill)
    def line(pts, width=S//14, fill=W): d.line(pts, fill=fill, width=width)
    lw = S // 14   # standard line width

    x0, y0, x1, y1 = cx-br+p, cy-br+p, cx+br-p, cy+br-p  # inner box

    if icon_id == "camp":
        # tent triangle + pole
        mx = cx
        poly((mx,y0+S//10),(x1,y1),(x0,y1))
        rect(mx-S//18, y1-S//5, mx+S//18, y1+S//14)

    elif icon_id == "peak":
        # mountain double-peak
        poly((cx-S//7,y1),(cx,y0+S//8),(cx+S//5,y1))
        poly((cx-S//5,y1),(cx-S//8,y0+S//5),(cx+S//8,y1), fill=W2)

    elif icon_id == "tent":
        # tent A-shape with door
        poly((cx,y0+S//10),(x1,y1),(x0,y1))
        rect(cx-S//10, cy+S//16, cx+S//10, y1, fill=bg_rgb+(255,))

    elif icon_id == "flag":
        # flagpole + triangle flag
        rect(cx-S//22, y0, cx+S//22, y1)
        poly((cx+S//22,y0),(cx+S//22+S//5,y0+S//7),(cx+S//22,y0+S//4+S//20))

    elif icon_id == "warn":
        # triangle warning
        poly((cx,y0+S//12),(x1-S//16,y1),(x0+S//16,y1))
        rect(cx-S//18, cy-S//14, cx+S//18, cy+S//8, fill=bg_rgb+(255,))
        circ(cx, y1-S//10, S//14, fill=bg_rgb+(255,))

    elif icon_id == "water":
        # water droplet
        d.pieslice([cx-S//5, cy-S//14, cx+S//5, cy+S//4], 0, 360, fill=W)
        poly((cx,y0+S//10),(cx-S//5,cy-S//10),(cx+S//5,cy-S//10))

    elif icon_id == "food":
        # fork + knife
        rect(cx-S//5, y0, cx-S//5+S//16, y1)
        circ(cx-S//5+S//32, y0+S//8, S//8)
        rect(cx+S//10, y0, cx+S//10+S//16, y1)

    elif icon_id == "parking":
        # P letter in rounded square
        rect(x0+S//12,y0+S//12,x1-S//12,y1-S//12, fill=W, r=S//10)
        rect(cx-S//8,y0+S//6,cx-S//8+S//12,y1-S//6, fill=bg_rgb+(255,))
        d.arc([cx-S//8,y0+S//6,cx+S//8,cy+S//16], -90, 90, fill=bg_rgb+(255,), width=S//14)

    elif icon_id == "medic":
        # red-cross (white cross on badge)
        rect(cx-S//16, y0+S//10, cx+S//16, y1-S//10)
        rect(x0+S//10, cy-S//16, x1-S//10, cy+S//16)

    elif icon_id == "photo":
        # camera body + lens
        rect(x0+S//16, cy-S//8, x1-S//16, y1-S//14, r=S//14)
        rect(cx-S//7, cy-S//5, cx+S//7, cy-S//8+S//22)  # viewfinder bump
        circ(cx, cy+S//16, S//6, fill=bg_rgb+(255,))
        circ(cx, cy+S//16, S//10)

    elif icon_id == "fuel":
        # fuel pump shape
        rect(cx-S//5, y0+S//8, cx+S//14, y1)
        rect(cx-S//5+S//14, cy-S//14, cx+S//14, cy+S//14, fill=bg_rgb+(255,))
        rect(cx+S//14, cy-S//5, cx+S//5, cy+S//8, r=S//16)

    elif icon_id == "fire":
        # flame shape using polygon
        poly((cx,y0+S//10),(cx+S//5,cy),(cx+S//8,cy-S//10),
             (cx+S//6,cy+S//5),(cx,y1),(cx-S//6,cy+S//5),
             (cx-S//8,cy-S//10),(cx-S//5,cy))

    elif icon_id == "rest":
        # bench: seat + two legs
        rect(x0, cy-S//16, x1, cy+S//16)           # seat
        rect(x0, cy+S//16, x0+S//10, y1)            # leg L
        rect(x1-S//10, cy+S//16, x1, y1)            # leg R
        rect(x0, y0+S//6, x1, y0+S//6+S//12)        # backrest

    elif icon_id == "view":
        # telescope / binoculars circles
        circ(cx-S//7, cy, S//6)
        circ(cx+S//7, cy, S//6)
        rect(cx-S//22, cy-S//22, cx+S//22, cy+S//22, fill=W)
        line([(cx, cy-S//6),(cx, y0+S//10)])

    elif icon_id == "bridge":
        # arch bridge
        line([(x0,cy),(x1,cy)], width=lw)
        line([(x0,cy),(x0,y1)], width=lw)
        line([(x1,cy),(x1,y1)], width=lw)
        d.arc([x0,y0,x1,cy+S//8], 180, 0, fill=W, width=lw)
        # pillars
        line([(cx-S//8,cy),(cx-S//8,cy+S//6)], width=lw//2)
        line([(cx+S//8,cy),(cx+S//8,cy+S//6)], width=lw//2)

    elif icon_id == "river":
        # two wavy lines
        for dy in (-S//10, S//10):
            pts = []
            for i in range(9):
                t = i / 8
                px2 = int(x0 + (x1-x0)*t)
                py2 = int(cy + dy + (S//10)*math.sin(t*math.pi*2))
                pts.append((px2, py2))
            d.line(pts, fill=W, width=lw)

    elif icon_id == "cave":
        # arch opening
        d.arc([x0+S//12, y0+S//8, x1-S//12, cy+S//6], 180, 0, fill=W, width=lw*2)
        line([(x0+S//12,cy+S//14),(x0+S//12,y1)], width=lw*2)
        line([(x1-S//12,cy+S//14),(x1-S//12,y1)], width=lw*2)

    elif icon_id == "village":
        # two houses
        for hx2, col in [(cx-S//7, W), (cx+S//7, W2)]:
            hw = S//7
            poly((hx2-hw,cy+S//10),(hx2,cy-S//10),(hx2+hw,cy+S//10), fill=col)
            rect(hx2-hw, cy+S//10, hx2+hw, y1, fill=col)

    elif icon_id == "mosque":
        # dome + minaret
        rect(cx-S//5, cy, cx+S//5, y1, r=0)
        d.arc([cx-S//5, cy-S//5, cx+S//5, cy+S//10], 180, 0, fill=W, width=0)
        d.pieslice([cx-S//5, cy-S//5, cx+S//5, cy+S//10], 180, 360, fill=W)
        rect(cx+S//5, cy-S//8, cx+S//5+S//14, y1)    # minaret

    elif icon_id == "sos":
        # SOS text in rounded box
        rect(x0+S//16,y0+S//8,x1-S//16,y1-S//8, fill=W, r=S//12)
        try:
            fnt = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", S//5)
        except:
            fnt = ImageFont.load_default()
        bb = d.textbbox((0,0),"SOS",font=fnt)
        tx = cx-(bb[2]-bb[0])//2; ty = cy-(bb[3]-bb[1])//2+S//18
        d.text((tx,ty),"SOS",fill=bg_rgb+(255,),font=fnt)

    elif icon_id == "star":
        # 5-pointed star
        pts = []
        for i in range(10):
            angle = math.pi/2 + i*math.pi/5
            r2 = br-p if i%2==0 else (br-p)//2
            pts.append((cx + int(r2*math.cos(angle)), cy + int(r2*math.sin(angle))))
        d.polygon(pts, fill=W)

    elif icon_id == "pin":
        # map pin drop shape
        d.pieslice([cx-S//5, y0+S//10, cx+S//5, cy+S//8], 180, 360, fill=W)
        d.pieslice([cx-S//5, y0+S//10, cx+S//5, cy+S//8], 0, 180, fill=W)
        poly((cx-S//5,cy),(cx,y1),(cx+S//5,cy))
        circ(cx, cy-S//16, S//10, fill=bg_rgb+(255,))

    elif icon_id == "compass":
        # compass rose
        circ(cx, cy, S//5, fill=(0,0,0,0))
        d.arc([cx-S//5,cy-S//5,cx+S//5,cy+S//5], 0, 360, fill=W, width=lw//2)
        # N arrow (white)
        poly((cx,y0+S//6),(cx-S//14,cy),(cx+S//14,cy))
        # S arrow (dimmer)
        poly((cx,y1-S//6),(cx-S//14,cy),(cx+S//14,cy), fill=W2)

    elif icon_id == "tree":
        # pine tree: three stacked triangles + trunk
        for i,(ty2,tw2) in enumerate([(y0+S//12,S//7),(y0+S//5,S//5),(cy-S//18,S//4)]):
            poly((cx,ty2),(cx-tw2,ty2+S//5+i*S//28),(cx+tw2,ty2+S//5+i*S//28))
        rect(cx-S//16, cy+S//7, cx+S//16, y1)

    else:
        # fallback: simple dot
        circ(cx, cy, S//4)

    # ── Downscale 2× → final size (smooth anti-alias) ───────────────────────
    return img.resize((size, size), Image.LANCZOS)


def draw_annotations(img_path, annotations, left_lon, top_lat, right_lon, bot_lat, out_path):
    """Draw pins (dengan icon SVG) dan text labels ke map image."""
    try:
        from PIL import ImageDraw, ImageFont
    except: return

    img = Image.open(img_path).convert("RGBA")
    w, h = img.size
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    try:
        font_label = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 20)
        font_small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 15)
    except:
        font_label = ImageFont.load_default()
        font_small = font_label

    ICON_SIZE = 42  # pixel size of rendered icon badge

    for ann in annotations:
        px, py = to_px(ann["lat"], ann["lon"], left_lon, top_lat, right_lon, bot_lat, w, h)
        px, py = int(px), int(py)

        if ann["type"] == "text":
            text = ann.get("text", "")
            bbox = draw.textbbox((0, 0), text, font=font_label)
            tw2 = bbox[2] - bbox[0]; th2 = bbox[3] - bbox[1]
            pad = 6
            draw.rounded_rectangle(
                [px - pad, py - th2 - pad, px + tw2 + pad, py + pad],
                radius=5, fill=(0, 0, 0, 185)
            )
            draw.text((px, py - th2), text, fill=(255, 255, 255, 255), font=font_label)

        else:
            # Render icon badge — pure PIL, no external dependencies
            icon_id = ann.get("icon_id", ann.get("icon_emoji", "pin"))
            label   = ann.get("icon_label", "")

            icon_img = _render_icon_pil(icon_id, size=ICON_SIZE)

            # Paste icon centered above the point (anchor = bottom-center)
            ix = px - ICON_SIZE // 2
            iy = py - ICON_SIZE

            # Clamp to image bounds — crop icon if it extends beyond edge
            src_x0, src_y0 = 0, 0
            dst_x0, dst_y0 = ix, iy
            iw, ih = icon_img.size

            if dst_x0 < 0: src_x0 = -dst_x0; iw -= src_x0; dst_x0 = 0
            if dst_y0 < 0: src_y0 = -dst_y0; ih -= src_y0; dst_y0 = 0
            iw = min(iw, w - dst_x0)
            ih = min(ih, h - dst_y0)

            if iw > 0 and ih > 0:
                crop = icon_img.crop((src_x0, src_y0, src_x0+iw, src_y0+ih))
                overlay.paste(crop, (dst_x0, dst_y0), crop)

            # Small anchor dot at exact coordinate
            draw.ellipse([px-4, py-4, px+4, py+4], fill=(0, 0, 0, 100))

            # Label below icon with background box
            if label:
                bbox = draw.textbbox((0, 0), label, font=font_small)
                lw2 = bbox[2] - bbox[0]; lh2 = bbox[3] - bbox[1]
                pad = 4
                lx = max(pad, min(px - lw2//2, w - lw2 - pad*2))
                ly = py + 4
                draw.rounded_rectangle(
                    [lx - pad, ly - 1, lx + lw2 + pad, ly + lh2 + pad],
                    radius=3, fill=(0, 0, 0, 165)
                )
                draw.text((lx, ly), label, fill=(255, 255, 255, 235), font=font_small)

    result = Image.alpha_composite(img, overlay).convert("RGB")
    result.save(out_path)

# ── GeoPDF helpers ───────────────────────────────────────────────────────────

def create_geopdf(img_path, left_lon, top_lat, right_lon, bot_lat, out_path):
    import subprocess
    w,h = Image.open(img_path).size
    gcps = [f"-gcp 0 0 {left_lon} {top_lat}", f"-gcp {w} 0 {right_lon} {top_lat}",
            f"-gcp {w} {h} {right_lon} {bot_lat}", f"-gcp 0 {h} {left_lon} {bot_lat}"]
    georef = out_path.replace(".pdf","_georef.tif")
    subprocess.run(f"gdal_translate -of GTiff {' '.join(gcps)} -a_srs EPSG:4326 {img_path} {georef}", shell=True, check=True)
    subprocess.run(f"gdal_translate -of PDF -co GEO_ENCODING=OGC {georef} {out_path}", shell=True, check=True)
    try: os.remove(georef)
    except: pass

def create_geopdf_fit(img_path, left_lon, top_lat, right_lon, bot_lat, pw_mm, ph_mm, out_path):
    import subprocess
    from PIL import ImageDraw
    dpi = DPI_DEFAULT
    pw_px=int(pw_mm/25.4*dpi); ph_px=int(ph_mm/25.4*dpi)
    m=int(8/25.4*dpi); fp=int(10/25.4*dpi)
    mw,mh = Image.open(img_path).size
    avw=pw_px-2*m; avh=ph_px-2*m-fp
    sc=min(avw/mw,avh/mh)
    nw,nh=int(mw*sc),int(mh*sc)
    canvas=Image.new("RGB",(pw_px,ph_px),(255,255,255))
    xo=m+(avw-nw)//2; yo=m
    canvas.paste(Image.open(img_path).convert("RGB").resize((nw,nh),Image.LANCZOS),(xo,yo))
    draw=ImageDraw.Draw(canvas)
    draw.rectangle([xo-1,yo-1,xo+nw,yo+nh],outline=(180,180,180),width=1)
    draw.text((m,yo+nh+int(3/25.4*dpi)),"Generated by TrailMap  •  © OpenStreetMap contributors",fill=(140,140,140))
    tmp=out_path.replace(".pdf","_gf_canvas.png")
    canvas.save(tmp,dpi=(dpi,dpi))
    gcps=[f"-gcp {xo} {yo} {left_lon} {top_lat}",f"-gcp {xo+nw} {yo} {right_lon} {top_lat}",
          f"-gcp {xo+nw} {yo+nh} {right_lon} {bot_lat}",f"-gcp {xo} {yo+nh} {left_lon} {bot_lat}"]
    georef=out_path.replace(".pdf","_gf_georef.tif")
    subprocess.run(f"gdal_translate -of GTiff {' '.join(gcps)} -a_srs EPSG:4326 {tmp} {georef}",shell=True,check=True)
    subprocess.run(f"gdal_translate -of PDF -co GEO_ENCODING=OGC {georef} {out_path}",shell=True,check=True)
    for p in [tmp,georef]:
        try: os.remove(p)
        except: pass

def create_print_pdf(img_path, pw_mm, ph_mm, out_path):
    import subprocess
    from PIL import ImageDraw
    dpi=DPI_DEFAULT
    pw_px=int(pw_mm/25.4*dpi); ph_px=int(ph_mm/25.4*dpi)
    m=int(10/25.4*dpi); fp=int(12/25.4*dpi)
    mw,mh=Image.open(img_path).size
    avw=pw_px-2*m; avh=ph_px-2*m-fp
    sc=min(avw/mw,avh/mh)
    nw,nh=int(mw*sc),int(mh*sc)
    canvas=Image.new("RGB",(pw_px,ph_px),(255,255,255))
    xo=m+(avw-nw)//2; yo=m
    canvas.paste(Image.open(img_path).convert("RGB").resize((nw,nh),Image.LANCZOS),(xo,yo))
    draw=ImageDraw.Draw(canvas)
    draw.rectangle([xo-1,yo-1,xo+nw,yo+nh],outline=(180,180,180),width=1)
    draw.text((m,yo+nh+int(4/25.4*dpi)),"Generated by TrailMap  •  © OpenStreetMap contributors",fill=(140,140,140))
    tmp=out_path.replace(".pdf","_pr_canvas.png")
    canvas.save(tmp,dpi=(dpi,dpi))
    subprocess.run(f"gdal_translate -of PDF {tmp} {out_path}",shell=True,check=True)
    try: os.remove(tmp)
    except: pass

# ── Common pipeline ──────────────────────────────────────────────────────────

async def build_map_image(files, track_colors, basemap_id, annotations_json, job_id, tf_key=""):
    """Parse all GPX, stitch tiles, draw tracks + annotations. Returns (img_path, geo_bounds)."""
    gpx_list = []
    tracks_data = []
    colors = track_colors if isinstance(track_colors, list) else [track_colors]

    for i, f in enumerate(files):
        content = await f.read()
        gpx = parse_gpx(content)
        gpx_list.append(gpx)
        color = colors[i] if i < len(colors) else "#ff3c3c"
        tracks_data.append({"points": gpx["points"], "color": color})

    bounds = merge_bounds(gpx_list)
    zoom = choose_zoom(bounds["min_lat"], bounds["max_lat"], bounds["min_lon"], bounds["max_lon"])

    # Resolve tile source — prefer client-supplied TF key, fall back to server env
    effective_tf_key = tf_key or THUNDERFOREST_KEY
    use_rapidapi = False; use_mapbox = False; use_thunderforest = False; url_tpl = ""
    if basemap_id == "mapbox-outdoor" and MAPBOX_TOKEN:
        use_mapbox = True
    elif basemap_id == "osm" and RAPIDAPI_KEY:
        use_rapidapi = True
    elif basemap_id == "tf-outdoors" and effective_tf_key:
        url_tpl = f"https://{{s}}.tile.thunderforest.com/outdoors/{{z}}/{{x}}/{{y}}.png?apikey={effective_tf_key}"
        use_thunderforest = True
    else:
        url_tpl, _ = BASEMAP_URLS.get(basemap_id, BASEMAP_URLS["osm"])

    img_path, left_lon, top_lat, right_lon, bot_lat = await stitch_tiles(
        bounds, zoom, job_id, url_tpl, use_rapidapi, use_mapbox, use_thunderforest
    )

    # Draw tracks
    tracked = str(TEMP_DIR/f"{job_id}_tracked.png")
    draw_tracks(img_path, tracks_data, left_lon, top_lat, right_lon, bot_lat, tracked)
    try: os.remove(img_path)
    except: pass

    # Draw annotations
    annotations = []
    try: annotations = json.loads(annotations_json) if annotations_json else []
    except: pass

    if annotations:
        ann_out = str(TEMP_DIR/f"{job_id}_ann.png")
        # Normalize annotation format from frontend
        normalized = []
        for a in annotations:
            norm = {"type": a.get("type","pin"), "lat": float(a["lat"]), "lon": float(a["lon"])}
            if a.get("type") == "text":
                norm["text"] = a.get("text","")
            else:
                icon = a.get("icon", {})
                norm["icon_id"]    = icon.get("id","pin") if isinstance(icon, dict) else "pin"
                norm["icon_emoji"] = icon.get("emoji","📍") if isinstance(icon, dict) else "📍"
                norm["icon_label"] = icon.get("label","") if isinstance(icon, dict) else ""
            normalized.append(norm)
        draw_annotations(tracked, normalized, left_lon, top_lat, right_lon, bot_lat, ann_out)
        try: os.remove(tracked)
        except: pass
        tracked = ann_out

    return tracked, left_lon, top_lat, right_lon, bot_lat

# ── API endpoints ────────────────────────────────────────────────────────────

@app.get("/api/config")
def get_config():
    return JSONResponse({
        "mapbox_token": MAPBOX_TOKEN if MAPBOX_TOKEN else "",
        "thunderforest_key": THUNDERFOREST_KEY if THUNDERFOREST_KEY else "",
    })

@app.post("/api/generate")
async def generate_geopdf(
    files: List[UploadFile] = File(...),
    track_colors: List[str] = Form(...),
    basemap_id: str = Form("osm"),
    annotations: str = Form("[]"),
    thunderforest_key: str = Form(""),
):
    import uuid; job_id = str(uuid.uuid4())[:8]
    try:
        img_path, left_lon, top_lat, right_lon, bot_lat = await build_map_image(files, track_colors, basemap_id, annotations, job_id, thunderforest_key)
    except Exception as e:
        raise HTTPException(500, str(e))
    pdf = str(TEMP_DIR/f"{job_id}_geo.pdf")
    try: create_geopdf(img_path, left_lon, top_lat, right_lon, bot_lat, pdf)
    except Exception as e: raise HTTPException(500, f"GeoPDF error: {e}")
    try: os.remove(img_path)
    except: pass
    return FileResponse(pdf, media_type="application/pdf", filename="trail_avenza.pdf")

@app.post("/api/generate-geofit")
async def generate_geofit(
    files: List[UploadFile] = File(...),
    track_colors: List[str] = Form(...),
    basemap_id: str = Form("osm"),
    annotations: str = Form("[]"),
    paper_size: str = Form("a4p"),
    thunderforest_key: str = Form(""),
):
    import uuid; job_id = str(uuid.uuid4())[:8]
    try:
        img_path, left_lon, top_lat, right_lon, bot_lat = await build_map_image(files, track_colors, basemap_id, annotations, job_id, thunderforest_key)
    except Exception as e:
        raise HTTPException(500, str(e))
    pw,ph = PAPER_SIZES_MM.get(paper_size,(210,297))
    pdf = str(TEMP_DIR/f"{job_id}_geofit.pdf")
    try: create_geopdf_fit(img_path, left_lon, top_lat, right_lon, bot_lat, pw, ph, pdf)
    except Exception as e: raise HTTPException(500, f"GeoPDF fit error: {e}")
    try: os.remove(img_path)
    except: pass
    return FileResponse(pdf, media_type="application/pdf", filename=f"trail_avenza_{paper_size}.pdf")

@app.post("/api/generate-print")
async def generate_print(
    files: List[UploadFile] = File(...),
    track_colors: List[str] = Form(...),
    basemap_id: str = Form("osm"),
    annotations: str = Form("[]"),
    paper_size: str = Form("a4p"),
    thunderforest_key: str = Form(""),
):
    import uuid; job_id = str(uuid.uuid4())[:8]
    try:
        img_path, _, _, _, _ = await build_map_image(files, track_colors, basemap_id, annotations, job_id, thunderforest_key)
    except Exception as e:
        raise HTTPException(500, str(e))
    pw,ph = PAPER_SIZES_MM.get(paper_size,(210,297))
    pdf = str(TEMP_DIR/f"{job_id}_print.pdf")
    try: create_print_pdf(img_path, pw, ph, pdf)
    except Exception as e: raise HTTPException(500, f"Print PDF error: {e}")
    try: os.remove(img_path)
    except: pass
    return FileResponse(pdf, media_type="application/pdf", filename=f"trail_{paper_size}.pdf")

# ── Static frontend ──────────────────────────────────────────────────────────
frontend_dist = Path("/app/frontend/dist")
if frontend_dist.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dist), html=True), name="static")
