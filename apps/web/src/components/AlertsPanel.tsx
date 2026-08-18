'use client';
import type { AlertEvent, AlertType } from '@/lib/types';

const icon: Record<AlertType, string> = {
  overspeed: '🚀',
  ignition_on: '🔑',
  ignition_off: '⭘',
  geofence_enter: '📍',
  geofence_exit: '🚪',
  device_offline: '📴',
};
const tone: Record<AlertType, string> = {
  overspeed: 'text-danger',
  ignition_on: 'text-success',
  ignition_off: 'text-fg-muted',
  geofence_enter: 'text-warning',
  geofence_exit: 'text-warning',
  device_offline: 'text-danger',
};

export function AlertsPanel({
  alerts,
  open,
  imeiFor,
  onClear,
}: {
  alerts: AlertEvent[];
  open: boolean;
  imeiFor: (deviceId: string) => string;
  onClear: () => void;
}) {
  if (!open) return null;
  return (
    <div className="absolute right-0 top-0 z-10 flex h-full w-80 flex-col border-l border-border bg-surface/95 backdrop-blur">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="text-sm font-semibold">Alerts{alerts.length > 0 && <span className="ml-1.5 text-xs font-normal text-fg-muted">({alerts.length})</span>}</span>
        {alerts.length > 0 && (
          <button
            onClick={onClear}
            className="rounded-md px-2 py-1 text-xs font-medium text-fg-muted hover:bg-danger/10 hover:text-danger"
            title="Clear all alerts (admin)"
          >
            Clear
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {alerts.length === 0 && <p className="p-4 text-sm text-fg-muted">No alerts yet.</p>}
        {alerts.map((a) => (
          <div key={a.id} className="border-b border-border px-4 py-2">
            <div className="flex items-center justify-between">
              <span className={`text-sm font-medium ${tone[a.type]}`}>
                {icon[a.type]} {a.type.replace(/_/g, ' ')}
              </span>
              <span className="text-xs text-fg-muted">{new Date(a.ts).toLocaleTimeString()}</span>
            </div>
            <div className="text-xs text-fg-muted">{a.message}</div>
            <div className="font-mono text-[10px] text-fg-subtle">{imeiFor(a.deviceId)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
