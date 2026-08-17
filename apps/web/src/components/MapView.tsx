'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { Map as MlMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { DEFAULT_CENTER, DEFAULT_ZOOM, DEFAULT_BASEMAP } from '@/lib/config';
import { circleToPolygon, haversineMeters } from '@/lib/geo';
import { BASEMAPS, BASEMAP_LAYER_IDS, BASEMAP_VISIBLE, buildBaseStyle, type BasemapId } from '@/lib/basemaps';
import type { Position, Geofence, DrawMode, DrawnShape, Device } from '@/lib/types';
import { motionState, MOTION_HEX, MOTION_LABEL } from '@/lib/motion';

interface Props {
  positions: Record<string, Position>;
  /** device rows, so a marker can be classified (suspended/retired → inactive) */
  devices: Device[];
  selectedId: string | null;
  history: Position[];
  geofences: Geofence[];
  playback: Position | null;
  drawMode: DrawMode;
  /** device the camera keeps centred as new positions arrive */
  followId: string | null;
  /** one-shot "pan to this device" request; bump the nonce to re-trigger */
  focus: { deviceId: string; nonce: number } | null;
  onSelect: (deviceId: string) => void;
  onShapeDrawn: (shape: DrawnShape) => void;
}

/**
 * MapLibre GL map. Renders a diff-updated marker per device (rotated to heading,
 * colored by ignition) and, for the selected device, its history as a route
 * line. WebGL handles thousands of markers; here we update in place rather than
 * re-adding, so live pushes are cheap.
 */
export function MapView({ positions, devices, selectedId, history, geofences, playback, drawMode, followId, focus, onSelect, onShapeDrawn }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const markers = useRef<Map<string, Marker>>(new Map());
  const ready = useRef(false);
  const [basemap, setBasemap] = useState<BasemapId>(DEFAULT_BASEMAP);

  useEffect(() => {
    if (map.current || !container.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      style: buildBaseStyle(DEFAULT_BASEMAP),
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      attributionControl: { compact: true },
    });
    m.addControl(new maplibregl.NavigationControl({}), 'top-right');
    m.on('load', () => {
      ready.current = true;
      // Geofences (drawn beneath routes/markers).
      m.addSource('geofences', { type: 'geojson', data: emptyCollection() });
      m.addLayer({ id: 'geofence-fill', type: 'fill', source: 'geofences', paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.12 } });
      m.addLayer({ id: 'geofence-line', type: 'line', source: 'geofences', paint: { 'line-color': '#f59e0b', 'line-width': 1.5, 'line-dasharray': [2, 1] } });
      // Selected-device route.
      m.addSource('route', { type: 'geojson', data: emptyLine() });
      m.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': '#0ea5e9', 'line-width': 3 } });
      // Playback marker.
      m.addSource('playback', { type: 'geojson', data: emptyCollection() });
      m.addLayer({ id: 'playback-point', type: 'circle', source: 'playback', paint: { 'circle-radius': 7, 'circle-color': '#f43f5e', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
      // In-progress geofence being drawn (on top of everything).
      m.addSource('draw', { type: 'geojson', data: emptyCollection() });
      m.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw', paint: { 'fill-color': '#10b981', 'fill-opacity': 0.2 } });
      m.addLayer({ id: 'draw-line', type: 'line', source: 'draw', paint: { 'line-color': '#10b981', 'line-width': 2 } });
      m.addLayer({ id: 'draw-vertex', type: 'circle', source: 'draw', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#10b981', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
    });
    map.current = m;
    // Dev aid: expose the map for inspection/E2E checks (harmless in prod).
    if (typeof window !== 'undefined') (window as unknown as { __fleetMap?: MlMap }).__fleetMap = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  // "Inactive" is decided by elapsed time, not by a new position arriving — a
  // vehicle that goes quiet must turn black on its own. Re-run the marker pass
  // every 30s so that transition happens without waiting for the next report.
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setClock((c) => c + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const deviceById = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);

  // Diff-update markers.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const now = Date.now();
    for (const [deviceId, pos] of Object.entries(positions)) {
      let marker = markers.current.get(deviceId);
      if (!marker) {
        const el = document.createElement('button');
        el.className = 'fleet-marker';
        el.addEventListener('click', () => onSelect(deviceId));
        marker = new maplibregl.Marker({ element: el }).setLngLat([pos.longitude, pos.latitude]);
        marker.addTo(m);
        markers.current.set(deviceId, marker);
      } else {
        marker.setLngLat([pos.longitude, pos.latitude]);
      }
      const el = marker.getElement();
      const device = deviceById.get(deviceId);
      // A position with no matching device row can't be classified for
      // suspended/retired; treat it as an ordinary active device.
      const state = motionState(device ?? { status: 'active' } as Device, pos, now);
      el.style.setProperty('--rot', `${pos.heading}deg`);
      el.style.setProperty('--motion', MOTION_HEX[state]);
      el.dataset.motion = state;
      el.dataset.selected = String(deviceId === selectedId);
      el.title = `${device?.name?.trim() || pos.imei} — ${MOTION_LABEL[state]}${state === 'moving' ? ` · ${pos.speedKph} km/h` : ''}`;
    }
  }, [positions, selectedId, onSelect, deviceById, clock]);

  // Draw the selected device's history line.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    const src = m.getSource('route') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (history.length > 1) {
      src.setData({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: history.map((p) => [p.longitude, p.latitude]) },
      });
      // Don't yank the camera away from a device the user is following.
      if (!followId) {
        const b = new maplibregl.LngLatBounds();
        history.forEach((p) => b.extend([p.longitude, p.latitude]));
        m.fitBounds(b, { padding: 60, maxZoom: 15 });
      }
    } else {
      src.setData(emptyLine());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history]);

  // One-shot pan to a device (e.g. the "Centre" button or selecting from the list).
  useEffect(() => {
    const m = map.current;
    if (!m || !focus) return;
    const pos = positions[focus.deviceId];
    if (!pos) return;
    m.easeTo({ center: [pos.longitude, pos.latitude], zoom: Math.max(m.getZoom(), 14), duration: 600 });
    // Intentionally keyed on the nonce only: re-centring on every position tick
    // is the `followId` effect's job, not this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  // Follow mode: keep the camera on the followed device as it moves. Keyed on
  // the followed device's coordinates (not the whole positions map) so it only
  // re-centres when that vehicle actually moves.
  const followPos = followId ? positions[followId] : undefined;
  useEffect(() => {
    const m = map.current;
    if (!m || !followPos) return;
    m.easeTo({ center: [followPos.longitude, followPos.latitude], duration: 800 });
  }, [followId, followPos?.longitude, followPos?.latitude]);

  /** Zoom out to fit every device currently on the map. */
  const fitAll = () => {
    const m = map.current;
    const list = Object.values(positions);
    if (!m || list.length === 0) return;
    const b = new maplibregl.LngLatBounds();
    list.forEach((p) => b.extend([p.longitude, p.latitude]));
    m.fitBounds(b, { padding: 80, maxZoom: 15, duration: 600 });
  };

  // Switch basemap by toggling raster-layer visibility (keeps custom layers).
  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    const visible = new Set(BASEMAP_VISIBLE[basemap]);
    for (const id of BASEMAP_LAYER_IDS) {
      if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', visible.has(id) ? 'visible' : 'none');
    }
  }, [basemap]);

  // Geofence drawing interaction.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const canvas = m.getCanvas();
    const setDraw = (data: GeoJSON.FeatureCollection) => {
      const s = m.getSource('draw') as maplibregl.GeoJSONSource | undefined;
      s?.setData(data);
    };
    if (drawMode === 'none') {
      canvas.style.cursor = '';
      setDraw(emptyCollection());
      return;
    }
    canvas.style.cursor = 'crosshair';
    m.doubleClickZoom.disable();

    let center: { lng: number; lat: number } | null = null;
    const verts: [number, number][] = [];

    const onClick = (e: maplibregl.MapMouseEvent) => {
      const { lng, lat } = e.lngLat;
      if (drawMode === 'circle') {
        if (!center) {
          center = { lng, lat };
        } else {
          const radiusM = Math.round(haversineMeters(center.lat, center.lng, lat, lng));
          onShapeDrawn({ kind: 'circle', centerLat: center.lat, centerLon: center.lng, radiusM });
          center = null;
          setDraw(emptyCollection());
        }
      } else {
        verts.push([lng, lat]);
        setDraw(drawPreview(verts));
      }
    };
    const onMove = (e: maplibregl.MapMouseEvent) => {
      const { lng, lat } = e.lngLat;
      if (drawMode === 'circle' && center) {
        setDraw(circlePreview(center.lng, center.lat, haversineMeters(center.lat, center.lng, lat, lng)));
      } else if (drawMode === 'polygon' && verts.length) {
        setDraw(drawPreview([...verts, [lng, lat]]));
      }
    };
    const onDblClick = (e: maplibregl.MapMouseEvent) => {
      if (drawMode !== 'polygon') return;
      e.preventDefault();
      const ring = verts.slice();
      while (ring.length >= 2 && ring[ring.length - 1][0] === ring[ring.length - 2][0] && ring[ring.length - 1][1] === ring[ring.length - 2][1]) ring.pop();
      if (ring.length >= 3) onShapeDrawn({ kind: 'polygon', ring });
      verts.length = 0;
      setDraw(emptyCollection());
    };

    m.on('click', onClick);
    m.on('mousemove', onMove);
    m.on('dblclick', onDblClick);
    return () => {
      m.off('click', onClick);
      m.off('mousemove', onMove);
      m.off('dblclick', onDblClick);
      m.doubleClickZoom.enable();
      canvas.style.cursor = '';
      setDraw(emptyCollection());
    };
  }, [drawMode, onShapeDrawn]);

  // Draw geofences.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    const src = m.getSource('geofences') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: geofences.map((g) => {
        const ring =
          g.kind === 'circle'
            ? circleToPolygon(g.centerLon, g.centerLat, g.radiusM)
            : [...g.ring, g.ring[0]];
        return { type: 'Feature', properties: { name: g.name }, geometry: { type: 'Polygon', coordinates: [ring] } };
      }),
    });
  }, [geofences]);

  // Playback marker position.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    const src = m.getSource('playback') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(
      playback
        ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [playback.longitude, playback.latitude] } }
        : emptyCollection(),
    );
  }, [playback]);

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" />
      {/* Basemap switcher */}
      <div className="absolute left-2 top-2 z-10 flex overflow-hidden rounded-md border border-border bg-surface/95 text-xs shadow-lg backdrop-blur">
        {BASEMAPS.map((b) => (
          <button
            key={b.id}
            onClick={() => setBasemap(b.id)}
            className={`px-2.5 py-1.5 transition-colors ${
              basemap === b.id ? 'bg-brand text-brand-fg' : 'text-fg hover:bg-surface-2'
            }`}
          >
            {b.label}
          </button>
        ))}
        <button
          onClick={fitAll}
          title="Zoom to fit all devices"
          className="border-l border-border px-2.5 py-1.5 text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          Fit all
        </button>
      </div>

      {/* Motion legend — the colours must be self-explaining on the map itself. */}
      <div
        aria-label="Vehicle status legend"
        className="pointer-events-none absolute bottom-8 right-2 z-10 flex items-center gap-3 rounded-lg border border-border bg-surface/90 px-2.5 py-1.5 text-[11px] text-fg-muted shadow-sm backdrop-blur"
      >
        {(['moving', 'stopped', 'parked', 'inactive'] as const).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full border border-white/70" style={{ background: MOTION_HEX[s] }} />
            {MOTION_LABEL[s]}
          </span>
        ))}
      </div>
    </div>
  );
}

function emptyLine(): GeoJSON.Feature {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } };
}
function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

/** Live preview for a circle being drawn (ring polygon + centre/edge vertices). */
function circlePreview(lon: number, lat: number, radiusM: number): GeoJSON.FeatureCollection {
  const ring = circleToPolygon(lon, lat, Math.max(radiusM, 1));
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } },
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lon, lat] } },
    ],
  };
}

/** Live preview for a polygon being drawn: a line (or filled polygon) + vertices. */
function drawPreview(verts: [number, number][]): GeoJSON.FeatureCollection {
  const points: GeoJSON.Feature[] = verts.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }));
  const shape: GeoJSON.Feature =
    verts.length >= 3
      ? { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...verts, verts[0]]] } }
      : { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: verts } };
  return { type: 'FeatureCollection', features: [shape, ...points] };
}
