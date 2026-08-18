'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLivePositions } from '@/lib/useLivePositions';
import { DeviceTree } from '@/components/DeviceTree';
import { DeviceDetail } from '@/components/DeviceDetail';
import { AddDeviceDialog } from '@/components/AddDeviceDialog';
import { AlertsPanel } from '@/components/AlertsPanel';
import { GeofencePanel } from '@/components/GeofencePanel';
import { Playback } from '@/components/Playback';
import { Button } from '@/components/ui';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useAction } from '@/components/Toast';
import type { Position, DrawMode, DrawnShape, Device, AssetType } from '@/lib/types';
import { motionState, type MotionState } from '@/lib/motion';

const MapView = dynamic(() => import('@/components/MapView').then((m) => m.MapView), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-fg-subtle">Loading map…</div>,
});

export default function Dashboard() {
  const { token, ready, isAuthed, logout } = useAuth();
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [playbackPos, setPlaybackPos] = useState<Position | null>(null);
  const [rightPanel, setRightPanel] = useState<'none' | 'alerts' | 'geofences'>('none');
  const [drawMode, setDrawMode] = useState<DrawMode>('none');
  const [pendingShape, setPendingShape] = useState<DrawnShape | null>(null);
  const [followId, setFollowId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ deviceId: string; nonce: number } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer
  const [addDeviceOpen, setAddDeviceOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [statusFilter, setStatusFilter] = useState<Set<MotionState>>(new Set());
  const toggleStatus = useCallback((sState: MotionState) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      next.has(sState) ? next.delete(sState) : next.add(sState);
      return next;
    });
  }, []);
  const clearStatus = useCallback(() => setStatusFilter(new Set()), []);
  const mainRef = useRef<HTMLElement>(null);
  const queryClient = useQueryClient();
  const run = useAction();

  useEffect(() => {
    if (ready && !isAuthed) router.replace('/login');
  }, [ready, isAuthed, router]);

  // Deep-links from the Overview page: ?status=<state> pre-applies the filter,
  // ?device=<id> selects a device. Read once on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const q = new URLSearchParams(window.location.search);
    const st = q.get('status');
    if (st && ['moving', 'stopped', 'parked', 'inactive'].includes(st)) setStatusFilter(new Set([st as MotionState]));
    const dev = q.get('device');
    if (dev) setSelectedId(dev);
    if (st || dev) window.history.replaceState(null, '', '/dashboard'); // clean the URL
  }, []);

  /**
   * Full-screen focus mode: hide the top menu and sidebar and let the map fill
   * the screen. Backed by the browser Fullscreen API so Esc exits natively;
   * fullscreenchange is the single source of truth, so the browser's own exit
   * (Esc, or leaving fullscreen any other way) and our button stay in sync.
   */
  useEffect(() => {
    const onChange = () => setFocusMode(document.fullscreenElement === mainRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFullscreen = useCallback(() => {
    const el = mainRef.current;
    if (!el) return;
    // Keyed on focusMode, not just document.fullscreenElement: when the browser
    // refused real fullscreen we're in the CSS-only fallback, where there is no
    // fullscreenElement — the exit button must still turn focus mode off.
    if (focusMode) {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      else setFocusMode(false);
    } else if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => setFocusMode(true)); // fall back to CSS-only
    } else {
      setFocusMode(true);
    }
  }, [focusMode]);
  // Esc must exit even when the browser Fullscreen API wasn't used (fallback path).
  useEffect(() => {
    if (!focusMode || document.fullscreenElement) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFocusMode(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusMode]);

  const devicesQuery = useQuery({ queryKey: ['devices'], queryFn: api.listDevices, enabled: isAuthed });
  const geofencesQuery = useQuery({ queryKey: ['geofences'], queryFn: api.listGeofences, enabled: isAuthed });
  const departmentsQuery = useQuery({ queryKey: ['departments'], queryFn: api.listDepartments, enabled: isAuthed, retry: false });
  const deletedQuery = useQuery({ queryKey: ['devices', 'deleted'], queryFn: api.listDeletedDevices, enabled: isAuthed, retry: false });

  const { positions, alerts, state, seed, seedAlerts } = useLivePositions(token);

  // Seed markers + recent alerts on load.
  useEffect(() => {
    const devices = devicesQuery.data;
    if (!devices?.length) return;
    Promise.all(devices.map((d) => api.latest(d.id).catch(() => null))).then((list) =>
      seed(list.filter((p): p is Position => !!p)),
    );
    api.listAlerts(undefined, 50).then(seedAlerts).catch(() => {});
  }, [devicesQuery.data, seed, seedAlerts]);

  const historyQuery = useQuery({
    queryKey: ['history', selectedId],
    enabled: !!selectedId,
    queryFn: () => {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - 24 * 3600_000).toISOString();
      return api.history(selectedId!, from, to);
    },
  });

  const imeiFor = useCallback(
    (deviceId: string) => devicesQuery.data?.find((d) => d.id === deviceId)?.imei ?? deviceId,
    [devicesQuery.data],
  );

  const onShapeDrawn = useCallback((shape: DrawnShape) => {
    setPendingShape(shape);
    setDrawMode('none');
  }, []);

  const refreshGeofences = () => queryClient.invalidateQueries({ queryKey: ['geofences'] });

  async function saveGeofence(name: string) {
    if (!pendingShape) return;
    const body = pendingShape.kind === 'circle'
      ? { name, kind: 'circle' as const, centerLat: pendingShape.centerLat, centerLon: pendingShape.centerLon, radiusM: pendingShape.radiusM }
      : { name, kind: 'polygon' as const, ring: pendingShape.ring };
    await run(async () => {
      await api.createGeofence(body);
      setPendingShape(null);
      await refreshGeofences();
    }, `Geofence “${name}” created`);
  }
  async function deleteGeofence(id: string) {
    await run(async () => {
      await api.deleteGeofence(id);
      await refreshGeofences();
    }, 'Geofence deleted');
  }

  const refreshGroups = () => queryClient.invalidateQueries({ queryKey: ['departments'] });

  async function createGroup(name: string, parentId: string | null) {
    await run(async () => {
      await api.createDepartment({ name, parentId });
      await refreshGroups();
    }, `Group “${name}” created`);
  }
  async function renameGroup(id: string, name: string) {
    await run(async () => {
      await api.updateDepartment(id, { name });
      await refreshGroups();
    }, `Group renamed to “${name}”`);
  }
  async function moveGroup(id: string, parentId: string | null) {
    await run(async () => {
      await api.updateDepartment(id, { parentId });
      await refreshGroups();
    }, parentId ? 'Group moved' : 'Group moved to top level');
  }
  /**
   * Deleting cascades to subgroups (org_unit.parent_id is ON DELETE CASCADE), so
   * confirm with the subtree size rather than a bare "are you sure?". Devices are
   * ON DELETE SET NULL — they survive as ungrouped.
   */
  async function deleteGroup(id: string) {
    const groups = departmentsQuery.data ?? [];
    const doomed = [id];
    for (let i = 0; i < doomed.length; i++) {
      for (const g of groups) if (g.parentId === doomed[i]) doomed.push(g.id);
    }
    const name = groups.find((g) => g.id === id)?.name ?? 'this group';
    const extra = doomed.length - 1;
    const msg = extra > 0
      ? `Delete “${name}” and its ${extra} subgroup${extra === 1 ? '' : 's'}? Devices inside become ungrouped.`
      : `Delete “${name}”? Devices inside become ungrouped.`;
    if (!window.confirm(msg)) return;
    await run(async () => {
      await api.deleteDepartment(id);
      await Promise.all([refreshGroups(), queryClient.invalidateQueries({ queryKey: ['devices'] })]);
    }, `Group “${name}” deleted`);
  }
  async function moveDevices(deviceIds: string[], departmentId: string | null) {
    const label = deviceIds.length === 1 ? 'Device' : `${deviceIds.length} devices`;
    await run(async () => {
      // Sequential: the API is per-device, and a burst of parallel writes against
      // the same tenant row buys nothing at sidebar-sized selections.
      for (const id of deviceIds) await api.assignDeviceDepartment(id, departmentId);
      await queryClient.invalidateQueries({ queryKey: ['devices'] });
    }, departmentId ? `${label} moved` : `${label} removed from group`);
  }
  async function setAssetType(deviceId: string, assetType: AssetType) {
    await run(async () => {
      await api.setAssetType(deviceId, assetType);
      await queryClient.invalidateQueries({ queryKey: ['devices'] });
    }, 'Icon updated');
  }
  async function clearAlerts() {
    if (!window.confirm(`Clear all ${alerts.length} alert${alerts.length === 1 ? '' : 's'}? This permanently deletes them.`)) return;
    await run(async () => {
      const { deleted } = await api.clearAlerts();
      seedAlerts([]); // empty the live panel immediately
      return deleted;
    }, 'Alerts cleared');
  }
  async function renameDevice(deviceId: string, name: string) {
    await run(async () => {
      await api.renameDevice(deviceId, name);
      await queryClient.invalidateQueries({ queryKey: ['devices'] });
    }, `Renamed to “${name}”`);
  }
  /**
   * Soft delete. The confirm says exactly what happens — the device is hidden
   * and stops reporting, but its history is kept and it can be restored —
   * because "delete" usually means gone forever and this deliberately doesn't.
   */
  async function deleteDevice(device: Device) {
    const label = device.name?.trim() || `${device.model} ${device.imei}`;
    if (!window.confirm(
      `Remove “${label}” from your fleet?

` +
      `It will disappear from the map and lists and the tracker will stop being accepted. ` +
      `Its position history, trips and alerts are kept, and you can restore it from “Recently deleted”.`,
    )) return;
    await run(async () => {
      await api.deleteDevice(device.id);
      if (selectedId === device.id) { setSelectedId(null); setFollowId(null); }
      await queryClient.invalidateQueries({ queryKey: ['devices'] }); // covers ['devices','deleted'] too
    }, `“${label}” removed — restore it any time from Recently deleted`);
  }
  async function restoreDevice(device: Device) {
    const label = device.name?.trim() || `${device.model} ${device.imei}`;
    await run(async () => {
      await api.restoreDevice(device.id);
      await queryClient.invalidateQueries({ queryKey: ['devices'] });
    }, `“${label}” restored`);
  }

  /**
   * Provision a tracker. Throws on failure so the dialog stays open with the
   * user's input intact — the error itself is surfaced as a toast (duplicate
   * IMEI, plan quota reached, insufficient role, …).
   */
  async function addDevice(input: { imei: string; model: string; name: string | null; departmentId: string | null; assetType: AssetType }) {
    const created = await api.createDevice(input);
    await queryClient.invalidateQueries({ queryKey: ['devices'] });
    setSelectedId(created.id);
    return created;
  }

  /** Selecting a device pans the map to it (and opens nothing else). */
  const selectDevice = useCallback((id: string) => {
    setSelectedId(id);
    setFocus({ deviceId: id, nonce: Date.now() });
    setSidebarOpen(false);
  }, []);

  const online = state === 'open';
  const deviceCount = devicesQuery.data?.length ?? 0;
  // Same classifier as the map markers and the fleet-status tiles, so this
  // number always equals the count of green dots (speed alone would call a
  // vehicle whose last fix was hours ago "moving").
  const movingCount = useMemo(
    () => (devicesQuery.data ?? []).filter((d) => motionState(d, positions[d.id]) === 'moving').length,
    [devicesQuery.data, positions],
  );
  const history = historyQuery.data ?? [];
  const selectedDevice = devicesQuery.data?.find((d) => d.id === selectedId) ?? null;
  const selectedGroup = departmentsQuery.data?.find((g) => g.id === selectedDevice?.departmentId)?.name;

  // Stop following when the selection changes or clears.
  useEffect(() => {
    if (followId && followId !== selectedId) setFollowId(null);
  }, [selectedId, followId]);

  if (!ready) return null;

  return (
    <main ref={mainRef} className="flex h-full flex-col bg-bg">
      <header className={`items-center justify-between gap-4 border-b border-border bg-surface px-4 py-2.5 ${focusMode ? 'hidden' : 'flex'}`}>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSidebarOpen((o) => !o)}
            aria-label="Toggle device list"
            className="-ml-1 rounded-lg px-2 py-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg md:hidden"
          >
            ☰
          </button>
          <div className="flex items-center gap-2">
            <div className="grid h-7 w-7 place-items-center rounded-lg bg-brand text-brand-fg">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 3l6 16-6-3-6 3z" /></svg>
            </div>
            <span className="font-semibold tracking-tight">SwiftView</span>
          </div>
          <span className="flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-1 text-xs text-fg-muted">
            <span className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-success' : 'bg-fg-subtle'}`} />
            {online ? 'Live' : state}
          </span>
          <div className="hidden items-center gap-3 text-xs text-fg-muted sm:flex">
            <span><span className="font-semibold text-fg">{deviceCount}</span> devices</span>
            <span><span className="font-semibold text-fg">{movingCount}</span> moving</span>
          </div>
        </div>

        <nav className="flex items-center gap-1 text-sm">
          <Link href="/overview" className="rounded-lg px-2.5 py-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg">Overview</Link>
          <Link href="/reports" className="rounded-lg px-2.5 py-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg">Reports</Link>
          <Link href="/settings" className="rounded-lg px-2.5 py-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg">Settings</Link>
          <button
            onClick={() => setRightPanel((p) => (p === 'geofences' ? 'none' : 'geofences'))}
            className={`rounded-lg px-2.5 py-1.5 hover:bg-surface-2 ${rightPanel === 'geofences' ? 'bg-surface-2 text-fg' : 'text-fg-muted hover:text-fg'}`}
          >
            Geofences
          </button>
          <button
            onClick={() => setRightPanel((p) => (p === 'alerts' ? 'none' : 'alerts'))}
            className={`relative rounded-lg px-2.5 py-1.5 hover:bg-surface-2 ${rightPanel === 'alerts' ? 'bg-surface-2 text-fg' : 'text-fg-muted hover:text-fg'}`}
          >
            Alerts
            {alerts.length > 0 && (
              <span className="ml-1 rounded-full bg-danger/10 px-1.5 text-xs font-medium text-danger">{alerts.length}</span>
            )}
          </button>
          <ThemeToggle className="ml-1" />
          <Button variant="outline" className="ml-1 py-1.5" onClick={() => { logout(); router.replace('/login'); }}>
            Sign out
          </Button>
        </nav>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {/* Mobile scrim */}
        {sidebarOpen && (
          <div className="absolute inset-0 z-20 bg-black/40 md:hidden" onClick={() => setSidebarOpen(false)} />
        )}
        <aside
          className={`absolute inset-y-0 left-0 z-30 w-72 shrink-0 border-r border-border bg-surface transition-transform md:static md:translate-x-0 ${
            sidebarOpen ? 'translate-x-0 shadow-lg' : '-translate-x-full'
          } ${focusMode ? 'hidden md:hidden' : ''}`}
        >
          <DeviceTree
            devices={devicesQuery.data ?? []}
            positions={positions}
            departments={departmentsQuery.data ?? []}
            selectedId={selectedId}
            loading={devicesQuery.isLoading}
            onSelect={selectDevice}
            onCreateGroup={createGroup}
            onRenameGroup={renameGroup}
            onMoveGroup={moveGroup}
            onDeleteGroup={deleteGroup}
            onMoveDevices={moveDevices}
            onRenameDevice={renameDevice}
            onDeleteDevice={deleteDevice}
            onRestoreDevice={restoreDevice}
            deletedDevices={deletedQuery.data ?? []}
            statusFilter={statusFilter}
            onAddDevice={() => { setAddDeviceOpen(true); setSidebarOpen(false); }}
          />
        </aside>
        <section className="relative min-w-0 flex-1">
          <MapView
            positions={positions}
            devices={devicesQuery.data ?? []}
            selectedId={selectedId}
            history={history}
            geofences={geofencesQuery.data ?? []}
            playback={playbackPos}
            drawMode={drawMode}
            followId={followId}
            focus={focus}
            onSelect={selectDevice}
            onShapeDrawn={onShapeDrawn}
            fullscreen={focusMode}
            onToggleFullscreen={toggleFullscreen}
            statusFilter={statusFilter}
            onToggleStatus={toggleStatus}
            onClearStatus={clearStatus}
          />
          {selectedDevice && drawMode === 'none' && !pendingShape && (
            <DeviceDetail
              device={selectedDevice}
              position={positions[selectedDevice.id]}
              groupName={selectedGroup}
              following={followId === selectedDevice.id}
              onRename={(name) => renameDevice(selectedDevice.id, name)}
              onAssetType={(t) => setAssetType(selectedDevice.id, t)}
              onCenter={() => setFocus({ deviceId: selectedDevice.id, nonce: Date.now() })}
              onToggleFollow={() => setFollowId((f) => (f === selectedDevice.id ? null : selectedDevice.id))}
              onClose={() => { setSelectedId(null); setFollowId(null); }}
            />
          )}
          {selectedId && drawMode === 'none' && !pendingShape && <Playback history={history} onScrub={setPlaybackPos} />}
          <AlertsPanel alerts={alerts} open={rightPanel === 'alerts'} imeiFor={imeiFor} onClear={clearAlerts} />
          <GeofencePanel
            open={rightPanel === 'geofences'}
            geofences={geofencesQuery.data ?? []}
            drawMode={drawMode}
            pending={pendingShape}
            onDraw={(mode) => { setRightPanel('geofences'); setDrawMode(mode); }}
            onCancelDraw={() => setDrawMode('none')}
            onSave={saveGeofence}
            onDiscard={() => setPendingShape(null)}
            onDelete={deleteGeofence}
          />
        </section>
      </div>

      <AddDeviceDialog
        open={addDeviceOpen}
        departments={departmentsQuery.data ?? []}
        onClose={() => setAddDeviceOpen(false)}
        onCreate={async (input) => {
          // Let failures propagate so the dialog stays open; `run` toasts them.
          const ok = await run(() => addDevice(input), `Device “${input.name || input.imei}” added`);
          if (!ok) throw new Error('failed');
        }}
      />
    </main>
  );
}
