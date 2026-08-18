'use client';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, Modal } from './ui';
import type { Device, MotionMode, NetworkMode, ReportingProfile } from '@/lib/types';

/**
 * Remote configuration of how often a tracker reports — read from and written
 * to the device over the air, on the socket it already uses to send positions.
 *
 * Every write is followed by a read-back, and the form shows what the device
 * says it HOLDS, not what we asked for. A device that is offline can't be
 * configured; the panel says so plainly instead of pretending.
 */

type Field = keyof ReportingProfile;

interface FieldSpec {
  key: Field;
  label: string;
  unit: string;
  hint: string;
  min: number;
  max: number;
  movingOnly?: boolean;
}

// Ranges mirror the Teltonika wiki parameter table (enforced again server-side).
const FIELDS: FieldSpec[] = [
  { key: 'minPeriodSec',     label: 'Every',            unit: 's',       hint: 'Record at least this often. 0 = off.', min: 0, max: 2_592_000 },
  { key: 'minDistanceM',     label: 'Every',            unit: 'm',       hint: 'Record after travelling this far. 0 = off.', min: 0, max: 65_535, movingOnly: true },
  { key: 'minAngleDeg',      label: 'On turn of',       unit: '°',       hint: 'Record when heading changes by this much — captures curves. 0 = off.', min: 0, max: 180, movingOnly: true },
  { key: 'minSpeedDeltaKph', label: 'On speed change',  unit: 'km/h',    hint: 'Record when speed changes by this much. 0 = off.', min: 0, max: 100, movingOnly: true },
  { key: 'minSavedRecords',  label: 'Batch',            unit: 'records', hint: 'Collect this many before sending.', min: 1, max: 255 },
  { key: 'sendPeriodSec',    label: 'Send every',       unit: 's',       hint: 'How often to attempt an upload. 0 = only when the batch is full.', min: 0, max: 2_592_000 },
];

const NETWORKS: Array<{ id: NetworkMode; label: string; hint: string }> = [
  { id: 'home',    label: 'Home',    hint: 'On the home SIM operator' },
  { id: 'roaming', label: 'Roaming', hint: 'On a roaming operator — usually slower, to save data' },
  { id: 'unknown', label: 'Unknown', hint: 'Operator not in either list' },
];
const MOTIONS: Array<{ id: MotionMode; label: string }> = [
  { id: 'moving', label: 'Moving' },
  { id: 'stop',   label: 'Stopped' },
];

type Status =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'writing' }
  | { kind: 'ok'; msg: string }
  | { kind: 'offline' }
  | { kind: 'error'; msg: string };

export function ReportingProfilePanel({ device, open, onClose }: { device: Device; open: boolean; onClose: () => void }) {
  const [network, setNetwork] = useState<NetworkMode>('home');
  const [motion, setMotion] = useState<MotionMode>('moving');
  /** what the device currently holds (last read-back) */
  const [held, setHeld] = useState<Partial<ReportingProfile>>({});
  /** what the user has typed */
  const [draft, setDraft] = useState<Partial<Record<Field, string>>>({});
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const visible = FIELDS.filter((f) => motion === 'moving' || !f.movingOnly);

  async function read() {
    setStatus({ kind: 'reading' });
    try {
      const r = await api.readReportingProfile(device.id, network, motion);
      setHeld(r.values);
      setDraft(Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, String(v)])));
      setStatus({ kind: 'ok', msg: 'Read from device' });
    } catch (err) {
      fail(err);
    }
  }

  function fail(err: unknown) {
    if (err instanceof ApiError && err.status === 409 && /not currently connected/i.test(err.message)) {
      setStatus({ kind: 'offline' });
    } else if (err instanceof ApiError && err.status === 504) {
      setStatus({ kind: 'error', msg: 'The device did not answer in time. It may be between reports — try again in a moment.' });
    } else if (err instanceof ApiError && err.status === 503) {
      setStatus({ kind: 'error', msg: 'Remote configuration is not enabled on the server.' });
    } else {
      setStatus({ kind: 'error', msg: err instanceof ApiError ? err.message : 'Something went wrong' });
    }
  }

  // Re-read whenever the profile selector changes (or the panel opens).
  useEffect(() => {
    if (!open) return;
    setHeld({}); setDraft({});
    void read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, network, motion, device.id]);

  /** Only the fields the user actually changed are sent. */
  const changes = (): Partial<ReportingProfile> => {
    const out: Partial<ReportingProfile> = {};
    for (const f of visible) {
      const raw = draft[f.key];
      if (raw === undefined || raw === '') continue;
      const n = Number(raw);
      if (!Number.isInteger(n)) continue;
      if (held[f.key] !== n) out[f.key] = n;
    }
    return out;
  };
  const pending = changes();
  /**
   * Validate only what the user CHANGED. A device may report a value outside our
   * documented range (a fake or unset one returns 0 for Batch, whose min is 1);
   * that must not block the form — it's the device's number, not the user's.
   * If the user edits that field, the range applies to their new value.
   */
  const outOfRange = (f: FieldSpec, raw: string | undefined) => {
    if (raw === undefined || raw === '') return false;
    const n = Number(raw);
    return !Number.isInteger(n) || n < f.min || n > f.max;
  };
  const invalid = visible.filter((f) => f.key in pending && outOfRange(f, draft[f.key]));

  async function apply() {
    if (Object.keys(pending).length === 0 || invalid.length) return;
    setStatus({ kind: 'writing' });
    try {
      const r = await api.writeReportingProfile(device.id, network, motion, pending);
      setHeld(r.values);
      setDraft(Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, String(v)])));
      setStatus({ kind: 'ok', msg: `Applied — device confirmed ${Object.keys(pending).length} setting${Object.keys(pending).length === 1 ? '' : 's'}` });
    } catch (err) {
      fail(err);
    }
  }

  const busy = status.kind === 'reading' || status.kind === 'writing';

  return (
    <Modal open={open} title={`Reporting settings — ${device.name?.trim() || device.model}`} onClose={onClose}>
      <p className="mb-3 text-xs text-fg-muted">
        How often this tracker records and sends its position. Changes are pushed to the device over the air and
        read back to confirm. The device must be online.
      </p>

      {/* profile selector — two labelled segmented controls on one row, no wrapping */}
      <div className="mb-3 grid grid-cols-[auto_auto_1fr] items-end gap-3 text-xs">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Network</div>
          <div className="flex overflow-hidden rounded-lg border border-border">
            {NETWORKS.map((n) => (
              <button key={n.id} title={n.hint} disabled={busy} onClick={() => setNetwork(n.id)}
                className={`whitespace-nowrap px-3 py-1.5 transition-colors ${network === n.id ? 'bg-brand text-brand-fg' : 'text-fg-muted hover:bg-surface-2'}`}>
                {n.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Vehicle is</div>
          <div className="flex overflow-hidden rounded-lg border border-border">
            {MOTIONS.map((m) => (
              <button key={m.id} disabled={busy} onClick={() => setMotion(m.id)}
                className={`whitespace-nowrap px-3 py-1.5 transition-colors ${motion === m.id ? 'bg-brand text-brand-fg' : 'text-fg-muted hover:bg-surface-2'}`}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <button onClick={() => void read()} disabled={busy}
          className="justify-self-end whitespace-nowrap rounded-md px-2 py-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50">
          ↻ Re-read
        </button>
      </div>

      {/* status */}
      {status.kind === 'offline' && (
        <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          <strong>Device is offline.</strong> Settings can only be changed while the tracker is connected. It will
          reconnect on its next report — try again then.
        </div>
      )}
      {status.kind === 'error' && (
        <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{status.msg}</div>
      )}
      {status.kind === 'reading' && <p className="mb-3 text-xs text-fg-muted">Reading from device…</p>}
      {status.kind === 'writing' && <p className="mb-3 text-xs text-fg-muted">Sending to device and confirming…</p>}
      {status.kind === 'ok' && <p className="mb-3 text-xs text-success">✓ {status.msg}</p>}

      {/* fields */}
      <div className="flex flex-col gap-2">
        {visible.map((f) => {
          const raw = draft[f.key] ?? '';
          const n = Number(raw);
          const changed = raw !== '' && Number.isInteger(n) && held[f.key] !== undefined && held[f.key] !== n;
          const bad = changed && outOfRange(f, raw); // only flag values the user typed
          return (
            <div key={f.key} className="flex flex-col gap-0.5">
              <label className="flex items-center gap-3 text-sm">
                <span className="w-32 shrink-0 text-fg-muted" title={f.hint}>{f.label}</span>
                {/* Input + unit as one control: the unit sits inside the field's
                    right edge, so it can't drift away from its number. */}
                <span className={`flex min-w-0 flex-1 items-center rounded-md border bg-surface focus-within:ring-2 focus-within:ring-brand/30 ${
                  bad ? 'border-danger' : changed ? 'border-brand' : 'border-border'
                }`}>
                  <input
                    inputMode="numeric"
                    value={raw}
                    disabled={busy || status.kind === 'offline'}
                    placeholder={held[f.key] === undefined ? '—' : String(held[f.key])}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    className="min-w-0 flex-1 bg-transparent px-2.5 py-1.5 text-right tabular-nums text-fg outline-none disabled:opacity-60"
                  />
                  <span className="shrink-0 border-l border-border px-2 py-1.5 text-xs text-fg-subtle">{f.unit}</span>
                </span>
              </label>
              {bad && <span className="pl-[8.75rem] text-[11px] text-danger">Must be {f.min}–{f.max}</span>}
              {!bad && changed && held[f.key] !== undefined && (
                <span className="pl-[8.75rem] text-[11px] text-fg-subtle">was {held[f.key]} {f.unit}</span>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="text-[11px] text-fg-subtle">
          {Object.keys(pending).length > 0
            ? `${Object.keys(pending).length} change${Object.keys(pending).length === 1 ? '' : 's'} to send`
            : 'Showing what the device holds'}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" className="py-1.5 text-xs" onClick={onClose}>Close</Button>
          <Button className="py-1.5 text-xs" onClick={() => void apply()}
            disabled={busy || status.kind === 'offline' || Object.keys(pending).length === 0 || invalid.length > 0}>
            {status.kind === 'writing' ? 'Sending…' : 'Send to device'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
