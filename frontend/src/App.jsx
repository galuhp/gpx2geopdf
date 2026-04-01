import { useState, useCallback, useRef, useEffect } from 'react'
import { MapContainer, TileLayer, Polyline, Marker, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'

delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

const BASEMAPS = [
  { id: 'osm',            label: 'OSM Standard',     desc: 'Peta umum OpenStreetMap',        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',                attribution: '&copy; OpenStreetMap', maxZoom: 19 },
  { id: 'topo',           label: 'OpenTopoMap',       desc: 'Kontur + elevasi, cocok hiking', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',                   attribution: '&copy; OpenTopoMap',   maxZoom: 17 },
  { id: 'cyclosm',        label: 'CyclOSM',           desc: 'Detail trail + kontur, gratis',  url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', attribution: '&copy; CyclOSM',       maxZoom: 20 },
  { id: 'humanitarian',   label: 'OSM Humanitarian',  desc: 'Teks besar, terbaca lapangan',   url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',              attribution: '&copy; OpenStreetMap', maxZoom: 19 },
  { id: 'mapbox-outdoor', label: 'Mapbox Outdoor',    desc: 'Kontur detail + terrain Mapbox', url: null, attribution: '&copy; Mapbox', maxZoom: 22, requiresToken: true },
]

const TRACK_COLORS = [
  { id: 'red',    label: 'Merah',  hex: '#ff3c3c' },
  { id: 'orange', label: 'Oranye', hex: '#ff8c00' },
  { id: 'yellow', label: 'Kuning', hex: '#f5c400' },
  { id: 'green',  label: 'Hijau',  hex: '#00c853' },
  { id: 'cyan',   label: 'Cyan',   hex: '#00bcd4' },
  { id: 'blue',   label: 'Biru',   hex: '#2979ff' },
  { id: 'purple', label: 'Ungu',   hex: '#9c27b0' },
  { id: 'pink',   label: 'Pink',   hex: '#f06292' },
  { id: 'white',  label: 'Putih',  hex: '#ffffff' },
  { id: 'black',  label: 'Hitam',  hex: '#222222' },
]

const PAPER_SIZES = [
  { id: 'a4p',  label: 'A4',     sub: 'Portrait',   dim: '210×297mm' },
  { id: 'a4l',  label: 'A4',     sub: 'Landscape',  dim: '297×210mm' },
  { id: 'a3p',  label: 'A3',     sub: 'Portrait',   dim: '297×420mm' },
  { id: 'a3l',  label: 'A3',     sub: 'Landscape',  dim: '420×297mm' },
  { id: 'a5p',  label: 'A5',     sub: 'Portrait',   dim: '148×210mm' },
  { id: 'ltr',  label: 'Letter', sub: 'Portrait',   dim: '216×279mm' },
]

function makeMarkerIcon(color) {
  return new L.DivIcon({
    html: `<div style="width:14px;height:14px;background:${color};border:2px solid #fff;border-radius:50%;box-shadow:0 0 6px ${color}99"></div>`,
    iconSize: [14, 14], iconAnchor: [7, 7], className: ''
  })
}

function FitBounds({ points }) {
  const map = useMap()
  if (points.length > 0) map.fitBounds(L.latLngBounds(points), { padding: [40, 40] })
  return null
}

function parseGPX(text) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(text, 'application/xml')
  const ns = 'http://www.topografix.com/GPX/1/1'
  const trkpts = doc.getElementsByTagNameNS(ns, 'trkpt')
  const points = []
  for (const pt of trkpts) points.push([parseFloat(pt.getAttribute('lat')), parseFloat(pt.getAttribute('lon'))])
  return points
}

function haversine(p1, p2) {
  const R = 6371, dLat = (p2[0]-p1[0])*Math.PI/180, dLon = (p2[1]-p1[1])*Math.PI/180
  const a = Math.sin(dLat/2)**2 + Math.cos(p1[0]*Math.PI/180)*Math.cos(p2[0]*Math.PI/180)*Math.sin(dLon/2)**2
  return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

function PaperPicker({ value, onChange }) {
  return (
    <div className="paper-grid">
      {PAPER_SIZES.map(ps => (
        <button key={ps.id} className={`paper-item ${value.id===ps.id?'active':''}`} onClick={() => onChange(ps)}>
          <div className="paper-label">{ps.label}</div>
          <div className="paper-sub">{ps.sub}</div>
          <div className="paper-dim">{ps.dim}</div>
        </button>
      ))}
    </div>
  )
}

export default function App() {
  const [gpxFile, setGpxFile]     = useState(null)
  const [gpxName, setGpxName]     = useState('')
  const [points, setPoints]       = useState([])
  const [stats, setStats]         = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const [trackColor, setTrackColor] = useState(TRACK_COLORS[0])
  const [basemap, setBasemap]     = useState(BASEMAPS[0])
  const [mapboxToken, setMapboxToken] = useState('')
  const [paperGeo, setPaperGeo]   = useState(PAPER_SIZES[0])   // for geo-fit
  const [paperPrint, setPaperPrint] = useState(PAPER_SIZES[0]) // for print
  const [error, setError]         = useState('')

  // per-button status
  const [stGeo, setStGeo]         = useState('idle')  // GeoPDF standard
  const [stGeoFit, setStGeoFit]   = useState('idle')  // GeoPDF fit kertas
  const [stPrint, setStPrint]     = useState('idle')  // PDF biasa

  const fileInputRef = useRef()

  // Fetch Mapbox token dari server untuk Leaflet preview
  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(d => { if (d.mapbox_token) setMapboxToken(d.mapbox_token) })
      .catch(() => {})
  }, [])

  const handleFile = useCallback((file) => {
    if (!file || !file.name.endsWith('.gpx')) { setError('File harus berformat .gpx'); return }
    setError(''); setGpxFile(file); setGpxName(file.name.replace('.gpx', ''))
    const reader = new FileReader()
    reader.onload = (e) => {
      const pts = parseGPX(e.target.result); setPoints(pts)
      let dist = 0
      for (let i = 1; i < pts.length; i++) dist += haversine(pts[i-1], pts[i])
      const lats = pts.map(p=>p[0]), lons = pts.map(p=>p[1])
      setStats({ points: pts.length, distance: dist.toFixed(2) })
      setStGeo('idle'); setStGeoFit('idle'); setStPrint('idle')
    }
    reader.readAsText(file)
  }, [])

  const onDrop = useCallback((e) => { e.preventDefault(); setIsDragging(false); handleFile(e.dataTransfer.files[0]) }, [handleFile])

  const doExport = async ({ endpoint, filename, extraFields = {}, setStatus }) => {
    setStatus('generating'); setError('')
    const form = new FormData()
    form.append('file', gpxFile)
    form.append('track_color', trackColor.hex)
    form.append('basemap_id', basemap.id)
    Object.entries(extraFields).forEach(([k,v]) => form.append(k, v))
    try {
      const res = await fetch(endpoint, { method: 'POST', body: form })
      if (!res.ok) { const err = await res.json(); throw new Error(err.detail || 'Server error') }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
      URL.revokeObjectURL(url)
      setStatus('done')
    } catch (err) { setError(err.message); setStatus('error') }
  }

  const reset = () => {
    setGpxFile(null); setGpxName(''); setPoints([]); setStats(null)
    setStGeo('idle'); setStGeoFit('idle'); setStPrint('idle'); setError('')
  }

  const ExportBtn = ({ status, label, doneLabel = '✓ Download Again', onClick, color = 'geo' }) => (
    <button className={`btn-export ${color} ${status==='generating'?'loading':''}`} onClick={onClick} disabled={status==='generating'}>
      {status==='generating' ? <><span className="spinner"></span> Generating…</> : status==='done' ? doneLabel : label}
    </button>
  )

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">⛰</span>
            <div>
              <div className="logo-title">TrailMap</div>
              <div className="logo-sub">GPX → PDF / GeoPDF for Avenza</div>
            </div>
          </div>
          {gpxFile && <button className="btn-ghost" onClick={reset}>← New File</button>}
        </div>
      </header>

      <main className="main">
        {!gpxFile ? (
          <div className="drop-zone-wrap">
            <div className={`drop-zone ${isDragging?'dragging':''}`}
              onDrop={onDrop}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
              onDragLeave={() => setIsDragging(false)}
              onClick={() => fileInputRef.current.click()}
            >
              <div className="drop-icon">
                <svg width="56" height="56" viewBox="0 0 64 64" fill="none">
                  <path d="M32 8 L32 40 M20 28 L32 40 L44 28" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M12 48 L12 56 L52 56 L52 48" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
                </svg>
              </div>
              <div className="drop-title">Drop your GPX file here</div>
              <div className="drop-sub">or click to browse</div>
              <div className="drop-hint">.gpx files only — Strava, Garmin, Komoot, dll.</div>
              <input ref={fileInputRef} type="file" accept=".gpx" style={{display:'none'}} onChange={e => handleFile(e.target.files[0])} />
            </div>
            {error && <div className="error-msg">{error}</div>}
            <div className="how-it-works">
              <div className="hiw-title">How it works</div>
              <div className="hiw-steps">
                <div className="hiw-step"><span className="hiw-num">1</span><span>Import GPX dari Strava atau sumber lain</span></div>
                <div className="hiw-step"><span className="hiw-num">2</span><span>Pilih warna, basemap & format export</span></div>
                <div className="hiw-step"><span className="hiw-num">3</span><span>Export GeoPDF (Avenza) atau PDF biasa (print)</span></div>
              </div>
            </div>
          </div>
        ) : (
          <div className="workspace">
            {/* Map */}
            <div className="map-wrap">
              <MapContainer center={points[0]||[-7.5,110.4]} zoom={13} style={{width:'100%',height:'100%'}}>
                <TileLayer
                  key={basemap.id + mapboxToken}
                  url={
                    basemap.id === 'mapbox-outdoor' && mapboxToken
                      ? `https://api.mapbox.com/styles/v1/mapbox/outdoors-v12/tiles/512/{z}/{x}/{y}@2x?access_token=${mapboxToken}`
                      : basemap.id === 'mapbox-outdoor'
                        ? 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
                        : basemap.url
                  }
                  attribution={basemap.attribution}
                  maxZoom={basemap.maxZoom}
                  tileSize={basemap.id === 'mapbox-outdoor' && mapboxToken ? 512 : 256}
                  zoomOffset={basemap.id === 'mapbox-outdoor' && mapboxToken ? -1 : 0}
                />
                {points.length > 0 && <>
                  <Polyline positions={points} color={trackColor.hex} weight={4} opacity={0.95} />
                  <Marker position={points[0]} icon={makeMarkerIcon(trackColor.hex)} />
                  <Marker position={points[points.length-1]} icon={makeMarkerIcon('#ff3d3d')} />
                  <FitBounds points={points} />
                </>}
              </MapContainer>
              <div className="map-legend">
                <div className="legend-item"><span className="dot" style={{background:trackColor.hex}}></span> Start</div>
                <div className="legend-item"><span className="dot red"></span> End</div>
                <div className="legend-basemap">
                  {basemap.label}
                  {basemap.id === 'mapbox-outdoor' && !mapboxToken && (
                    <span className="legend-basemap-note"> (preview OSM — token belum terbaca)</span>
                  )}
                </div>
              </div>
            </div>

            {/* Sidebar */}
            <div className="sidebar">
              <div className="file-badge">
                <span className="file-badge-icon">📍</span>
                <span className="file-badge-name">{gpxName}</span>
              </div>

              {stats && (
                <div className="stats-grid">
                  <div className="stat-card">
                    <div className="stat-value">{stats.distance} <span className="stat-unit">km</span></div>
                    <div className="stat-label">Total Distance</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value">{stats.points.toLocaleString()}</div>
                    <div className="stat-label">Track Points</div>
                  </div>
                </div>
              )}

              {/* Warna Track */}
              <div className="section-block">
                <div className="section-title">Warna Track</div>
                <div className="color-palette">
                  {TRACK_COLORS.map(c => (
                    <button key={c.id} className={`color-swatch ${trackColor.id===c.id?'active':''}`}
                      style={{background:c.hex, border:c.hex==='#ffffff'?'1.5px solid #555':'none'}}
                      title={c.label} onClick={() => setTrackColor(c)} />
                  ))}
                </div>
                <div className="color-label">
                  <span className="color-preview" style={{background:trackColor.hex, border:trackColor.hex==='#ffffff'?'1px solid #555':'none'}}></span>
                  {trackColor.label}
                </div>
              </div>

              {/* Basemap */}
              <div className="section-block">
                <div className="section-title">Basemap</div>
                <div className="basemap-list">
                  {BASEMAPS.map(bm => (
                    <button key={bm.id} className={`basemap-item ${basemap.id===bm.id?'active':''}`} onClick={() => setBasemap(bm)}>
                      <div className="basemap-label">{bm.label}</div>
                      <div className="basemap-desc">{bm.desc}</div>
                    </button>
                  ))}
                </div>
                {basemap.requiresToken && (
                  <div className="mapbox-server-note">
                    🔑 Token dikonfigurasi via <code>MAPBOX_TOKEN</code> di server
                  </div>
                )}
              </div>

              {/* ── Export Options ── */}
              <div className="export-divider"><span>Export Options</span></div>

              {/* 1. GeoPDF Standard */}
              <div className="export-card">
                <div className="export-card-header">
                  <div className="export-card-icon">🗺</div>
                  <div>
                    <div className="export-card-title">GeoPDF — Avenza Maps</div>
                    <div className="export-card-desc">Georeferenced · ukuran mengikuti extent GPX</div>
                  </div>
                </div>
                <ExportBtn status={stGeo} label="⬇ Export GeoPDF" color="geo"
                  onClick={() => doExport({ endpoint:'/api/generate', filename:`${gpxName}_avenza.pdf`, setStatus:setStGeo })} />
                {stGeo==='done' && <div className="success-msg-sm">✓ Import ke Avenza: + → From Device</div>}
              </div>

              {/* 2. GeoPDF + Fit Kertas */}
              <div className="export-card">
                <div className="export-card-header">
                  <div className="export-card-icon">🗺📄</div>
                  <div>
                    <div className="export-card-title">GeoPDF — Fit Kertas</div>
                    <div className="export-card-desc">Georeferenced + di-fit ke ukuran kertas · bisa print & Avenza</div>
                  </div>
                </div>
                <PaperPicker value={paperGeo} onChange={setPaperGeo} />
                <div className="paper-selected-label">
                  {paperGeo.label} {paperGeo.sub} <span className="paper-dim-inline">{paperGeo.dim}</span>
                </div>
                <ExportBtn status={stGeoFit} label="⬇ Export GeoPDF Fit" color="geo-fit"
                  onClick={() => doExport({ endpoint:'/api/generate-geofit', filename:`${gpxName}_avenza_${paperGeo.id}.pdf`, extraFields:{paper_size:paperGeo.id}, setStatus:setStGeoFit })} />
                {stGeoFit==='done' && <div className="success-msg-sm">✓ Bisa di-import ke Avenza & dicetak!</div>}
              </div>

              {/* 3. PDF Print Biasa */}
              <div className="export-card">
                <div className="export-card-header">
                  <div className="export-card-icon">🖨</div>
                  <div>
                    <div className="export-card-title">PDF Biasa — Cetak</div>
                    <div className="export-card-desc">Tanpa georeferencing · siap print langsung</div>
                  </div>
                </div>
                <PaperPicker value={paperPrint} onChange={setPaperPrint} />
                <div className="paper-selected-label">
                  {paperPrint.label} {paperPrint.sub} <span className="paper-dim-inline">{paperPrint.dim}</span>
                </div>
                <ExportBtn status={stPrint} label="⬇ Export PDF" color="print"
                  onClick={() => doExport({ endpoint:'/api/generate-print', filename:`${gpxName}_${paperPrint.id}.pdf`, extraFields:{paper_size:paperPrint.id}, setStatus:setStPrint })} />
                {stPrint==='done' && <div className="success-msg-sm">✓ PDF siap dicetak!</div>}
              </div>

              {error && <div className="error-msg">{error}</div>}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
