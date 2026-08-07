'use client';
import { useEffect, useRef, useState } from 'react';
import { Badge } from './ui';
import { relativeTime, isStale, formatCoords, compass } from '@/lib/format';
import type { Device, Position } from '@/lib/types';

const statusTone: Record<string, string> = {
  active: 'green', provisioned: 'amber', suspended: 'red', retired: 'slate',
};

/**
 * Detail card for the selected device: live telemetry, inline rename, and map
 * actions (centre / follow). Sits top-left over the map, under the basemap
 * switcher.
 */
export function DeviceDetail({
  device, position, groupName, following,
  onRename, onCenter, onToggleFollow, onClose,
}: {
  device: Device;
  position: Position | undefined;
  groupName: string | undefined;
  following: boolean;
  onRename: (name: string) => Promise<void>;
  onCenter: () => void;
  onToggleFollow: () => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Re-render each second so "last seen" stays honest.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { setEditing(false); }, [device.id]);

  async function commit() {
    const name = draft.trim();
    if (!name || name === (device.name ?? '')) { setEditing(false); return; }
    setSaving(true);
    try {
      await onRename(name);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  const stale = position ? isStale(position.ts) : false;

  return (
    <div className="absolute left-2 top-14 z-10 w-72 overflow-hidden rounded-xl border border-border bg-surface/95 shadow-lg backdrop-blur">
      <div className="flex items-start gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              ref={inputRef}
              autoFocus
              value={draft}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commit();
                if (e.key === 'Escape') setEditing(false);
              }}
              className="w-full rounded-md border border-brand bg-surface px-1.5 py-0.5 text-sm font-semibold text-fg outline-none"
            />
          ) : (
            <button
              onClick={() => { setDraft(device.name ?? ''); setEditing(true); }}
              title="Rename device"
              className="group flex w-full items-center gap-1 text-left"
            >
              <span className="truncate text-sm font-semibold text-fg">{device.name?.trim() || device.model}</span>
              <span className="shrink-0 text-xs text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100">✎</span>
            </button>
          )}
          <div className="mt-0.5 truncate font-mono text-[11px] text-fg-subtle">{device.model} · {device.imei}</div>
        </div>
        <button onClick={onClose} aria-label="Close" className="rounded-md px-1 text-fg-subtle hover:bg-surface-2 hover:text-fg">✕</button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <Badge tone={statusTone[device.status]}>{device.status}</Badge>
        {groupName && <Badge tone="brand">{groupName}</Badge>}
        {stale && <Badge tone="amber">stale</Badge>}
      </div>

      {position ? (
        <>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 px-3 py-2.5 text-xs">
            <Stat label="Speed" value={`${position.speedKph} km/h`} accent={position.speedKph > 0} />
            <Stat label="Ignition" value={position.ignition ? 'On' : 'Off'} accent={!!position.ignition} />
            <Stat label="Heading" value={`${compass(position.heading)} · ${Math.round(position.heading)}°`} />
            <Stat label="Satellites" value={String(position.satellites)} />
          </dl>
          <div className="border-t border-border px-3 py-2 text-[11px] text-fg-muted">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono">{formatCoords(position.latitude, position.longitude)}</span>
              <span className={stale ? 'text-warning' : ''}>{relativeTime(position.ts)}</span>
            </div>
          </div>
        </>
      ) : (
        <p className="px-3 py-4 text-center text-xs text-fg-muted">Waiting for the first position…</p>
      )}

      <div className="flex gap-1.5 border-t border-border p-2">
        <button
          onClick={onCenter}
          disabled={!position}
          className="flex-1 rounded-lg border border-border px-2 py-1.5 text-xs font-medium text-fg hover:bg-surface-2 disabled:opacity-40"
        >
          Centre
        </button>
        <button
          onClick={onToggleFollow}
          disabled={!position}
          aria-pressed={following}
          className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 ${
            following ? 'bg-brand text-brand-fg' : 'border border-border text-fg hover:bg-surface-2'
          }`}
        >
          {following ? 'Following' : 'Follow'}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-fg-subtle">{label}</dt>
      <dd className={`font-medium ${accent ? 'text-success' : 'text-fg'}`}>{value}</dd>
    </div>
  );
}
