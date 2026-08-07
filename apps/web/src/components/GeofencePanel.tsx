'use client';
import { useState } from 'react';
import { Button, Input } from './ui';
import type { Geofence, DrawMode, DrawnShape } from '@/lib/types';

export function GeofencePanel({
  open, geofences, drawMode, pending,
  onDraw, onCancelDraw, onSave, onDiscard, onDelete,
}: {
  open: boolean;
  geofences: Geofence[];
  drawMode: DrawMode;
  pending: DrawnShape | null;
  onDraw: (mode: 'circle' | 'polygon') => void;
  onCancelDraw: () => void;
  onSave: (name: string) => void;
  onDiscard: () => void;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState('');
  if (!open) return null;

  return (
    <div className="absolute right-0 top-0 z-10 flex h-full w-80 flex-col border-l border-border bg-surface/95 backdrop-blur">
      <div className="border-b border-border px-4 py-3 text-sm font-semibold">Geofences</div>

      <div className="border-b border-border p-3">
        {pending ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-fg-muted">Name this {pending.kind}:</p>
            <Input autoFocus placeholder="Geofence name" value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { onSave(name.trim()); setName(''); } }} />
            <div className="flex gap-2">
              <Button disabled={!name.trim()} onClick={() => { onSave(name.trim()); setName(''); }}>Save</Button>
              <Button variant="ghost" onClick={() => { onDiscard(); setName(''); }}>Discard</Button>
            </div>
          </div>
        ) : drawMode !== 'none' ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-success">
              {drawMode === 'circle'
                ? 'Click the centre, then click again to set the radius.'
                : 'Click to add points; double-click to finish.'}
            </p>
            <Button variant="ghost" onClick={onCancelDraw} className="border border-border">Cancel</Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button onClick={() => onDraw('circle')} className="flex-1">◯ Circle</Button>
            <Button onClick={() => onDraw('polygon')} className="flex-1">⬠ Polygon</Button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {geofences.length === 0 && <p className="p-4 text-sm text-fg-muted">No geofences yet. Draw one above.</p>}
        {geofences.map((g) => (
          <div key={g.id} className="flex items-center justify-between border-b border-border px-4 py-2">
            <div>
              <div className="text-sm text-fg">{g.name}</div>
              <div className="text-xs text-fg-muted">
                {g.kind === 'circle' ? `circle · ${g.radiusM} m radius` : `polygon · ${g.ring.length} points`}
              </div>
            </div>
            <button onClick={() => onDelete(g.id)} className="text-xs text-danger hover:text-danger">Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}
