'use client';
import { useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Card } from '@/components/ui';
import { ThemeToggle } from '@/components/ThemeToggle';
import { AssetGlyph } from '@/components/AssetTypePicker';
import { ASSET_LABEL, type AssetType } from '@/lib/asset-icons';
import { motionState, MOTION_HEX, MOTION_LABEL, type MotionState } from '@/lib/motion';
import { relativeTime } from '@/lib/format';
import type { Position } from '@/lib/types';

const isoDay = (offset: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

export default function OverviewPage() {
  const { ready, isAuthed } = useAuth();
  const router = useRouter();
  useEffect(() => { if (ready && !isAuthed) router.replace('/login'); }, [ready, isAuthed, router]);

  const devicesQuery = useQuery({ queryKey: ['devices'], queryFn: api.listDevices, enabled: isAuthed });
  const departmentsQuery = useQuery({ queryKey: ['departments'], queryFn: api.listDepartments, enabled: isAuthed, retry: false });
  const alertsQuery = useQuery({ queryKey: ['alerts', 'overview'], queryFn: () => api.listAlerts(undefined, 200), enabled: isAuthed });

  const devices = useMemo(() => devicesQuery.data ?? [], [devicesQuery.data]);

  // Latest position per device → live status snapshot.
  const positionsQuery = useQuery({
    queryKey: ['overview-positions', devices.map((d) => d.id).join(',')],
    enabled: isAuthed && devices.length > 0,
    queryFn: async () => {
      const list = await Promise.all(devices.map((d) => api.latest(d.id).then((p) => [d.id, p] as const).catch(() => [d.id, null] as const)));
      const map: Record<string, Position> = {};
      for (const [id, p] of list) if (p) map[id] = p;
      return map;
    },
  });
  const positions = positionsQuery.data ?? {};

  // Fleet activity over the last 7 days (distance / trips / overspeed).
  const fleetQuery = useQuery({
    queryKey: ['overview-fleet'],
    enabled: isAuthed,
    queryFn: () => api.report({ type: 'fleet', from: `${isoDay(-7)}T00:00:00Z`, to: `${isoDay(0)}T23:59:59Z` }),
  });

  // --- derived metrics --------------------------------------------------
  const now = Date.now();
  const statusCounts = useMemo(() => {
    const c: Record<MotionState, number> = { moving: 0, stopped: 0, parked: 0, inactive: 0 };
    for (const d of devices) c[motionState(d, positions[d.id], now)]++;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, positions]);

  const assetCounts = useMemo(() => {
    const c = new Map<AssetType, number>();
    for (const d of devices) c.set(d.assetType, (c.get(d.assetType) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [devices]);

  const alerts24h = useMemo(() => {
    const since = new Date(now - 24 * 3600_000).toISOString();
    const recent = (alertsQuery.data ?? []).filter((a) => a.ts >= since);
    const byType = new Map<string, number>();
    for (const a of recent) byType.set(a.type, (byType.get(a.type) ?? 0) + 1);
    return { total: recent.length, byType: [...byType.entries()].sort((a, b) => b[1] - a[1]) };
  }, [alertsQuery.data, now]);

  const movingSpeeds = devices
    .map((d) => positions[d.id])
    .filter((p): p is Position => !!p && p.speedKph > 0);
  const avgMovingSpeed = movingSpeeds.length
    ? Math.round(movingSpeeds.reduce((s, p) => s + p.speedKph, 0) / movingSpeeds.length)
    : 0;

  // Vehicles that need a look: inactive, or reporting but with no fix in a while.
  const needsAttention = devices
    .map((d) => ({ d, pos: positions[d.id], state: motionState(d, positions[d.id], now) }))
    .filter((x) => x.state === 'inactive')
    .sort((a, b) => (a.pos?.ts ?? '').localeCompare(b.pos?.ts ?? ''));

  const fleet = fleetQuery.data?.summary as { totalDistanceKm?: number; totalOverspeed?: number } | undefined;
  const totalTrips = (fleetQuery.data?.rows ?? []).reduce((s, r) => s + (Number(r.trips) || 0), 0);

  const total = devices.length;
  const loading = devicesQuery.isLoading || positionsQuery.isLoading;

  if (!ready) return null;

  return (
    <main className="min-h-full bg-bg">
      <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-brand text-brand-fg">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 3l6 16-6-3-6 3z" /></svg>
          </div>
          <span className="font-semibold tracking-tight">SwiftView</span>
          <span className="text-fg-muted">/ Overview</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/reports" className="rounded-lg px-2.5 py-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg">Reports</Link>
          <ThemeToggle />
          <Link href="/dashboard" className="rounded-lg px-2.5 py-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg">← Map</Link>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
        {/* Live status — the four states, clickable through to the filtered map */}
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Fleet status — now</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatTile label="Total devices" value={total} />
            {(['moving', 'stopped', 'parked', 'inactive'] as const).map((s) => (
              <Link key={s} href={`/dashboard?status=${s}`} className="block">
                <StatTile
                  label={MOTION_LABEL[s]}
                  value={statusCounts[s]}
                  dot={MOTION_HEX[s]}
                  sub={total ? `${Math.round((statusCounts[s] / total) * 100)}%` : undefined}
                />
              </Link>
            ))}
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-3">
          {/* Activity, last 7 days */}
          <Card className="p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Activity · last 7 days</h3>
            {fleetQuery.isLoading ? <Skeleton rows={3} /> : (
              <dl className="flex flex-col gap-3">
                <Metric label="Distance travelled" value={`${fleet?.totalDistanceKm ?? 0} km`} />
                <Metric label="Trips" value={String(totalTrips)} />
                <Metric label="Overspeed events" value={String(fleet?.totalOverspeed ?? 0)} accent={(fleet?.totalOverspeed ?? 0) > 0} />
                <Metric label="Avg speed (moving now)" value={`${avgMovingSpeed} km/h`} />
              </dl>
            )}
          </Card>

          {/* Alerts, last 24h */}
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Alerts · last 24h</h3>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${alerts24h.total ? 'bg-danger/10 text-danger' : 'bg-surface-2 text-fg-muted'}`}>{alerts24h.total}</span>
            </div>
            {alertsQuery.isLoading ? <Skeleton rows={3} /> : alerts24h.byType.length === 0 ? (
              <p className="text-sm text-fg-muted">No alerts in the last 24 hours.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {alerts24h.byType.map(([type, n]) => (
                  <li key={type} className="flex items-center justify-between">
                    <span className="capitalize text-fg-muted">{type.replace(/_/g, ' ')}</span>
                    <span className="font-medium tabular-nums text-fg">{n}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Fleet composition by asset type */}
          <Card className="p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Fleet composition</h3>
            {loading ? <Skeleton rows={3} /> : (
              <ul className="flex flex-col gap-2 text-sm">
                {assetCounts.map(([t, n]) => (
                  <li key={t} className="flex items-center gap-2">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-2 text-fg-muted"><AssetGlyph type={t} size={14} /></span>
                    <span className="text-fg-muted">{ASSET_LABEL[t]}</span>
                    <span className="ml-auto font-medium tabular-nums text-fg">{n}</span>
                  </li>
                ))}
                <li className="mt-1 flex items-center justify-between border-t border-border pt-2 text-xs text-fg-subtle">
                  <span>Groups</span><span>{departmentsQuery.data?.length ?? 0}</span>
                </li>
              </ul>
            )}
          </Card>
        </div>

        {/* Needs attention */}
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Needs attention · inactive devices</h3>
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-fg-muted">{needsAttention.length}</span>
          </div>
          {loading ? <Skeleton rows={3} /> : needsAttention.length === 0 ? (
            <p className="text-sm text-fg-muted">Every device is reporting. Nothing needs attention.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {needsAttention.slice(0, 12).map(({ d, pos }) => (
                <li key={d.id} className="flex items-center gap-3 py-2 text-sm">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-2 text-fg-muted"><AssetGlyph type={d.assetType} size={13} /></span>
                  <Link href={`/dashboard?device=${d.id}`} className="truncate font-medium text-fg hover:underline">{d.name?.trim() || d.model}</Link>
                  <span className="truncate font-mono text-xs text-fg-subtle">{d.imei}</span>
                  <span className="ml-auto shrink-0 text-xs text-fg-muted">
                    {pos ? `last fix ${relativeTime(pos.ts)}` : 'never reported'}
                  </span>
                </li>
              ))}
              {needsAttention.length > 12 && (
                <li className="py-2 text-xs text-fg-subtle">+ {needsAttention.length - 12} more</li>
              )}
            </ul>
          )}
        </Card>
      </div>
    </main>
  );
}

function StatTile({ label, value, dot, sub }: { label: string; value: number; dot?: string; sub?: string }) {
  return (
    <Card className="flex flex-col gap-1 p-4 transition-colors hover:border-brand/40">
      <div className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
        {dot && <span className="inline-block h-2.5 w-2.5 rounded-full ring-1 ring-white/70" style={{ background: dot }} />}
        {label}
      </div>
      <div className="text-3xl font-semibold tabular-nums text-fg">{value}</div>
      {sub && <div className="text-xs text-fg-subtle">{sub} of fleet</div>}
    </Card>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${accent ? 'text-danger' : 'text-fg'}`}>{value}</dd>
    </div>
  );
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="h-5 animate-pulse rounded bg-surface-2" />)}
    </div>
  );
}
