'use client';
import { useMemo, useState } from 'react';
import { Badge, Button, Input } from './ui';
import { relativeTime, isStale } from '@/lib/format';
import type { Device, Position, Department } from '@/lib/types';

const statusTone: Record<string, string> = {
  active: 'green',
  provisioned: 'amber',
  suspended: 'red',
  retired: 'slate',
};

export function displayName(d: Device): string {
  return d.name?.trim() || d.model;
}

/** Case-insensitive match across name, IMEI, model, status and group name. */
function matches(d: Device, groupName: string | undefined, q: string): boolean {
  const hay = `${d.name ?? ''} ${d.imei} ${d.model} ${d.status} ${groupName ?? ''}`.toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

export function DeviceList({
  devices, positions, departments, selectedId, loading = false,
  onSelect, onCreateGroup, onAssignGroup,
}: {
  devices: Device[];
  positions: Record<string, Position>;
  departments: Department[];
  selectedId: string | null;
  loading?: boolean;
  onSelect: (id: string) => void;
  onCreateGroup: (name: string) => Promise<void>;
  onAssignGroup: (deviceId: string, departmentId: string | null) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const groupName = (id: string | null) => departments.find((g) => g.id === id)?.name;
  const q = query.trim().toLowerCase();

  // Filter, then bucket by group. Groups always listed (even empty) unless searching.
  const { grouped, ungrouped, visibleCount } = useMemo(() => {
    const filtered = q ? devices.filter((d) => matches(d, groupName(d.departmentId), q)) : devices;
    const byGroup = new Map<string, Device[]>();
    const none: Device[] = [];
    for (const d of filtered) {
      if (d.departmentId && departments.some((g) => g.id === d.departmentId)) {
        const arr = byGroup.get(d.departmentId) ?? [];
        arr.push(d);
        byGroup.set(d.departmentId, arr);
      } else none.push(d);
    }
    return { grouped: byGroup, ungrouped: none, visibleCount: filtered.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, departments, q]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function createGroup() {
    if (!newName.trim()) return;
    setError(null);
    try {
      await onCreateGroup(newName.trim());
      setNewName('');
      setAdding(false);
    } catch {
      setError('Could not create group (admin only).');
    }
  }

  const renderDevice = (d: Device) => {
    const pos = positions[d.id];
    const selected = d.id === selectedId;
    return (
      <div key={d.id} className={`rounded-xl border transition-all ${
        selected ? 'border-brand bg-brand/5 ring-1 ring-brand/30' : 'border-border bg-surface hover:border-brand/40 hover:shadow-sm'
      }`}>
        <button onClick={() => onSelect(d.id)} className="w-full p-3 text-left">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium text-fg">{displayName(d)}</span>
            <Badge tone={statusTone[d.status]}>{d.status}</Badge>
          </div>
          <div className="mt-0.5 font-mono text-xs text-fg-subtle">{d.model} · {d.imei}</div>
          {pos ? (
            <div className="mt-2 flex items-center gap-3 text-xs text-fg-muted">
              <span className="font-medium text-fg">{pos.speedKph} <span className="font-normal text-fg-muted">km/h</span></span>
              <span className={pos.ignition ? 'text-success' : 'text-fg-subtle'}>{pos.ignition ? '● ignition on' : '○ off'}</span>
              <span
              className={`ml-auto ${isStale(pos.ts) ? 'text-warning' : 'text-fg-subtle'}`}
              title={new Date(pos.ts).toLocaleString()}
            >
              {relativeTime(pos.ts)}
            </span>
            </div>
          ) : (
            <div className="mt-2 text-xs text-fg-subtle">no position yet</div>
          )}
        </button>
        {selected && (
          <div className="flex items-center gap-2 border-t border-border px-3 py-2">
            <span className="text-xs text-fg-muted">Group</span>
            <select
              value={d.departmentId ?? ''}
              onChange={(e) => void onAssignGroup(d.id, e.target.value || null)}
              className="min-w-0 flex-1 rounded-md border border-border bg-surface px-1.5 py-1 text-xs text-fg"
            >
              <option value="">— none —</option>
              {departments.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
        )}
      </div>
    );
  };

  const renderGroup = (id: string, name: string, list: Device[]) => {
    const isCollapsed = collapsed.has(id) && !q; // search expands everything
    if (q && list.length === 0) return null; // hide empty groups while searching
    return (
      <div key={id}>
        <button
          onClick={() => toggle(id)}
          className="flex w-full items-center gap-1.5 rounded-md px-1 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle hover:text-fg"
        >
          <span className={`inline-block transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>▸</span>
          <span className="truncate">{name}</span>
          <span className="ml-auto rounded-full bg-surface-2 px-1.5 font-medium normal-case text-fg-muted">{list.length}</span>
        </button>
        {!isCollapsed && (
          <div className="mb-2 flex flex-col gap-2">
            {list.length === 0
              ? <p className="px-2 pb-1 text-xs text-fg-subtle">No devices in this group.</p>
              : list.map(renderDevice)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Devices</span>
          <button onClick={() => { setAdding((a) => !a); setError(null); }}
            className="rounded-md px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg">
            + New group
          </button>
        </div>
        <Input
          type="search"
          placeholder="Search name, IMEI, model, status…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="py-1.5 text-xs"
        />
        {adding && (
          <div className="flex gap-1.5">
            <Input autoFocus placeholder="Group name" value={newName} className="py-1.5 text-xs"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void createGroup(); }} />
            <Button className="px-2.5 py-1.5 text-xs" disabled={!newName.trim()} onClick={() => void createGroup()}>Add</Button>
          </div>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
        {q && <p className="text-xs text-fg-subtle">{visibleCount} match{visibleCount === 1 ? '' : 'es'}</p>}
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {loading && devices.length === 0 && (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading devices">
            {[0, 1, 2].map((i) => (
              <div key={i} className="animate-pulse rounded-xl border border-border bg-surface p-3">
                <div className="h-3.5 w-2/3 rounded bg-surface-2" />
                <div className="mt-2 h-2.5 w-1/2 rounded bg-surface-2" />
                <div className="mt-3 h-2.5 w-1/3 rounded bg-surface-2" />
              </div>
            ))}
          </div>
        )}
        {!loading && devices.length === 0 && (
          <p className="px-1 text-sm text-fg-muted">No devices yet. Provision one in Settings or via the API.</p>
        )}
        {departments.length === 0 ? (
          <div className="flex flex-col gap-2">{ungrouped.map(renderDevice)}</div>
        ) : (
          <>
            {departments.map((g) => renderGroup(g.id, g.name, grouped.get(g.id) ?? []))}
            {ungrouped.length > 0 && renderGroup('__none__', 'Ungrouped', ungrouped)}
          </>
        )}
        {q && visibleCount === 0 && devices.length > 0 && (
          <p className="px-1 pt-2 text-sm text-fg-muted">No devices match “{query}”.</p>
        )}
      </div>
    </div>
  );
}
