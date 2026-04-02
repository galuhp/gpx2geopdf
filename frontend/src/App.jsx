import { useState, useCallback, useRef, useEffect } from 'react'
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'

delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

// ─── Constants ────────────────────────────────────────────────────────────────

const BASEMAPS = [
  { id: 'osm',            label: 'OSM Standard',    desc: 'Peta umum OpenStreetMap',        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',                attribution: '&copy; OpenStreetMap', maxZoom: 19 },
  { id: 'topo',           label: 'OpenTopoMap',      desc: 'Kontur + elevasi, cocok hiking', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',                   attribution: '&copy; OpenTopoMap',   maxZoom: 17 },
  { id: 'cyclosm',        label: 'CyclOSM',          desc: 'Detail trail + kontur, gratis',  url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', attribution: '&copy; CyclOSM',       maxZoom: 20 },
  { id: 'humanitarian',   label: 'OSM Humanitarian', desc: 'Teks besar, terbaca lapangan',   url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',              attribution: '&copy; OpenStreetMap', maxZoom: 19 },
  { id: 'mapbox-outdoor', label: 'Mapbox Outdoor',   desc: 'Kontur detail + terrain Mapbox', url: null, attribution: '&copy; Mapbox', maxZoom: 22, requiresToken: true },
  // Thunderforest styles
  { id: 'tf-outdoors',    label: 'TF Outdoors',      desc: 'Hiking & trail detail tinggi',   url: null, attribution: '&copy; Thunderforest, &copy; OpenStreetMap', maxZoom: 22, requiresTF: true },
]

const TRACK_COLORS = [
  '#ff3c3c','#ff8c00','#f5c400','#00c853',
  '#00bcd4','#2979ff','#9c27b0','#f06292','#ffffff','#222222',
]

const PAPER_SIZES = [
  { id: 'a4p', label: 'A4', sub: 'Portrait',  dim: '210×297mm' },
  { id: 'a4l', label: 'A4', sub: 'Landscape', dim: '297×210mm' },
  { id: 'a3p', label: 'A3', sub: 'Portrait',  dim: '297×420mm' },
  { id: 'a3l', label: 'A3', sub: 'Landscape', dim: '420×297mm' },
  { id: 'a2p', label: 'A2', sub: 'Portrait',  dim: '420×594mm' },
  { id: 'a2l', label: 'A2', sub: 'Landscape', dim: '594×420mm' },
  { id: 'a1p', label: 'A1', sub: 'Portrait',  dim: '594×841mm' },
  { id: 'a1l', label: 'A1', sub: 'Landscape', dim: '841×594mm' },
  { id: 'a5p', label: 'A5', sub: 'Portrait',  dim: '148×210mm' },
  { id: 'ltr', label: 'Letter', sub: 'Portrait', dim: '216×279mm' },
]

// Icon list: emoji + label + unique id
const ICONS = [
  { id:'camp',    emoji:'🏕',  label:'Camp' },
  { id:'peak',    emoji:'🏔',  label:'Puncak' },
  { id:'tent',    emoji:'⛺',  label:'Tenda' },
  { id:'flag',    emoji:'🚩',  label:'Titik' },
  { id:'warn',    emoji:'⚠️', label:'Bahaya' },
  { id:'water',   emoji:'💧',  label:'Air' },
  { id:'food',    emoji:'🍽',  label:'Makan' },
  { id:'parking', emoji:'🅿',  label:'Parkir' },
  { id:'medic',   emoji:'🏥',  label:'P3K' },
  { id:'photo',   emoji:'📷',  label:'Foto' },
  { id:'fuel',    emoji:'⛽',  label:'BBM' },
  { id:'fire',    emoji:'🔥',  label:'Api' },
  { id:'rest',    emoji:'🪑',  label:'Istirahat' },
  { id:'view',    emoji:'🔭',  label:'Viewpoint' },
  { id:'bridge',  emoji:'🌉',  label:'Jembatan' },
  { id:'river',   emoji:'🏞',  label:'Sungai' },
  { id:'cave',    emoji:'🕳',  label:'Gua' },
  { id:'village', emoji:'🏘',  label:'Desa' },
  { id:'mosque',  emoji:'🕌',  label:'Masjid' },
  { id:'sos',     emoji:'🆘',  label:'SOS' },
  { id:'star',    emoji:'⭐',  label:'Penting' },
  { id:'pin',     emoji:'📍',  label:'Pin' },
  { id:'compass', emoji:'🧭',  label:'Navigasi' },
  { id:'tree',    emoji:'🌲',  label:'Hutan' },
]

// Auto-assign track colors in order
const AUTO_COLORS = ['#ff3c3c','#2979ff','#00c853','#ff8c00','#9c27b0','#00bcd4','#f5c400','#f06292']

// ─── Helper components ────────────────────────────────────────────────────────

function makeEmojiIcon(emoji) {
  return new L.DivIcon({
    html: `<div style="font-size:22px;line-height:1;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.6))">${emoji}</div>`,
    iconSize: [28, 28], iconAnchor: [14, 24], popupAnchor: [0, -24], className: ''
  })
}

function makeTrackEndIcon(color) {
  return new L.DivIcon({
    html: `<div style="width:12px;height:12px;background:${color};border:2px solid #fff;border-radius:50%;box-shadow:0 0 5px ${color}99"></div>`,
    iconSize: [12, 12], iconAnchor: [6, 6], className: ''
  })
}

function makeWaypointIcon(index, total, color = '#e05c3a') {
  const isStart = index === 0
  const isEnd   = index === total - 1
  const label   = isStart ? 'A' : isEnd ? 'B' : String(index)
  const bg      = isStart ? '#00c853' : isEnd ? '#e05c3a' : '#2979ff'
  return new L.DivIcon({
    html: `<div style="width:26px;height:26px;background:${bg};border:2.5px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;box-shadow:0 2px 6px rgba(0,0,0,0.45);cursor:grab">${label}</div>`,
    iconSize: [26, 26], iconAnchor: [13, 13], className: ''
  })
}

// ── Routing engines ────────────────────────────────────────────────────────
// Engine 1: Valhalla (Stadia Maps — demo key, no sign-up needed for low usage)
// Mendukung footway, path, track, sac_scale lengkap dari OSM
async function fetchValhallaRoute(waypoints) {
  if (waypoints.length < 2) return null
  try {
    const locations = waypoints.map(w => ({ lat: w[0], lon: w[1] }))
    const body = {
      locations,
      costing: 'pedestrian',
      costing_options: {
        pedestrian: {
          use_tracks: 1.0,      // gunakan jalan setapak / track sepenuhnya
          use_ferry: 0.5,
          max_hiking_difficulty: 6,  // 0–6, 6 = very difficult hiking (sac_scale)
          service_penalty: 15,
          use_living_streets: 0.6
        }
      },
      directions_options: { units: 'km' }
    }
    const res = await fetch('https://valhalla1.openstreetmap.de/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) return null
    const data = await res.json()
    if (!data.trip?.legs?.length) return null
    // Decode Valhalla's encoded polyline (precision 6)
    const encoded = data.trip.legs[0].shape
    const pts = decodePolyline(encoded, 1e-6)
    const dist = data.trip.summary.length * 1000  // km → m
    return { points: pts, distance: dist, engine: 'Valhalla' }
  } catch { return null }
}

// Engine 3: GraphHopper (public demo — foot-hiking profile, mendukung footpath penuh)
async function fetchGraphHopperRoute(waypoints) {
  if (waypoints.length < 2) return null
  try {
    const ptParam = waypoints.map(w => `point=${w[0]},${w[1]}`).join('&')
    const url = `https://graphhopper.com/api/1/route?${ptParam}&profile=foot&locale=id&calc_points=true&points_encoded=false&key=`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    if (!data.paths?.length) return null
    const coords2 = data.paths[0].points.coordinates
    return { points: coords2.map(c => [c[1], c[0]]), distance: data.paths[0].distance, engine: 'GraphHopper' }
  } catch { return null }
}

// Decode Google-style encoded polyline (used by Valhalla with precision 1e-6)
function decodePolyline(encoded, precision = 1e-5) {
  const pts = []
  let index = 0, lat = 0, lng = 0
  while (index < encoded.length) {
    let b, shift = 0, result = 0
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
    lat += (result & 1) ? ~(result >> 1) : (result >> 1)
    shift = 0; result = 0
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
    lng += (result & 1) ? ~(result >> 1) : (result >> 1)
    pts.push([lat * precision, lng * precision])
  }
  return pts
}

// ── Main routing function: coba semua engine, pakai yang berhasil ──────────
// Prioritas: Valhalla (footpath terlengkap) → OSRM → GraphHopper
async function fetchOSRMRoute(waypoints) {
  // Coba Valhalla dulu (paling lengkap untuk jalan setapak)
  const valhalla = await fetchValhallaRoute(waypoints)
  if (valhalla) return valhalla

  // Fallback ke OSRM
  const osrm = await fetchOSRMRoute_raw(waypoints)
  if (osrm) return osrm

  // Fallback terakhir ke GraphHopper
  return await fetchGraphHopperRoute(waypoints)
}

// Rename OSRM original agar bisa dipanggil dari fallback
async function fetchOSRMRoute_raw(waypoints) {
  if (waypoints.length < 2) return null
  const coords = waypoints.map(w => `${w[1]},${w[0]}`).join(';')
  const url = `https://router.project-osrm.org/route/v1/foot/${coords}?overview=full&geometries=geojson&continue_straight=false`
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    if (data.code !== 'Ok' || !data.routes?.length) return null
    const coords2 = data.routes[0].geometry.coordinates
    return { points: coords2.map(c => [c[1], c[0]]), distance: data.routes[0].distance, engine: 'OSRM' }
  } catch { return null }
}

function makeLabelIcon(text, color = '#fff') {
  return new L.DivIcon({
    html: `<div style="background:rgba(0,0,0,0.72);color:${color};padding:3px 7px;border-radius:4px;font-size:12px;font-weight:600;white-space:nowrap;font-family:sans-serif;box-shadow:0 1px 4px rgba(0,0,0,0.5)">${text}</div>`,
    iconSize: null, iconAnchor: [0, 0], className: ''
  })
}

function FitRouteBounds({ points }) {
  const map = useMap()
  useEffect(() => {
    if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [40, 40] })
  }, [points.length])
  return null
}

function FitAllBounds({ tracks }) {
  const map = useMap()
  useEffect(() => {
    const allPts = tracks.flatMap(t => t.points)
    if (allPts.length > 0) map.fitBounds(L.latLngBounds(allPts), { padding: [40, 40] })
  }, [tracks.length])
  return null
}

// Map click handler
function MapClickHandler({ mode, onMapClick }) {
  useMapEvents({
    click(e) {
      if (mode !== 'idle') onMapClick(e.latlng)
    }
  })
  return null
}

function parseGPX(text, name) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(text, 'application/xml')
  const ns = 'http://www.topografix.com/GPX/1/1'
  const trkpts = doc.getElementsByTagNameNS(ns, 'trkpt')
  const points = []
  for (const pt of trkpts) points.push([parseFloat(pt.getAttribute('lat')), parseFloat(pt.getAttribute('lon'))])
  let dist = 0
  for (let i = 1; i < points.length; i++) {
    const [la1,lo1] = points[i-1], [la2,lo2] = points[i]
    const R = 6371, dLat=(la2-la1)*Math.PI/180, dLon=(lo2-lo1)*Math.PI/180
    const a = Math.sin(dLat/2)**2 + Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dLon/2)**2
    dist += R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))
  }
  return { name, points, dist: dist.toFixed(2) }
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

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [tracks, setTracks]           = useState([])   // [{id, name, points, dist, color}]
  const [annotations, setAnnotations] = useState([])   // [{id, type:'pin'|'text', lat, lon, icon?, text?, color?}]
  const [basemap, setBasemap]         = useState(BASEMAPS[0])
  const [mapboxToken, setMapboxToken] = useState('')
  const [thunderforestKey, setThunderforestKey] = useState('')
  const [paperGeo, setPaperGeo]       = useState(PAPER_SIZES[0])
  const [paperPrint, setPaperPrint]   = useState(PAPER_SIZES[0])
  const [error, setError]             = useState('')
  const [isDragging, setIsDragging]   = useState(false)

  // Annotation mode
  const [mode, setMode]               = useState('idle')  // 'idle' | 'addPin' | 'addText' | 'traceRoute'
  const [selectedIcon, setSelectedIcon] = useState(ICONS[0])
  const [pendingLabel, setPendingLabel] = useState({ visible: false, lat: 0, lon: 0, text: '' })
  const [activeTab, setActiveTab]     = useState('tracks')  // 'tracks'|'annotations'|'export'

  // Route tracer state
  const [routeWaypoints, setRouteWaypoints] = useState([])  // [[lat,lon], ...]
  const [routeSegments, setRouteSegments]   = useState([])  // [[points], ...] one per segment
  const [routeLoading, setRouteLoading]     = useState(false)
  const [routeError, setRouteError]         = useState('')
  const [routeName, setRouteName]           = useState('Rute Baru')

  // Export status
  const [stGeo, setStGeo]             = useState('idle')
  const [stGeoFit, setStGeoFit]       = useState('idle')
  const [stPrint, setStPrint]         = useState('idle')

  // ── Project Save / Load ─────────────────────────────────────────────────
  const [savedProjects, setSavedProjects] = useState(() => {
    try { return JSON.parse(localStorage.getItem('trailmap_projects') || '[]') } catch { return [] }
  })
  const [showProjectPanel, setShowProjectPanel] = useState(false)
  const [saveProjectName, setSaveProjectName]   = useState('')
  const [projectMsg, setProjectMsg]             = useState('')   // flash message

  const flashMsg = (msg) => { setProjectMsg(msg); setTimeout(() => setProjectMsg(''), 2500) }

  const saveProject = () => {
    const name = saveProjectName.trim() || `Proyek ${new Date().toLocaleDateString('id-ID')} ${new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}`
    const project = {
      id: Date.now(),
      name,
      savedAt: new Date().toISOString(),
      routeWaypoints,
      routeSegments,
      routeName,
      tracks,
      annotations,
      basemapId: basemap.id,
    }
    const updated = [project, ...savedProjects.filter(p => p.name !== name)].slice(0, 20)
    setSavedProjects(updated)
    localStorage.setItem('trailmap_projects', JSON.stringify(updated))
    setSaveProjectName('')
    flashMsg(`✅ Disimpan: "${name}"`)
  }

  const loadProject = (project) => {
    setRouteWaypoints(project.routeWaypoints || [])
    setRouteSegments(project.routeSegments || [])
    setRouteName(project.routeName || 'Rute Baru')
    setTracks(project.tracks || [])
    setAnnotations(project.annotations || [])
    const bm = BASEMAPS.find(b => b.id === project.basemapId) || BASEMAPS[0]
    setBasemap(bm)
    setMode('idle')
    setShowProjectPanel(false)
    flashMsg(`📂 Dimuat: "${project.name}"`)
  }

  const deleteProject = (id) => {
    const updated = savedProjects.filter(p => p.id !== id)
    setSavedProjects(updated)
    localStorage.setItem('trailmap_projects', JSON.stringify(updated))
  }

  const exportProjectFile = (project) => {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `${project.name.replace(/[^a-zA-Z0-9_\-]/g, '_')}.trailmap.json`
    a.click(); URL.revokeObjectURL(url)
  }

  const importProjectFile = (file) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const project = JSON.parse(e.target.result)
        if (!project.tracks && !project.routeWaypoints) { flashMsg('❌ File tidak valid'); return }
        project.id = Date.now()
        project.name = project.name || file.name.replace('.trailmap.json','')
        const updated = [project, ...savedProjects].slice(0, 20)
        setSavedProjects(updated)
        localStorage.setItem('trailmap_projects', JSON.stringify(updated))
        loadProject(project)
        flashMsg(`📥 Diimpor: "${project.name}"`)
      } catch { flashMsg('❌ Gagal membaca file') }
    }
    reader.readAsText(file)
  }

  const importFileRef = useRef()
  const fileInputRef = useRef()

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(d => {
      if (d.mapbox_token) setMapboxToken(d.mapbox_token)
      if (d.thunderforest_key) setThunderforestKey(d.thunderforest_key)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') setMode('idle') }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const addGpxFiles = useCallback((files) => {
    Array.from(files).forEach(file => {
      if (!file.name.endsWith('.gpx')) return
      const reader = new FileReader()
      reader.onload = (e) => {
        const track = parseGPX(e.target.result, file.name.replace('.gpx',''))
        setTracks(prev => {
          if (prev.find(t => t.name === track.name)) return prev
          const color = AUTO_COLORS[prev.length % AUTO_COLORS.length]
          const id = Date.now() + Math.random()
          return [...prev, { ...track, id, color }]
        })
      }
      reader.readAsText(file)
    })
  }, [])

  const onDrop = useCallback((e) => {
    e.preventDefault(); setIsDragging(false)
    addGpxFiles(e.dataTransfer.files)
  }, [addGpxFiles])

  const removeTrack = (id) => setTracks(prev => prev.filter(t => t.id !== id))
  const updateTrackColor = (id, color) => setTracks(prev => prev.map(t => t.id === id ? {...t, color} : t))

  const handleMapClick = (latlng) => {
    if (mode === 'addPin') {
      setAnnotations(prev => [...prev, { id: Date.now(), type: 'pin', lat: latlng.lat, lon: latlng.lng, icon: selectedIcon }])
      setMode('idle')
    } else if (mode === 'addText') {
      setPendingLabel({ visible: true, lat: latlng.lat, lon: latlng.lng, text: '' })
      setMode('idle')
    } else if (mode === 'traceRoute') {
      addRouteWaypoint([latlng.lat, latlng.lng])
    }
  }

  const addRouteWaypoint = async (latlng) => {
    const newWaypoints = [...routeWaypoints, latlng]
    setRouteWaypoints(newWaypoints)
    if (newWaypoints.length < 2) return
    // Fetch segment from last waypoint to new one
    setRouteLoading(true); setRouteError('')
    const result = await fetchOSRMRoute([newWaypoints[newWaypoints.length - 2], latlng])
    setRouteLoading(false)
    if (result) {
      setRouteSegments(prev => [...prev, result.points])
    } else {
      setRouteError('Tidak bisa snap ke jalur — coba titik lain')
      // fallback: straight line
      setRouteSegments(prev => [...prev, [newWaypoints[newWaypoints.length - 2], latlng]])
    }
  }

  const moveWaypoint = async (index, newLatLng) => {
    const newWaypoints = routeWaypoints.map((w, i) => i === index ? newLatLng : w)
    setRouteWaypoints(newWaypoints)
    if (newWaypoints.length < 2) return
    setRouteLoading(true); setRouteError('')
    // Re-fetch affected segments (before and after moved waypoint)
    const newSegments = [...routeSegments]
    const fetchPairs = []
    if (index > 0) fetchPairs.push({ segIdx: index - 1, a: newWaypoints[index - 1], b: newWaypoints[index] })
    if (index < newWaypoints.length - 1) fetchPairs.push({ segIdx: index, a: newWaypoints[index], b: newWaypoints[index + 1] })
    await Promise.all(fetchPairs.map(async ({ segIdx, a, b }) => {
      const result = await fetchOSRMRoute([a, b])
      newSegments[segIdx] = result ? result.points : [a, b]
    }))
    setRouteSegments(newSegments)
    setRouteLoading(false)
  }

  const removeWaypoint = async (index) => {
    if (routeWaypoints.length <= 1) { setRouteWaypoints([]); setRouteSegments([]); return }
    const newWaypoints = routeWaypoints.filter((_, i) => i !== index)
    setRouteWaypoints(newWaypoints)
    if (newWaypoints.length < 2) { setRouteSegments([]); return }
    // Re-stitch segments
    setRouteLoading(true)
    const newSegments = []
    for (let i = 0; i < newWaypoints.length - 1; i++) {
      const result = await fetchOSRMRoute([newWaypoints[i], newWaypoints[i + 1]])
      newSegments.push(result ? result.points : [newWaypoints[i], newWaypoints[i + 1]])
    }
    setRouteSegments(newSegments)
    setRouteLoading(false)
  }

  const clearRoute = () => {
    setRouteWaypoints([]); setRouteSegments([]); setRouteError('')
  }

  const commitRoute = () => {
    if (routeSegments.length === 0) return
    const allPoints = routeSegments.flat()
    // Deduplicate consecutive identical points
    const deduped = allPoints.filter((p, i) => i === 0 || !(p[0] === allPoints[i-1][0] && p[1] === allPoints[i-1][1]))
    let dist = 0
    for (let i = 1; i < deduped.length; i++) {
      const [la1,lo1] = deduped[i-1], [la2,lo2] = deduped[i]
      const R = 6371, dLat=(la2-la1)*Math.PI/180, dLon=(lo2-lo1)*Math.PI/180
      const a = Math.sin(dLat/2)**2 + Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dLon/2)**2
      dist += R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))
    }
    const track = { id: Date.now(), name: routeName || 'Rute Baru', points: deduped, dist: dist.toFixed(2), color: AUTO_COLORS[tracks.length % AUTO_COLORS.length] }
    setTracks(prev => [...prev, track])
    clearRoute()
    setMode('idle')
    setActiveTab('tracks')
  }

  const confirmLabel = () => {
    if (pendingLabel.text.trim()) {
      setAnnotations(prev => [...prev, { id: Date.now(), type: 'text', lat: pendingLabel.lat, lon: pendingLabel.lon, text: pendingLabel.text.trim() }])
    }
    setPendingLabel({ visible: false, lat: 0, lon: 0, text: '' })
  }

  const removeAnnotation = (id) => setAnnotations(prev => prev.filter(a => a.id !== id))

  const allPoints = tracks.flatMap(t => t.points)
  const hasData = tracks.length > 0

  const doExport = async ({ endpoint, filename, extraFields = {}, setStatus }) => {
    if (!hasData) return
    setStatus('generating'); setError('')
    const form = new FormData()
    // Send all GPX files
    for (const track of tracks) {
      // Reconstruct minimal GPX from points
      const gpxStr = `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${track.name}</name><trkseg>${track.points.map(([lat,lon])=>`<trkpt lat="${lat}" lon="${lon}"/>`).join('')}</trkseg></trk></gpx>`
      const blob = new Blob([gpxStr], { type: 'application/gpx+xml' })
      form.append('files', blob, `${track.name}.gpx`)
      form.append('track_colors', track.color)
    }
    form.append('basemap_id', basemap.id)
    form.append('annotations', JSON.stringify(annotations))
    if (thunderforestKey) form.append('thunderforest_key', thunderforestKey)
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
    setTracks([]); setAnnotations([]); setMode('idle')
    setStGeo('idle'); setStGeoFit('idle'); setStPrint('idle'); setError('')
    clearRoute()
  }

  const tileUrl = basemap.id === 'mapbox-outdoor' && mapboxToken
    ? `https://api.mapbox.com/styles/v1/mapbox/outdoors-v12/tiles/512/{z}/{x}/{y}@2x?access_token=${mapboxToken}`
    : basemap.id === 'mapbox-outdoor' ? 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
    : basemap.id === 'tf-outdoors' && thunderforestKey
    ? `https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey=${thunderforestKey}`
    : basemap.requiresTF ? 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
    : basemap.url

  const ExportBtn = ({ status, label, onClick, color = 'geo' }) => (
    <button className={`btn-export ${color} ${status==='generating'?'loading':''}`} onClick={onClick} disabled={status==='generating'||!hasData}>
      {status==='generating' ? <><span className="spinner"></span> Generating…</> : status==='done' ? '✓ Download Again' : label}
    </button>
  )

  const showWorkspace = hasData || routeWaypoints.length > 0 || mode === 'traceRoute'

  // ─── Drop zone screen (landing) ─────────────────────────────────────────────
  if (!showWorkspace) return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo"><span className="logo-icon">⛰</span><div><div className="logo-title">TrailMap</div><div className="logo-sub">GPX → PDF / GeoPDF for Avenza</div></div></div>
        </div>
      </header>
      <main className="main">
        <div className="drop-zone-wrap">
          <div className="landing-options">
            {/* Option A: Import GPX */}
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
              <div className="drop-title">Import GPX</div>
              <div className="drop-sub">Drop file atau klik untuk browse</div>
              <div className="drop-hint">.gpx — Strava, Garmin, Komoot, dll. Bisa multiple.</div>
              <input ref={fileInputRef} type="file" accept=".gpx" multiple style={{display:'none'}} onChange={e => addGpxFiles(e.target.files)} />
            </div>

            {/* Option B: Trace Route */}
            <div className="drop-zone trace-zone" onClick={() => { setMode('traceRoute'); setActiveTab('tracks') }}>
              <div className="drop-icon">
                <svg width="56" height="56" viewBox="0 0 64 64" fill="none">
                  <circle cx="16" cy="48" r="7" stroke="#00c853" strokeWidth="3" fill="none"/>
                  <circle cx="48" cy="16" r="7" stroke="#e05c3a" strokeWidth="3" fill="none"/>
                  <path d="M16 41 C16 28 30 20 48 23" stroke="currentColor" strokeWidth="2.5" strokeDasharray="5 3" strokeLinecap="round" fill="none"/>
                  <circle cx="32" cy="30" r="4" stroke="#2979ff" strokeWidth="2.5" fill="none"/>
                </svg>
              </div>
              <div className="drop-title">Trace Route di Peta</div>
              <div className="drop-sub">Klik titik awal → via → titik akhir</div>
              <div className="drop-hint">Snap ke jalur OSM: jalan raya, jalan setapak, footpath, hiking track.</div>
            </div>
          </div>

          {error && <div className="error-msg">{error}</div>}
          <div className="how-it-works">
            <div className="hiw-title">How it works</div>
            <div className="hiw-steps">
              <div className="hiw-step"><span className="hiw-num">1</span><span>Import GPX atau trace rute di peta</span></div>
              <div className="hiw-step"><span className="hiw-num">2</span><span>Tambah pin & teks di peta</span></div>
              <div className="hiw-step"><span className="hiw-num">3</span><span>Export GeoPDF (Avenza) atau PDF cetak</span></div>
            </div>
          </div>
        </div>
      </main>
    </div>
  )

  // ─── Workspace ──────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo"><span className="logo-icon">⛰</span><div><div className="logo-title">TrailMap</div><div className="logo-sub">GPX → PDF / GeoPDF for Avenza</div></div></div>
          <div className="header-actions">
            {/* Add more GPX */}
            <button className="btn-ghost btn-add-gpx" onClick={() => fileInputRef.current.click()}>+ GPX</button>
            <input ref={fileInputRef} type="file" accept=".gpx" multiple style={{display:'none'}} onChange={e => addGpxFiles(e.target.files)} />
            {/* Trace route */}
            <button className={`btn-mode ${mode==='traceRoute'?'active':''}`} onClick={() => { setMode(m => m==='traceRoute'?'idle':'traceRoute'); setActiveTab('tracks') }} title="Trace rute di peta">
              🗺 Trace {mode==='traceRoute' && <span className="mode-badge">Aktif</span>}
            </button>
            {/* Mode buttons */}
            <button className={`btn-mode ${mode==='addPin'?'active':''}`} onClick={() => setMode(m => m==='addPin'?'idle':'addPin')} title="Klik peta untuk tambah pin">
              📍 Pin {mode==='addPin' && <span className="mode-badge">Aktif</span>}
            </button>
            <button className={`btn-mode ${mode==='addText'?'active':''}`} onClick={() => setMode(m => m==='addText'?'idle':'addText')} title="Klik peta untuk tambah teks">
              🔤 Teks {mode==='addText' && <span className="mode-badge">Aktif</span>}
            </button>
            {/* Save / Load Project */}
            <button className="btn-ghost btn-save-project" onClick={() => setShowProjectPanel(p => !p)} title="Simpan / muat project">
              💾 Proyek {savedProjects.length > 0 && <span className="stab-badge">{savedProjects.length}</span>}
            </button>
            <button className="btn-ghost" onClick={reset}>← Reset</button>
          </div>
        </div>
      </header>

      {/* ── Project Save/Load Panel ─────────────────────────────────── */}
      {showProjectPanel && (
        <div className="project-panel-overlay" onClick={e => { if (e.target===e.currentTarget) setShowProjectPanel(false) }}>
          <div className="project-panel">
            <div className="project-panel-header">
              <span>💾 Kelola Proyek</span>
              <button className="project-panel-close" onClick={() => setShowProjectPanel(false)}>✕</button>
            </div>

            {/* Flash message */}
            {projectMsg && <div className="project-flash">{projectMsg}</div>}

            {/* Save current */}
            <div className="project-section">
              <div className="project-section-title">Simpan Proyek Sekarang</div>
              <div className="project-save-row">
                <input
                  className="project-name-input"
                  placeholder="Nama proyek (opsional)..."
                  value={saveProjectName}
                  onChange={e => setSaveProjectName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && saveProject()}
                />
                <button className="btn-project-save" onClick={saveProject}>💾 Simpan</button>
              </div>
              <div className="project-save-info">
                Menyimpan: {tracks.length} track · {annotations.length} anotasi · {routeWaypoints.length} waypoint rute
              </div>
            </div>

            {/* Import from file */}
            <div className="project-section">
              <div className="project-section-title">Import dari File</div>
              <button className="btn-project-import" onClick={() => importFileRef.current.click()}>
                📥 Buka file .trailmap.json
              </button>
              <input ref={importFileRef} type="file" accept=".json,.trailmap.json" style={{display:'none'}}
                onChange={e => { if (e.target.files[0]) importProjectFile(e.target.files[0]); e.target.value = '' }} />
            </div>

            {/* Saved list */}
            <div className="project-section">
              <div className="project-section-title">Proyek Tersimpan ({savedProjects.length})</div>
              {savedProjects.length === 0 && (
                <div className="project-empty">Belum ada proyek tersimpan.</div>
              )}
              <div className="project-list">
                {savedProjects.map(p => (
                  <div key={p.id} className="project-item">
                    <div className="project-item-info" onClick={() => loadProject(p)}>
                      <div className="project-item-name">{p.name}</div>
                      <div className="project-item-meta">
                        {new Date(p.savedAt).toLocaleDateString('id-ID', {day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}
                        {' · '}{(p.tracks||[]).length} track · {(p.annotations||[]).length} anotasi
                        {(p.routeWaypoints||[]).length > 0 && ` · ${p.routeWaypoints.length} wp rute`}
                      </div>
                    </div>
                    <div className="project-item-actions">
                      <button className="btn-proj-load" onClick={() => loadProject(p)} title="Muat proyek ini">📂</button>
                      <button className="btn-proj-export" onClick={() => exportProjectFile(p)} title="Export ke file .json">⬇</button>
                      <button className="btn-proj-delete" onClick={() => deleteProject(p.id)} title="Hapus">🗑</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mode hint bar */}
      {mode !== 'idle' && (
        <div className="mode-hint">
          {mode === 'addPin' ? `📍 Klik di peta untuk menempatkan "${selectedIcon.emoji} ${selectedIcon.label}" — tekan Esc untuk batal`
          : mode === 'addText' ? '🔤 Klik di peta untuk menempatkan teks — tekan Esc untuk batal'
          : mode === 'traceRoute' ? (
            routeWaypoints.length === 0
              ? '🗺 Klik titik AWAL di peta — rute akan snap ke jalan setapak & jalur OSM'
              : routeWaypoints.length === 1
              ? '🗺 Klik titik berikutnya (via atau akhir) — bisa tambah banyak titik'
              : `🗺 Klik untuk tambah titik via/akhir lagi • ${routeWaypoints.length} titik • Lihat sidebar untuk finalisasi`
          ) : ''}
          <button className="mode-hint-close" onClick={() => setMode('idle')}>✕</button>
        </div>
      )}

      {/* Label input popup */}
      {pendingLabel.visible && (
        <div className="label-popup-overlay">
          <div className="label-popup">
            <div className="label-popup-title">Masukkan teks label</div>
            <input
              className="label-popup-input"
              autoFocus
              value={pendingLabel.text}
              onChange={e => setPendingLabel(p => ({...p, text: e.target.value}))}
              onKeyDown={e => { if (e.key==='Enter') confirmLabel(); if (e.key==='Escape') setPendingLabel({visible:false,lat:0,lon:0,text:''}) }}
              placeholder="Contoh: Pos 1, Camp, Sumber Air..."
            />
            <div className="label-popup-actions">
              <button className="btn-popup-cancel" onClick={() => setPendingLabel({visible:false,lat:0,lon:0,text:''})}>Batal</button>
              <button className="btn-popup-ok" onClick={confirmLabel}>OK</button>
            </div>
          </div>
        </div>
      )}

      <main className="main">
        <div className="workspace">
          {/* MAP */}
          <div className={`map-wrap ${mode!=='idle'?'map-cursor-crosshair':''}`}>
            <MapContainer center={allPoints[0] || routeWaypoints[0] || [-7.5,110.4]} zoom={13} style={{width:'100%',height:'100%'}}>
              <TileLayer key={basemap.id+mapboxToken} url={tileUrl} attribution={basemap.attribution} maxZoom={basemap.maxZoom}
                tileSize={basemap.id==='mapbox-outdoor'&&mapboxToken?512:256}
                zoomOffset={basemap.id==='mapbox-outdoor'&&mapboxToken?-1:0} />

              {/* Route tracer — segments */}
              {routeSegments.map((seg, i) => (
                <Polyline key={i} positions={seg} color="#2979ff" weight={4} opacity={0.85} dashArray="8 4" />
              ))}
              {/* Route tracer — waypoint markers (draggable) */}
              {routeWaypoints.map((wp, i) => (
                <Marker
                  key={`wp-${i}`}
                  position={wp}
                  icon={makeWaypointIcon(i, routeWaypoints.length)}
                  draggable={true}
                  eventHandlers={{
                    dragend(e) { moveWaypoint(i, [e.target.getLatLng().lat, e.target.getLatLng().lng]) }
                  }}
                >
                  <Popup>
                    <div style={{textAlign:'center',fontSize:12}}>
                      {i === 0 ? '🟢 Titik Awal' : i === routeWaypoints.length-1 ? '🔴 Titik Akhir' : `🔵 Via ${i}`}
                      <br/><small>{wp[0].toFixed(5)}, {wp[1].toFixed(5)}</small>
                      <br/><button style={{marginTop:5,fontSize:11,cursor:'pointer',background:'#ff4444',color:'#fff',border:'none',borderRadius:4,padding:'2px 8px'}} onClick={() => removeWaypoint(i)}>Hapus titik ini</button>
                    </div>
                  </Popup>
                </Marker>
              ))}
              {routeWaypoints.length > 1 && <FitRouteBounds points={routeWaypoints} />}

              {/* All tracks */}
              {tracks.map(track => (
                <span key={track.id}>
                  <Polyline positions={track.points} color={track.color} weight={4} opacity={0.9} />
                  {track.points.length > 0 && <>
                    <Marker position={track.points[0]} icon={makeTrackEndIcon(track.color)} />
                    <Marker position={track.points[track.points.length-1]} icon={makeTrackEndIcon('#ff3d3d')} />
                  </>}
                </span>
              ))}
              {tracks.length > 0 && <FitAllBounds tracks={tracks} />}

              {/* Annotations */}
              {annotations.map(a => (
                a.type === 'pin'
                  ? <Marker key={a.id} position={[a.lat, a.lon]} icon={makeEmojiIcon(a.icon.emoji)}>
                      <Popup><div style={{textAlign:'center'}}>{a.icon.emoji} {a.icon.label}<br/><button style={{marginTop:6,fontSize:11,cursor:'pointer',background:'#ff4444',color:'#fff',border:'none',borderRadius:4,padding:'2px 8px'}} onClick={() => removeAnnotation(a.id)}>Hapus</button></div></Popup>
                    </Marker>
                  : <Marker key={a.id} position={[a.lat, a.lon]} icon={makeLabelIcon(a.text)}>
                      <Popup><div style={{textAlign:'center'}}>{a.text}<br/><button style={{marginTop:6,fontSize:11,cursor:'pointer',background:'#ff4444',color:'#fff',border:'none',borderRadius:4,padding:'2px 8px'}} onClick={() => removeAnnotation(a.id)}>Hapus</button></div></Popup>
                    </Marker>
              ))}

              <MapClickHandler mode={mode} onMapClick={handleMapClick} />
            </MapContainer>

            <div className="map-legend">
              {tracks.map(t => <div key={t.id} className="legend-item"><span className="dot" style={{background:t.color}}></span>{t.name}</div>)}
              {routeWaypoints.length > 0 && (
                <div className="legend-item">
                  <span className="dot" style={{background:'#2979ff'}}></span>
                  Trace Route ({routeWaypoints.length} titik{routeLoading ? ' · loading…' : ''})
                </div>
              )}
              <div className="legend-basemap">{basemap.label}</div>
            </div>
          </div>

          {/* SIDEBAR */}
          <div className="sidebar">
            {/* Tabs */}
            <div className="sidebar-tabs">
              <button className={`stab ${activeTab==='tracks'?'active':''}`} onClick={() => setActiveTab('tracks')}>Tracks {tracks.length > 0 && <span className="stab-badge">{tracks.length}</span>}</button>
              <button className={`stab ${activeTab==='annotations'?'active':''}`} onClick={() => setActiveTab('annotations')}>Anotasi {annotations.length > 0 && <span className="stab-badge">{annotations.length}</span>}</button>
              <button className={`stab ${activeTab==='export'?'active':''}`} onClick={() => setActiveTab('export')}>Export</button>
            </div>

            {/* ── TAB: TRACKS ── */}
            {activeTab === 'tracks' && (
              <div className="tab-content">

                {/* ── Route Tracer Panel ── */}
                {(mode === 'traceRoute' || routeWaypoints.length > 0) && (
                  <div className="route-panel">
                    <div className="route-panel-header">
                      <span>🗺 Trace Route</span>
                      {routeLoading && <span className="route-loading-dot">●</span>}
                    </div>

                    {/* Route name */}
                    <input
                      className="route-name-input"
                      value={routeName}
                      onChange={e => setRouteName(e.target.value)}
                      placeholder="Nama rute..."
                    />

                    {/* Waypoint list */}
                    {routeWaypoints.length === 0 && (
                      <div className="route-empty">Klik di peta untuk mulai menaruh titik awal.</div>
                    )}
                    {routeWaypoints.map((wp, i) => (
                      <div key={i} className="waypoint-item">
                        <div className={`wp-badge ${i===0?'start':i===routeWaypoints.length-1?'end':'via'}`}>
                          {i===0?'A':i===routeWaypoints.length-1?'B':i}
                        </div>
                        <div className="wp-coord">{wp[0].toFixed(4)}, {wp[1].toFixed(4)}</div>
                        <div className="wp-label">{i===0?'Awal':i===routeWaypoints.length-1?'Akhir':`Via ${i}`}</div>
                        <button className="wp-remove" onClick={() => removeWaypoint(i)} title="Hapus titik ini">✕</button>
                      </div>
                    ))}

                    {routeError && <div className="route-error">{routeError}</div>}

                    {/* Actions */}
                    <div className="route-actions">
                      {mode !== 'traceRoute'
                        ? <button className="btn-route-add" onClick={() => setMode('traceRoute')}>+ Tambah Titik</button>
                        : <button className="btn-route-add active" onClick={() => setMode('idle')}>✕ Stop Tambah</button>
                      }
                      <button className="btn-route-clear" onClick={clearRoute} disabled={routeWaypoints.length === 0}>🗑 Hapus</button>
                    </div>

                    {routeSegments.length > 0 && (
                      <button className="btn-commit-route" onClick={commitRoute}>
                        ✓ Gunakan Rute Ini sebagai Track
                      </button>
                    )}

                    <div className="route-tip">
                      💡 Drag marker untuk edit jalur. Klik marker → popup untuk hapus titik. Rute snap ke jalan setapak & footpath OSM (Valhalla/OSRM).
                    </div>
                  </div>
                )}

                {mode !== 'traceRoute' && routeWaypoints.length === 0 && (
                  <button className="btn-start-trace" onClick={() => setMode('traceRoute')}>
                    🗺 Trace Route Baru di Peta
                  </button>
                )}

                <div className="section-title" style={{marginTop: tracks.length > 0 ? 8 : 0}}>GPX Files ({tracks.length})</div>
                {tracks.map(track => (
                  <div key={track.id} className="track-item">
                    <div className="track-item-header">
                      <div className="track-color-dot" style={{background:track.color}}></div>
                      <div className="track-item-info">
                        <div className="track-item-name">{track.name}</div>
                        <div className="track-item-meta">{track.dist} km · {track.points.length.toLocaleString()} pts</div>
                      </div>
                      <button className="track-item-remove" onClick={() => removeTrack(track.id)}>✕</button>
                    </div>
                    <div className="track-color-row">
                      <span className="track-color-label">Warna:</span>
                      <div className="track-colors">
                        {AUTO_COLORS.map(c => (
                          <button key={c} className={`tcolor ${track.color===c?'active':''}`}
                            style={{background:c, border:c==='#ffffff'?'1.5px solid #555':'none'}}
                            onClick={() => updateTrackColor(track.id, c)} />
                        ))}
                      </div>
                    </div>
                  </div>
                ))}

                {/* Basemap */}
                <div className="section-title" style={{marginTop:8}}>Basemap</div>
                <div className="basemap-list">
                  {BASEMAPS.map(bm => (
                    <button key={bm.id} className={`basemap-item ${basemap.id===bm.id?'active':''}`} onClick={() => setBasemap(bm)}>
                      <div className="basemap-label">
                        {bm.label}
                        {bm.requiresToken && !mapboxToken && <span className="basemap-badge">API Key</span>}
                        {bm.requiresTF && !thunderforestKey && <span className="basemap-badge tf">TF Key</span>}
                      </div>
                      <div className="basemap-desc">{bm.desc}</div>
                    </button>
                  ))}
                </div>
                {basemap.requiresTF && (
                  <div className="mapbox-server-note" style={{marginTop:6}}>
                    <div style={{marginBottom:4, color:'var(--text2)', fontWeight:600, fontSize:11}}>🗝 Thunderforest API Key</div>
                    <input
                      type="text"
                      placeholder="Paste API key di sini…"
                      value={thunderforestKey}
                      onChange={e => setThunderforestKey(e.target.value.trim())}
                      style={{width:'100%', background:'var(--bg)', border:'1px solid var(--border)', borderRadius:4, padding:'4px 7px', color:'var(--text)', fontSize:11, fontFamily:'monospace', boxSizing:'border-box'}}
                    />
                    <div style={{marginTop:4, fontSize:10, color:'var(--text3)'}}>
                      Daftar gratis di <a href="https://www.thunderforest.com/docs/apikeys/" target="_blank" rel="noreferrer" style={{color:'#2979ff'}}>thunderforest.com</a>. Key juga bisa diset via <code>THUNDERFOREST_KEY</code> di server.
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── TAB: ANNOTATIONS ── */}
            {activeTab === 'annotations' && (
              <div className="tab-content">
                {/* Pin mode */}
                <div className="section-title">Tambah Pin / Icon</div>
                <div className="icon-grid">
                  {ICONS.map(ic => (
                    <button key={ic.id} className={`icon-item ${selectedIcon.id===ic.id?'active':''}`} onClick={() => setSelectedIcon(ic)} title={ic.label}>
                      <span className="icon-emoji">{ic.emoji}</span>
                      <span className="icon-label">{ic.label}</span>
                    </button>
                  ))}
                </div>
                <button className={`btn-annotate ${mode==='addPin'?'annotate-active':''}`} onClick={() => setMode(m => m==='addPin'?'idle':'addPin')}>
                  {mode==='addPin' ? '✕ Batal — klik peta untuk pin' : `📍 Klik peta → taruh ${selectedIcon.emoji} ${selectedIcon.label}`}
                </button>

                <div className="section-title" style={{marginTop:10}}>Tambah Teks Label</div>
                <button className={`btn-annotate ${mode==='addText'?'annotate-active':''}`} onClick={() => setMode(m => m==='addText'?'idle':'addText')}>
                  {mode==='addText' ? '✕ Batal — klik peta untuk teks' : '🔤 Klik peta → ketik teks'}
                </button>

                {/* List annotations */}
                {annotations.length > 0 && (
                  <>
                    <div className="section-title" style={{marginTop:10}}>Daftar Anotasi ({annotations.length})</div>
                    {annotations.map(a => (
                      <div key={a.id} className="annotation-item">
                        <span className="ann-icon">{a.type==='pin' ? a.icon.emoji : '🔤'}</span>
                        <span className="ann-label">{a.type==='pin' ? a.icon.label : a.text}</span>
                        <span className="ann-coord">{a.lat.toFixed(4)}, {a.lon.toFixed(4)}</span>
                        <button className="ann-remove" onClick={() => removeAnnotation(a.id)}>✕</button>
                      </div>
                    ))}
                  </>
                )}
                {annotations.length === 0 && <div className="ann-empty">Belum ada anotasi. Pilih icon atau teks lalu klik peta.</div>}
              </div>
            )}

            {/* ── TAB: EXPORT ── */}
            {activeTab === 'export' && (
              <div className="tab-content">
                {/* GeoPDF Standard */}
                <div className="export-card">
                  <div className="export-card-header">
                    <div className="export-card-icon">🗺</div>
                    <div>
                      <div className="export-card-title">GeoPDF — Avenza Maps</div>
                      <div className="export-card-desc">Georeferenced · ukuran mengikuti extent</div>
                    </div>
                  </div>
                  <ExportBtn status={stGeo} label="⬇ Export GeoPDF" color="geo"
                    onClick={() => doExport({ endpoint:'/api/generate', filename:`trail_avenza.pdf`, setStatus:setStGeo })} />
                  {stGeo==='done' && <div className="success-msg-sm">✓ Import ke Avenza: + → From Device</div>}
                </div>

                {/* GeoPDF Fit */}
                <div className="export-card">
                  <div className="export-card-header">
                    <div className="export-card-icon">🗺📄</div>
                    <div>
                      <div className="export-card-title">GeoPDF — Fit Kertas</div>
                      <div className="export-card-desc">Georeferenced + fit ukuran kertas</div>
                    </div>
                  </div>
                  <PaperPicker value={paperGeo} onChange={setPaperGeo} />
                  <ExportBtn status={stGeoFit} label="⬇ Export GeoPDF Fit" color="geo-fit"
                    onClick={() => doExport({ endpoint:'/api/generate-geofit', filename:`trail_avenza_${paperGeo.id}.pdf`, extraFields:{paper_size:paperGeo.id}, setStatus:setStGeoFit })} />
                  {stGeoFit==='done' && <div className="success-msg-sm">✓ Bisa Avenza & dicetak!</div>}
                </div>

                {/* PDF Print */}
                <div className="export-card">
                  <div className="export-card-header">
                    <div className="export-card-icon">🖨</div>
                    <div>
                      <div className="export-card-title">PDF Biasa — Cetak</div>
                      <div className="export-card-desc">Tanpa georeferencing · siap print</div>
                    </div>
                  </div>
                  <PaperPicker value={paperPrint} onChange={setPaperPrint} />
                  <ExportBtn status={stPrint} label="⬇ Export PDF" color="print"
                    onClick={() => doExport({ endpoint:'/api/generate-print', filename:`trail_${paperPrint.id}.pdf`, extraFields:{paper_size:paperPrint.id}, setStatus:setStPrint })} />
                  {stPrint==='done' && <div className="success-msg-sm">✓ PDF siap dicetak!</div>}
                </div>

                {!hasData && <div className="ann-empty">Import GPX atau trace & gunakan rute terlebih dahulu.</div>}
                {error && <div className="error-msg">{error}</div>}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
