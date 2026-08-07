'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLivePositions } from '@/lib/useLivePositions';
import { DeviceList } from '@/components/DeviceList';
import { DeviceDetail } from '@/components/DeviceDetail';
import { AlertsPanel } from '@/components/AlertsPanel';
import { GeofencePanel } from '@/components/GeofencePanel';
import { Playback } from '@/components/Playback';
import { Button } from '@/components/ui';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useAction } from '@/components/Toast';
import type { Position, DrawMode, DrawnShape } from '@/lib/types';

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
  const queryClient = useQueryClient();
  const run = useAction();

  useEffect(() => {
    if (ready && !isAuthed) router.replace('/login');
  }, [ready, isAuthed, router]);

  const devicesQuery = useQuery({ queryKey: ['devices'], queryFn: api.listDevices, enabled: isAuthed });
  const geofencesQuery = useQuery({ queryKey: ['geofences'], queryFn: api.listGeofences, enabled: isAuthed });
  const departmentsQuery = useQuery({ queryKey: ['departments'], queryFn: api.listDepartments, enabled: isAuthed, retry: false });

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

  async function createGroup(name: string) {
    const ok = await run(async () => {
      await api.createDepartment({ name });
      await queryClient.invalidateQueries({ queryKey: ['departments'] });
    }, `Group “${name}” created`);
    if (!ok) throw new Error('failed'); // let the sidebar surface its inline error too
  }
  async function assignGroup(deviceId: string, departmentId: string | null) {
    await run(async () => {
      await api.assignDeviceDepartment(deviceId, departmentId);
      await queryClient.invalidateQueries({ queryKey: ['devices'] });
    }, departmentId ? 'Device moved' : 'Device removed from group');
  }
  async function renameDevice(deviceId: string, name: string) {
    await run(async () => {
      await api.renameDevice(deviceId, name);
      await queryClient.invalidateQueries({ queryKey: ['devices'] });
    }, `Renamed to “${name}”`);
  }

  /** Selecting a device pans the map to it (and opens nothing else). */
  const selectDevice = useCallback((id: string) => {
    setSelectedId(id);
    setFocus({ deviceId: id, nonce: Date.now() });
    setSidebarOpen(false);
  }, []);

  const online = state === 'open';
  const deviceCount = devicesQuery.data?.length ?? 0;
  const movingCount = useMemo(() => Object.values(positions).filter((p) => p.speedKph > 0).length, [positions]);
  const history = historyQuery.data ?? [];
  const selectedDevice = devicesQuery.data?.find((d) => d.id === selectedId) ?? null;
  const selectedGroup = departmentsQuery.data?.find((g) => g.id === selectedDevice?.departmentId)?.name;

  // Stop following when the selection changes or clears.
  useEffect(() => {
    if (followId && followId !== selectedId) setFollowId(null);
  }, [selectedId, followId]);

  if (!ready) return null;

  return (
    <main className="flex h-full flex-col bg-bg">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-surface px-4 py-2.5">
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
            <span className="font-semibold tracking-tight">FleetView</span>
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
          }`}
        >
          <DeviceList
            devices={devicesQuery.data ?? []}
            positions={positions}
            departments={departmentsQuery.data ?? []}
            selectedId={selectedId}
            loading={devicesQuery.isLoading}
            onSelect={selectDevice}
            onCreateGroup={createGroup}
            onAssignGroup={assignGroup}
          />
        </aside>
        <section className="relative min-w-0 flex-1">
          <MapView
            positions={positions}
            selectedId={selectedId}
            history={history}
            geofences={geofencesQuery.data ?? []}
            playback={playbackPos}
            drawMode={drawMode}
            followId={followId}
            focus={focus}
            onSelect={selectDevice}
            onShapeDrawn={onShapeDrawn}
          />
          {selectedDevice && drawMode === 'none' && !pendingShape && (
            <DeviceDetail
              device={selectedDevice}
              position={positions[selectedDevice.id]}
              groupName={selectedGroup}
              following={followId === selectedDevice.id}
              onRename={(name) => renameDevice(selectedDevice.id, name)}
              onCenter={() => setFocus({ deviceId: selectedDevice.id, nonce: Date.now() })}
              onToggleFollow={() => setFollowId((f) => (f === selectedDevice.id ? null : selectedDevice.id))}
              onClose={() => { setSelectedId(null); setFollowId(null); }}
            />
          )}
          {selectedId && drawMode === 'none' && !pendingShape && <Playback history={history} onScrub={setPlaybackPos} />}
          <AlertsPanel alerts={alerts} open={rightPanel === 'alerts'} imeiFor={imeiFor} />
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
    </main>
  );
}
