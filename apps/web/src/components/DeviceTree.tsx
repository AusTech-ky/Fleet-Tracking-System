'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input } from './ui';
import { relativeTime, isStale } from '@/lib/format';
import type { Device, Position, Department } from '@/lib/types';

export function displayName(d: Device): string {
  return d.name?.trim() || d.model;
}

/** Pseudo-group id for devices with no department. Never sent to the API as-is. */
const UNGROUPED = '__ungrouped__';

/**
 * Indent geometry, in px. A group row spends its first ~16px on the chevron, so
 * a device indented by one plain step would put its checkbox at the same x as
 * its parent's — the nesting reads as flat. DEVICE_INSET steps devices past the
 * chevron *and* one level in, landing them level with a subgroup at the same
 * depth, which is what they are.
 */
const INDENT = 16;
const ROW_PAD = 4;
const DEVICE_INSET = 32;
const groupPad = (depth: number) => depth * INDENT + ROW_PAD;
const devicePad = (depth: number) => depth * INDENT + ROW_PAD + DEVICE_INSET;

/** What a drag is carrying. Kept in a ref — dataTransfer is only used to satisfy HTML5 DnD. */
type DragPayload =
  | { kind: 'devices'; ids: string[] }
  | { kind: 'group'; id: string };

interface TreeNode {
  id: string;
  name: string;
  /** Ungrouped is a rendering convenience, not a real group: no rename/delete/re-parent. */
  real: boolean;
  children: TreeNode[];
  devices: Device[];
  /** Devices in this node *and* everything beneath it — what the count badge shows. */
  subtreeDevices: Device[];
}

function statusDot(d: Device, pos: Position | undefined): { cls: string; title: string } {
  if (d.status === 'suspended' || d.status === 'retired') return { cls: 'bg-danger', title: d.status };
  if (!pos) return { cls: 'bg-fg-subtle/40', title: 'no position yet' };
  if (isStale(pos.ts)) return { cls: 'bg-warning', title: `stale — last fix ${relativeTime(pos.ts)}` };
  if (pos.speedKph > 0) return { cls: 'bg-success', title: `moving — ${pos.speedKph} km/h` };
  return { cls: 'bg-success/50', title: 'stopped' };
}

/** Checkbox that can render the third, "some but not all" state. */
function TriCheck({
  state, onChange, label,
}: {
  state: 'on' | 'off' | 'partial';
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'partial';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={state === 'on'}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      className="h-3.5 w-3.5 shrink-0 accent-brand"
    />
  );
}

/** Small popover anchored under its trigger. Closes on outside click or Escape. */
function RowMenu({ items }: { items: Array<{ label: string; onClick: () => void; danger?: boolean }> }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div ref={box} className="relative shrink-0">
      <button
        aria-label="Actions"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className={`rounded px-1 text-fg-subtle hover:bg-surface-2 hover:text-fg ${open ? 'bg-surface-2 text-fg' : ''}`}
      >
        ⋮
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-0.5 min-w-36 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-lg">
          {items.map((it) => (
            <button
              key={it.label}
              onClick={(e) => { e.stopPropagation(); setOpen(false); it.onClick(); }}
              className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-surface-2 ${
                it.danger ? 'text-danger' : 'text-fg'
              }`}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DeviceTree({
  devices, positions, departments, selectedId, loading = false,
  onSelect, onCreateGroup, onRenameGroup, onMoveGroup, onDeleteGroup, onMoveDevices, onRenameDevice, onAddDevice,
}: {
  devices: Device[];
  positions: Record<string, Position>;
  departments: Department[];
  selectedId: string | null;
  loading?: boolean;
  onSelect: (id: string) => void;
  onCreateGroup: (name: string, parentId: string | null) => Promise<void>;
  onRenameGroup: (id: string, name: string) => Promise<void>;
  onMoveGroup: (id: string, parentId: string | null) => Promise<void>;
  onDeleteGroup: (id: string) => Promise<void>;
  onMoveDevices: (deviceIds: string[], departmentId: string | null) => Promise<void>;
  onRenameDevice: (deviceId: string, name: string) => Promise<void>;
  onAddDevice: () => void;
}) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [addingUnder, setAddingUnder] = useState<string | null | undefined>(undefined); // undefined = not adding
  const [draftName, setDraftName] = useState('');
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const drag = useRef<DragPayload | null>(null);

  const q = query.trim().toLowerCase();

  const matches = (d: Device) => {
    const hay = `${d.name ?? ''} ${d.imei} ${d.model} ${d.status}`.toLowerCase();
    return q.split(/\s+/).every((t) => hay.includes(t));
  };

  // ---- build the tree ------------------------------------------------------
  const { roots, allDevices } = useMemo(() => {
    const visible = q ? devices.filter(matches) : devices;
    const known = new Set(departments.map((g) => g.id));

    const byParent = new Map<string, Department[]>();
    for (const g of departments) {
      // Defensive: a group whose parent vanished is shown at the root rather than lost.
      const key = g.parentId && known.has(g.parentId) ? g.parentId : '';
      byParent.set(key, [...(byParent.get(key) ?? []), g]);
    }

    const devicesByGroup = new Map<string, Device[]>();
    for (const d of visible) {
      const key = d.departmentId && known.has(d.departmentId) ? d.departmentId : UNGROUPED;
      devicesByGroup.set(key, [...(devicesByGroup.get(key) ?? []), d]);
    }

    const build = (g: Department): TreeNode => {
      const children = (byParent.get(g.id) ?? []).map(build);
      const own = devicesByGroup.get(g.id) ?? [];
      return {
        id: g.id, name: g.name, real: true, children, devices: own,
        subtreeDevices: [...own, ...children.flatMap((c) => c.subtreeDevices)],
      };
    };

    const tree = (byParent.get('') ?? []).map(build);
    const loose = devicesByGroup.get(UNGROUPED) ?? [];
    if (loose.length > 0 || departments.length > 0) {
      tree.push({ id: UNGROUPED, name: 'Ungrouped', real: false, children: [], devices: loose, subtreeDevices: loose });
    }
    return { roots: tree, allDevices: visible };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, departments, q]);

  // While searching, everything is open — a collapsed branch would hide hits.
  const isOpen = (id: string) => (q ? true : expanded.has(id));
  const toggleOpen = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // ---- selection -----------------------------------------------------------
  const checkState = (ids: string[]): 'on' | 'off' | 'partial' => {
    if (ids.length === 0) return 'off';
    const hits = ids.filter((id) => checked.has(id)).length;
    return hits === 0 ? 'off' : hits === ids.length ? 'on' : 'partial';
  };
  const setMany = (ids: string[], on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      for (const id of ids) (on ? next.add(id) : next.delete(id));
      return next;
    });

  // Devices can disappear (deleted, or filtered out of the tenant); don't let
  // the selection keep phantom ids that would be sent in a bulk move.
  useEffect(() => {
    setChecked((prev) => {
      const live = new Set(devices.map((d) => d.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [devices]);

  // ---- drag & drop ---------------------------------------------------------
  function startDeviceDrag(e: React.DragEvent, d: Device) {
    // Dragging one of several checked devices moves the whole selection.
    const ids = checked.has(d.id) ? [...checked] : [d.id];
    drag.current = { kind: 'devices', ids };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ids.join(','));
  }
  function startGroupDrag(e: React.DragEvent, id: string) {
    drag.current = { kind: 'group', id };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }
  /** A group may not be dropped into itself or any of its own descendants. */
  function canDropGroup(dragId: string, targetId: string, nodes: TreeNode[] = roots): boolean {
    if (dragId === targetId) return false;
    const find = (list: TreeNode[]): TreeNode | null => {
      for (const n of list) {
        if (n.id === dragId) return n;
        const hit = find(n.children);
        if (hit) return hit;
      }
      return null;
    };
    const subtree = find(nodes);
    if (!subtree) return true;
    const contains = (n: TreeNode): boolean => n.id === targetId || n.children.some(contains);
    return !contains(subtree);
  }
  /**
   * Takes the payload explicitly rather than reading `drag.current`: handleDrop
   * clears the ref before validating, so a ref-reading version would always
   * report "not allowed" and silently swallow every drop.
   */
  function allows(p: DragPayload, targetId: string): boolean {
    if (p.kind === 'devices') return true;
    if (targetId === UNGROUPED) return true; // means "move to the root"
    return canDropGroup(p.id, targetId);
  }
  const dropAllowed = (targetId: string) => (drag.current ? allows(drag.current, targetId) : false);

  async function handleDrop(targetId: string) {
    const p = drag.current;
    drag.current = null;
    setDropTarget(null);
    if (!p || !allows(p, targetId)) return;
    const dest = targetId === UNGROUPED ? null : targetId;
    if (p.kind === 'devices') {
      await onMoveDevices(p.ids, dest);
      setChecked(new Set());
    } else {
      await onMoveGroup(p.id, dest);
    }
  }

  // ---- rename (groups and devices share one inline editor) -----------------
  // `renaming` holds the id being edited; ids are UUIDs on both sides so a
  // single slot can't collide. The kind decides which handler commits it.
  async function commitRename(id: string, kind: 'group' | 'device' = 'group') {
    const name = draftName.trim();
    setRenaming(null);
    if (!name) return;
    if (kind === 'device') await onRenameDevice(id, name);
    else await onRenameGroup(id, name);
  }
  async function commitCreate() {
    const name = draftName.trim();
    const parent = addingUnder ?? null;
    setAddingUnder(undefined);
    setDraftName('');
    if (name) {
      await onCreateGroup(name, parent);
      if (parent) setExpanded((prev) => new Set(prev).add(parent));
    }
  }

  // ---- rendering -----------------------------------------------------------
  const renderDevice = (d: Device, depth: number) => {
    const pos = positions[d.id];
    const dot = statusDot(d, pos);
    const active = d.id === selectedId;
    return (
      <div
        key={d.id}
        draggable
        onDragStart={(e) => startDeviceDrag(e, d)}
        onDragEnd={() => { drag.current = null; setDropTarget(null); }}
        style={{ paddingLeft: devicePad(depth) }}
        className={`group relative flex cursor-grab items-center gap-1.5 rounded pr-1 text-xs active:cursor-grabbing ${
          active ? 'bg-brand/10 text-fg' : 'text-fg-muted hover:bg-surface-2'
        }`}
      >
        {/* guide line linking the device back to its group's chevron column */}
        <span aria-hidden className="absolute bottom-0 top-0 w-px bg-border" style={{ left: groupPad(depth) + 7 }} />
        <TriCheck
          state={checked.has(d.id) ? 'on' : 'off'}
          onChange={() => setMany([d.id], !checked.has(d.id))}
          label={`Select ${displayName(d)}`}
        />
        {renaming === d.id ? (
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={() => void commitRename(d.id, 'device')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename(d.id, 'device');
              if (e.key === 'Escape') setRenaming(null);
            }}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Rename ${displayName(d)}`}
            className="min-w-0 flex-1 rounded border border-brand bg-surface px-1 py-0.5 text-xs text-fg outline-none"
          />
        ) : (
          <button
            onClick={() => onSelect(d.id)}
            onDoubleClick={(e) => { e.preventDefault(); setDraftName(d.name ?? ''); setRenaming(d.id); }}
            title="Double-click to rename"
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot.cls}`} title={dot.title} />
            <span className={`truncate ${active ? 'font-medium' : ''}`}>{displayName(d)}</span>
            {pos && pos.speedKph > 0 && (
              <span className="ml-auto shrink-0 tabular-nums text-fg-subtle">{pos.speedKph}</span>
            )}
          </button>
        )}
        <RowMenu
          items={[
            { label: 'Rename', onClick: () => { setDraftName(d.name ?? ''); setRenaming(d.id); } },
            { label: 'Show on map', onClick: () => onSelect(d.id) },
            { label: 'Move to…', onClick: () => setMany([d.id], true) },
            ...(d.departmentId ? [{ label: 'Remove from group', onClick: () => void onMoveDevices([d.id], null) }] : []),
          ]}
        />
      </div>
    );
  };

  const renderNode = (n: TreeNode, depth: number): React.ReactNode => {
    if (q && n.subtreeDevices.length === 0) return null; // hide branches with no hits
    const open = isOpen(n.id);
    const ids = n.subtreeDevices.map((d) => d.id);
    const isTarget = dropTarget === n.id;

    return (
      <div key={n.id}>
        <div
          draggable={n.real}
          onDragStart={(e) => n.real && startGroupDrag(e, n.id)}
          onDragEnd={() => { drag.current = null; setDropTarget(null); }}
          onDragOver={(e) => { if (dropAllowed(n.id)) { e.preventDefault(); setDropTarget(n.id); } }}
          onDragLeave={() => setDropTarget((t) => (t === n.id ? null : t))}
          onDrop={(e) => { e.preventDefault(); void handleDrop(n.id); }}
          style={{ paddingLeft: groupPad(depth) }}
          className={`flex items-center gap-1 rounded pr-1 text-xs ${
            isTarget ? 'bg-brand/15 ring-1 ring-brand/40' : 'hover:bg-surface-2'
          }`}
        >
          <button
            onClick={() => toggleOpen(n.id)}
            aria-label={open ? 'Collapse' : 'Expand'}
            className={`w-3 shrink-0 text-fg-subtle transition-transform ${open ? 'rotate-90' : ''} ${
              n.children.length === 0 && n.devices.length === 0 ? 'invisible' : ''
            }`}
          >
            ▸
          </button>
          <TriCheck state={checkState(ids)} onChange={() => setMany(ids, checkState(ids) !== 'on')}
            label={`Select all in ${n.name}`} />
          <span className="shrink-0 text-fg-subtle">{open ? '📂' : '📁'}</span>

          {renaming === n.id ? (
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => void commitRename(n.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename(n.id);
                if (e.key === 'Escape') setRenaming(null);
              }}
              className="min-w-0 flex-1 rounded border border-brand bg-surface px-1 py-0.5 text-xs text-fg outline-none"
            />
          ) : (
            <button onClick={() => toggleOpen(n.id)} className="min-w-0 flex-1 truncate py-1 text-left font-medium text-fg">
              {n.name}
            </button>
          )}

          <span className="shrink-0 rounded-full bg-surface-2 px-1.5 text-[11px] tabular-nums text-fg-muted">
            {n.subtreeDevices.length}
          </span>

          {n.real && (
            <RowMenu
              items={[
                { label: 'Rename', onClick: () => { setDraftName(n.name); setRenaming(n.id); } },
                { label: 'New subgroup', onClick: () => { setDraftName(''); setAddingUnder(n.id); setExpanded((p) => new Set(p).add(n.id)); } },
                { label: 'Move to top level', onClick: () => void onMoveGroup(n.id, null) },
                { label: 'Delete group', danger: true, onClick: () => void onDeleteGroup(n.id) },
              ]}
            />
          )}
        </div>

        {open && (
          <div>
            {addingUnder === n.id && (
              <div style={{ paddingLeft: groupPad(depth + 1) }} className="py-1 pr-1">
                <Input
                  autoFocus
                  placeholder="Subgroup name"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={() => void commitCreate()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitCreate();
                    if (e.key === 'Escape') { setAddingUnder(undefined); setDraftName(''); }
                  }}
                  className="py-1 text-xs"
                />
              </div>
            )}
            {n.children.map((c) => renderNode(c, depth + 1))}
            {n.devices.map((d) => renderDevice(d, depth + 1))}
            {n.subtreeDevices.length === 0 && n.children.length === 0 && !q && (
              <p style={{ paddingLeft: devicePad(depth) }} className="py-1 text-[11px] text-fg-subtle">
                Empty — drag devices here
              </p>
            )}
          </div>
        )}
      </div>
    );
  };

  const selectedCount = checked.size;

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex flex-col gap-2 border-b border-border p-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Devices</span>
          <div className="flex items-center gap-1">
            <button onClick={onAddDevice}
              className="rounded-md px-1.5 py-0.5 text-xs font-medium text-brand hover:bg-brand/10">+ Device</button>
            <button onClick={() => { setDraftName(''); setAddingUnder(null); }}
              className="rounded-md px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg">+ Group</button>
          </div>
        </div>
        <Input type="search" placeholder="Search name, IMEI, model, status…" value={query}
          onChange={(e) => setQuery(e.target.value)} className="py-1.5 text-xs" />
        {addingUnder === null && (
          <Input autoFocus placeholder="Group name" value={draftName} className="py-1.5 text-xs"
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={() => void commitCreate()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitCreate();
              if (e.key === 'Escape') { setAddingUnder(undefined); setDraftName(''); }
            }} />
        )}
      </div>

      {/* tree */}
      {/*
        No onDragOver here: dragover bubbles up from the row, and clearing
        dropTarget on the container wiped the row's own highlight every time.
      */}
      <div className="flex-1 overflow-y-auto py-1.5">
        {loading && devices.length === 0 && (
          <div className="flex flex-col gap-1.5 px-2" aria-busy="true" aria-label="Loading devices">
            {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-5 animate-pulse rounded bg-surface-2" />)}
          </div>
        )}
        {!loading && devices.length === 0 && (
          <div className="px-3 py-4 text-center">
            <p className="text-sm text-fg-muted">No devices yet.</p>
            <p className="mt-1 text-xs text-fg-subtle">Register a tracker by its IMEI before powering it on.</p>
            <Button className="mt-3" onClick={onAddDevice}>+ Add your first device</Button>
          </div>
        )}
        {roots.map((n) => renderNode(n, 0))}
        {q && allDevices.length === 0 && devices.length > 0 && (
          <p className="px-3 pt-2 text-sm text-fg-muted">No devices match “{query}”.</p>
        )}
      </div>

      {/* bulk action bar */}
      {selectedCount > 0 && (
        <div className="flex items-center gap-2 border-t border-border bg-surface-2/60 px-2.5 py-2">
          <select
            defaultValue=""
            onChange={(e) => {
              const v = e.target.value;
              e.currentTarget.value = '';
              if (!v) return;
              void onMoveDevices([...checked], v === UNGROUPED ? null : v).then(() => setChecked(new Set()));
            }}
            className="min-w-0 flex-1 rounded-md border border-border bg-surface px-1.5 py-1 text-xs text-fg"
          >
            <option value="">Move {selectedCount} to…</option>
            {departments.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            <option value={UNGROUPED}>— Ungrouped —</option>
          </select>
          <button onClick={() => setChecked(new Set())}
            className="shrink-0 rounded-md px-1.5 py-1 text-xs text-fg-muted hover:bg-surface hover:text-fg">Clear</button>
        </div>
      )}

      {/* footer */}
      <div className="flex items-center justify-between border-t border-border px-2.5 py-1.5 text-[11px] text-fg-subtle">
        <span>Total: <span className="font-medium text-fg-muted">{devices.length}</span></span>
        {q && <span>{allDevices.length} shown</span>}
        <span>Selected: <span className="font-medium text-fg-muted">{selectedCount}</span></span>
      </div>
    </div>
  );
}
