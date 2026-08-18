'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { Map as MlMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { DEFAULT_CENTER, DEFAULT_ZOOM, DEFAULT_BASEMAP } from '@/lib/config';
import { circleToPolygon, haversineMeters } from '@/lib/geo';
import { BASEMAPS, BASEMAP_LAYER_IDS, BASEMAP_VISIBLE, buildBaseStyle, type BasemapId } from '@/lib/basemaps';
import type { Position, Geofence, DrawMode, DrawnShape, Device } from '@/lib/types';
import { motionState, MOTION_HEX, MOTION_LABEL, type MotionState } from '@/lib/motion';
import { donutSvg } from '@/lib/cluster-donut';

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

  /**
   * Vehicle rendering — cluster-aware.
   *
   * All vehicles go into a clustered GeoJSON source. MapLibre does the spatial
   * work (which points merge at this zoom); we render DOM markers for whatever
   * the source currently yields: a status DONUT for a cluster (arcs = how many
   * vehicles are in each state, count in the middle), or a dot + NAME PILL for
   * a lone vehicle. `clusterProperties` sums per-state counts server-side in
   * the source, so each donut knows its own segments without us re-scanning.
   * Markers are keyed by cluster id / device id and diffed, so live updates
   * don't rebuild the DOM.
   */
  const vehicleFeatures = useMemo<GeoJSON.FeatureCollection>(() => {
    const now = Date.now();
    return {
      type: 'FeatureCollection',
      features: Object.entries(positions).map(([deviceId, pos]) => {
        const device = deviceById.get(deviceId);
        const state = motionState(device ?? ({ status: 'active' } as Device), pos, now);
        return {
          type: 'Feature',
          id: deviceId,
          properties: {
            deviceId, state,
            name: device?.name?.trim() || pos.imei,
            heading: pos.heading, speedKph: pos.speedKph,
            // one-hot per state, so clusterProperties can sum them
            moving: state === 'moving' ? 1 : 0, stopped: state === 'stopped' ? 1 : 0,
            parked: state === 'parked' ? 1 : 0, inactive: state === 'inactive' ? 1 : 0,
          },
          geometry: { type: 'Point', coordinates: [pos.longitude, pos.latitude] },
        };
      }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, deviceById, clock]);

  // Push features into the clustered source (created on first use).
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      const src = m.getSource('vehicles') as maplibregl.GeoJSONSource | undefined;
      if (src) { src.setData(vehicleFeatures); return; }
      m.addSource('vehicles', {
        type: 'geojson', data: vehicleFeatures,
        cluster: true, clusterRadius: 48, clusterMaxZoom: 17,
        clusterProperties: {
          moving: ['+', ['get', 'moving']], stopped: ['+', ['get', 'stopped']],
          parked: ['+', ['get', 'parked']], inactive: ['+', ['get', 'inactive']],
        },
      });
      // An invisible layer is required for the source to be "used" and querySourceFeatures to work.
      m.addLayer({ id: 'vehicles-anchor', type: 'circle', source: 'vehicles', paint: { 'circle-radius': 0, 'circle-opacity': 0 } });
    };
    // Don't gate on isStyleLoaded(): with raster basemaps it can stay false
    // long after 'load' has fired, and once('load') then never fires again —
    // the source would silently never be created. `ready` is set in the map's
    // own load handler; before that, wait for it. addSource itself is safe as
    // soon as the style object exists.
    if (ready.current) apply(); else m.once('load', apply);
  }, [vehicleFeatures]);

  // Render DOM markers from what the source yields at the current zoom.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const render = () => {
      if (!m.getSource('vehicles')) return;
      const feats = m.querySourceFeatures('vehicles');
      const seen = new Set<string>();
      // querySourceFeatures returns duplicates across tiles — dedupe by key.
      for (const f of feats) {
        const p = f.properties ?? {};
        const isCluster = !!p.cluster;
        const key = isCluster ? `c:${p.cluster_id}` : `d:${p.deviceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
        let marker = markers.current.get(key);
        if (!marker) {
          const el = document.createElement('div');
          el.className = isCluster ? 'fleet-cluster' : 'fleet-vehicle';
          if (isCluster) {
            const clusterId = p.cluster_id as number;
            // Click a donut → zoom to the level where it breaks apart.
            el.addEventListener('click', () => {
              const src = m.getSource('vehicles') as maplibregl.GeoJSONSource;
              src.getClusterExpansionZoom(clusterId).then((z) => m.easeTo({ center: [lng, lat], zoom: z, duration: 500 })).catch(() => {});
            });
          } else {
            const id = p.deviceId as string;
            el.addEventListener('click', () => onSelect(id));
          }
          marker = new maplibregl.Marker({ element: el, anchor: isCluster ? 'center' : 'bottom' }).setLngLat([lng, lat]).addTo(m);
          markers.current.set(key, marker);
        } else {
          marker.setLngLat([lng, lat]);
        }
        const el = marker.getElement();
        if (isCluster) {
          const counts = { moving: p.moving ?? 0, stopped: p.stopped ?? 0, parked: p.parked ?? 0, inactive: p.inactive ?? 0 };
          const { svg, total } = donutSvg(counts);
          const sig = `${total}|${counts.moving}|${counts.stopped}|${counts.parked}|${counts.inactive}`;
          if (el.dataset.sig !== sig) { el.innerHTML = svg; el.dataset.sig = sig; }
          el.title = `${total} vehicles — ${counts.moving} moving, ${counts.stopped} stopped, ${counts.parked} parked, ${counts.inactive} inactive`;
        } else {
          const state = p.state as MotionState;
          const name = String(p.name ?? '');
          const sig = `${name}|${state}|${p.heading}|${p.deviceId === selectedId}`;
          if (el.dataset.sig !== sig) {
            el.innerHTML =
              `<span class="fleet-pill">${escapeHtml(name)}</span>` +
              `<span class="fleet-dot" data-motion="${state}" style="--motion:${MOTION_HEX[state]};--rot:${p.heading}deg"></span>`;
            el.dataset.sig = sig;
          }
          el.dataset.selected = String(p.deviceId === selectedId);
          el.title = `${name} — ${MOTION_LABEL[state]}${state === 'moving' ? ` · ${p.speedKph} km/h` : ''}`;
        }
      }
      // Remove markers for clusters/devices no longer yielded (merged, split, or gone).
      for (const [key, marker] of markers.current) {
        if (!seen.has(key)) { marker.remove(); markers.current.delete(key); }
      }
    };
    render();
    // Clusters change with the camera, and the source only reports features
    // once its tiles are loaded — re-render on both.
    m.on('moveend', render);
    m.on('zoomend', render);
    m.on('sourcedata', render);
    return () => { m.off('moveend', render); m.off('zoomend', render); m.off('sourcedata', render); };
  }, [vehicleFeatures, selectedId, onSelect]);

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
      {/* Map toolbar — bottom-left, icon buttons. The layers icon opens the
          basemap menu upward so it never covers the map area above it. */}
      <MapToolbar
        basemap={basemap}
        onBasemap={setBasemap}
        onFitAll={fitAll}
        fitDisabled={Object.keys(positions).length === 0}
      />

      {/* Fleet status summary — legend + live counts, top-left. Slides right
          when the device card occupies that corner. */}
      <FleetStatus devices={devices} positions={positions} clock={clock} offsetForCard={!!selectedId} />
    </div>
  );
}

/**
 * Fleet status summary: one tile per motion state with a live count, using the
 * SAME classifier as the markers and the sidebar dots — so a tile's number is
 * exactly the number of dots of that colour on the map. Doubles as the legend.
 *
 * `clock` is the map's 30s ticker: "inactive" is time-based, so counts must
 * re-derive even when no new position arrives.
 */
function FleetStatus({
  devices, positions, clock, offsetForCard,
}: {
  devices: Device[];
  positions: Record<string, Position>;
  clock: number;
  /** the device detail card is open in the top-left; shift right of it */
  offsetForCard: boolean;
}) {
  const counts = useMemo(() => {
    const now = Date.now();
    const c: Record<MotionState, number> = { moving: 0, stopped: 0, parked: 0, inactive: 0 };
    for (const d of devices) c[motionState(d, positions[d.id], now)]++;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, positions, clock]);
  const total = devices.length;

  return (
    <div
      role="status"
      aria-label="Fleet status"
      // Inline `left`, not a Tailwind arbitrary class: a value that only appears
      // inside a template literal isn't seen by the JIT scanner and gets no CSS,
      // which left the summary sitting under the device card.
      // 0.5rem gap + 18rem card (w-72) + 0.5rem gap = 19rem.
      // No `transition-[left]`: with that class present, an inline `left` change
      // never took effect in Chrome (verified by removing the class live — the
      // element moved instantly). A snap is fine; a stuck summary is not.
      style={{ left: offsetForCard ? '19rem' : '0.5rem' }}
      className="pointer-events-none absolute top-2 z-10 flex items-stretch overflow-hidden rounded-xl border border-border bg-surface/95 shadow-lg backdrop-blur"
    >
      {(['moving', 'stopped', 'parked', 'inactive'] as const).map((s, i) => (
        <div
          key={s}
          className={`flex min-w-[5.25rem] flex-col items-center px-3 py-2 ${i > 0 ? 'border-l border-border' : ''}`}
          title={`${counts[s]} of ${total} ${MOTION_LABEL[s].toLowerCase()}`}
        >
          <span className="text-2xl font-semibold leading-none tabular-nums text-fg">{counts[s]}</span>
          <span className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-fg-muted">
            <span className="inline-block h-2.5 w-2.5 rounded-full ring-1 ring-white/70" style={{ background: MOTION_HEX[s] }} />
            {MOTION_LABEL[s]}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Bottom-left map toolbar. Compact icon buttons instead of a strip of labelled
 * tabs, so the map keeps its top edge clear. The basemap picker is a context
 * menu that opens UPWARD from the layers icon.
 */
function MapToolbar({
  basemap, onBasemap, onFitAll, fitDisabled,
}: {
  basemap: BasemapId;
  onBasemap: (id: BasemapId) => void;
  onFitAll: () => void;
  fitDisabled: boolean;
}) {
  const [layersOpen, setLayersOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape — standard menu hygiene.
  useEffect(() => {
    if (!layersOpen) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setLayersOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setLayersOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [layersOpen]);

  const current = BASEMAPS.find((b) => b.id === basemap)?.label ?? basemap;
  const btn = 'grid h-9 w-9 place-items-center text-fg transition-colors hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div ref={box} className="absolute bottom-8 left-2 z-10">
      {/* Upward context menu */}
      {layersOpen && (
        <div
          role="menu"
          aria-label="Map type"
          className="absolute bottom-full left-0 mb-1.5 min-w-40 overflow-hidden rounded-lg border border-border bg-surface/95 py-1 text-xs shadow-lg backdrop-blur"
        >
          <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Map type</div>
          {BASEMAPS.map((b) => (
            <button
              key={b.id}
              role="menuitemradio"
              aria-checked={basemap === b.id}
              onClick={() => { onBasemap(b.id); setLayersOpen(false); }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-2 ${
                basemap === b.id ? 'font-medium text-fg' : 'text-fg-muted'
              }`}
            >
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${basemap === b.id ? 'bg-brand' : 'bg-transparent'}`} />
              {b.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex overflow-hidden rounded-lg border border-border bg-surface/95 shadow-lg backdrop-blur">
        <button
          onClick={() => setLayersOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={layersOpen}
          aria-label={`Map type: ${current}`}
          title={`Map type: ${current}`}
          className={`${btn} ${layersOpen ? 'bg-surface-2' : ''}`}
        >
          {/* layers icon */}
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" aria-hidden>
            <path d="M12 3 2 8l10 5 10-5-10-5Z" />
            <path d="m2 12 10 5 10-5" />
            <path d="m2 16 10 5 10-5" />
          </svg>
        </button>
        <button
          onClick={onFitAll}
          disabled={fitDisabled}
          aria-label="Zoom to fit all vehicles"
          title="Zoom to fit all vehicles"
          className={`${btn} border-l border-border`}
        >
          {/* fit / frame icon */}
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 8V5a2 2 0 0 1 2-2h3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" />
            <path d="M21 16v3a2 2 0 0 1-2 2h-3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function escapeHtml(t: string): string {
  return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
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
