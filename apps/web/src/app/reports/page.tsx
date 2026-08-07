'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api, type ReportParams } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button, Card } from '@/components/ui';
import type { ExportFormat, ReportType } from '@/lib/types';

const TYPES: { id: ReportType; label: string; perDevice: boolean }[] = [
  { id: 'summary', label: 'Device summary', perDevice: true },
  { id: 'trips', label: 'Trips', perDevice: true },
  { id: 'speeding', label: 'Speeding events', perDevice: true },
  { id: 'geofence', label: 'Geofence activity', perDevice: true },
  { id: 'fleet', label: 'Fleet summary', perDevice: false },
];

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);

export default function ReportsPage() {
  const { ready, isAuthed } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (ready && !isAuthed) router.replace('/login');
  }, [ready, isAuthed, router]);

  const devicesQuery = useQuery({ queryKey: ['devices'], queryFn: api.listDevices, enabled: isAuthed });

  const [type, setType] = useState<ReportType>('summary');
  const [deviceId, setDeviceId] = useState('');
  const [from, setFrom] = useState(isoDay(-7));
  const [to, setTo] = useState(isoDay(0));
  const [submitted, setSubmitted] = useState<ReportParams | null>(null);
  const [downloading, setDownloading] = useState<ExportFormat | null>(null);

  const perDevice = TYPES.find((t) => t.id === type)!.perDevice;
  // Default the device selection once devices load.
  useEffect(() => {
    if (!deviceId && devicesQuery.data?.length) setDeviceId(devicesQuery.data[0].id);
  }, [devicesQuery.data, deviceId]);

  const params: ReportParams = useMemo(
    () => ({ type, deviceId: perDevice ? deviceId : undefined, from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z` }),
    [type, deviceId, perDevice, from, to],
  );

  const reportQuery = useQuery({
    queryKey: ['report', submitted],
    enabled: !!submitted,
    queryFn: () => api.report(submitted!),
  });

  const canRun = !perDevice || !!deviceId;

  async function download(format: ExportFormat) {
    setDownloading(format);
    try {
      const blob = await api.downloadExport(submitted ?? params, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(submitted ?? params).type}-${from}_${to}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(null);
    }
  }

  if (!ready) return null;
  const report = reportQuery.data;

  return (
    <main className="mx-auto flex h-full max-w-5xl flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded bg-brand" />
          <span className="font-semibold">FleetView</span>
          <span className="text-fg-muted">/ Reports</span>
        </div>
        <Link href="/dashboard" className="text-sm text-fg-muted hover:text-fg">
          ← Back to map
        </Link>
      </header>

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Report
          <select
            value={type}
            onChange={(e) => setType(e.target.value as ReportType)}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
          >
            {TYPES.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </label>

        {perDevice && (
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Device
            <select
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
            >
              {(devicesQuery.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>{d.model} · {d.imei}</option>
              ))}
            </select>
          </label>
        )}

        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg" />
        </label>

        <Button disabled={!canRun} onClick={() => setSubmitted(params)}>Generate</Button>

        {report && (
          <div className="ml-auto flex items-end gap-2">
            {(['csv', 'xlsx', 'pdf'] as ExportFormat[]).map((f) => (
              <Button key={f} variant="ghost" disabled={!!downloading} onClick={() => download(f)}
                className="border border-border">
                {downloading === f ? '…' : f.toUpperCase()}
              </Button>
            ))}
          </div>
        )}
      </Card>

      {reportQuery.isLoading && <p className="text-sm text-fg-muted">Generating…</p>}
      {reportQuery.isError && <p className="text-sm text-danger">Failed to generate report.</p>}

      {report && (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="font-semibold">{report.title}</h2>
            <span className="text-xs text-fg-muted">
              {report.range.from.slice(0, 10)} → {report.range.to.slice(0, 10)}
            </span>
          </div>
          <div className="max-h-[50vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface text-left text-xs text-fg-muted">
                <tr>{report.columns.map((c) => <th key={c.key} className="px-4 py-2 font-medium">{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {report.rows.length === 0 && (
                  <tr><td colSpan={report.columns.length} className="px-4 py-6 text-center text-fg-muted">No data in this range.</td></tr>
                )}
                {report.rows.map((row, i) => (
                  <tr key={i} className="border-t border-border">
                    {report.columns.map((c) => <td key={c.key} className="px-4 py-1.5 text-fg">{row[c.key]}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-4 border-t border-border px-4 py-3 text-xs text-fg-muted">
            {Object.entries(report.summary).map(([k, v]) => (
              <span key={k}><span className="text-fg-muted">{k}:</span> <span className="text-fg">{v}</span></span>
            ))}
          </div>
        </Card>
      )}
    </main>
  );
}
