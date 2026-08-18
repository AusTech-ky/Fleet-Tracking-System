'use client';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, Modal } from './ui';
import type { Device, ImmobilizerConfig, Position } from '@/lib/types';

/**
 * Remote immobilization — cut or restore a vehicle's starter/fuel circuit.
 *
 * This can stop a car, so the UI is deliberately heavy: a red danger zone, a
 * two-step confirm that makes you type the vehicle name, a required standstill
 * test before first use, and a speed guard that greys out the button while the
 * vehicle is moving. Restore is always one click.
 */
export function ImmobilizerPanel({
  device, position, open, onClose,
}: {
  device: Device;
  position: Position | undefined;
  open: boolean;
  onClose: () => void;
}) {
  const [cfg, setCfg] = useState<ImmobilizerConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [confirming, setConfirming] = useState(false);
  // enable form
  const [dout, setDout] = useState(1);
  const [activeHigh, setActiveHigh] = useState(true);
  const [maxKph, setMaxKph] = useState(5);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const c = await api.immobilizer(device.id);
      setCfg(c); setDout(c.dout); setActiveHigh(c.activeHigh); setMaxKph(c.maxEngageKph);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load');
    } finally { setLoading(false); }
  };
  useEffect(() => { if (open) { setConfirming(false); setConfirmText(''); void load(); } // eslint-disable-next-line
  }, [open, device.id]);

  const act = async (label: string, fn: () => Promise<ImmobilizerConfig>) => {
    setBusy(label); setError(null);
    try { setCfg(await fn()); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Command failed'); }
    finally { setBusy(null); setConfirming(false); setConfirmText(''); }
  };

  const speed = position?.speedKph ?? null;
  const moving = speed !== null && cfg !== null && speed > cfg.maxEngageKph;
  const nameMatches = confirmText.trim() === (device.name?.trim() || device.model);

  return (
    <Modal open={open} title={`Immobilizer — ${device.name?.trim() || device.model}`} onClose={onClose}>
      {loading && <p className="text-sm text-fg-muted">Loading…</p>}
      {error && <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}

      {cfg && !cfg.enabled && (
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <strong>Not set up.</strong> Immobilization needs a relay wired to the vehicle&apos;s starter or fuel
            circuit, connected to a digital output on the tracker. Enable it only if that relay is installed.
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="text-fg-muted">Relay output (DOUT)</span>
            <select value={dout} onChange={(e) => setDout(Number(e.target.value))}
              className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg">
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>DOUT {n}</option>)}
            </select>
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="text-fg-muted">Relay logic</span>
            <select value={activeHigh ? 'high' : 'low'} onChange={(e) => setActiveHigh(e.target.value === 'high')}
              className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg">
              <option value="high">Output HIGH cuts the engine</option>
              <option value="low">Output LOW cuts the engine</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="text-fg-muted">Only cut below</span>
            <span className="flex items-center gap-1">
              <input type="number" min={0} max={50} value={maxKph} onChange={(e) => setMaxKph(Number(e.target.value))}
                className="w-16 rounded-md border border-border bg-surface px-2 py-1 text-right text-sm text-fg" />
              <span className="text-xs text-fg-subtle">km/h</span>
            </span>
          </label>
          <Button disabled={busy !== null}
            onClick={() => act('enable', () => api.configureImmobilizer(device.id, { enabled: true, dout, activeHigh, maxEngageKph: maxKph }))}>
            Enable immobilizer
          </Button>
        </div>
      )}

      {cfg && cfg.enabled && (
        <div className="flex flex-col gap-3">
          {/* current state */}
          <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
            cfg.immobilized ? 'border-danger/40 bg-danger/10 text-danger' : 'border-success/30 bg-success/10 text-success'
          }`}>
            <span className={`h-2.5 w-2.5 rounded-full ${cfg.immobilized ? 'bg-danger' : 'bg-success'}`} />
            <span className="font-medium">{cfg.immobilized ? 'Engine cut — vehicle immobilized' : 'Vehicle mobile'}</span>
          </div>

          {!cfg.testedAt && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              <strong>Test before relying on it.</strong> With the vehicle safely stopped, run a test — it toggles
              the relay so you can confirm the wiring cuts the right circuit.
            </div>
          )}

          {cfg.immobilized ? (
            <Button disabled={busy !== null}
              onClick={() => act('mobilize', () => api.mobilize(device.id))}>
              {busy === 'mobilize' ? 'Restoring…' : 'Restore engine'}
            </Button>
          ) : !confirming ? (
            <button
              disabled={busy !== null || moving}
              onClick={() => setConfirming(true)}
              className="rounded-lg bg-danger px-3 py-2 text-sm font-semibold text-white transition-colors hover:brightness-110 disabled:opacity-40"
            >
              {moving ? `Can't cut while moving (${speed} km/h)` : 'Immobilize vehicle'}
            </button>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-danger/40 bg-danger/5 p-3">
              <p className="text-xs text-fg">
                This cuts the engine of <strong>{device.name?.trim() || device.model}</strong>. Type its name to confirm.
              </p>
              <input autoFocus value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
                placeholder={device.name?.trim() || device.model}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:ring-2 focus:ring-danger/30" />
              <div className="flex gap-2">
                <button onClick={() => { setConfirming(false); setConfirmText(''); }}
                  className="flex-1 rounded-lg border border-border px-3 py-2 text-sm text-fg hover:bg-surface-2">Cancel</button>
                <button disabled={!nameMatches || busy !== null}
                  onClick={() => act('immobilize', () => api.immobilize(device.id))}
                  className="flex-1 rounded-lg bg-danger px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">
                  {busy === 'immobilize' ? 'Cutting…' : 'Cut engine now'}
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-2 text-xs">
            <button disabled={busy !== null} onClick={() => act('test', () => api.testImmobilizer(device.id))}
              className="rounded-md px-2 py-1 text-fg-muted hover:bg-surface-2 hover:text-fg">
              {busy === 'test' ? 'Testing…' : cfg.testedAt ? '↻ Re-test relay' : 'Test relay'}
            </button>
            <button disabled={busy !== null}
              onClick={() => act('disable', () => api.configureImmobilizer(device.id, { enabled: false }))}
              className="rounded-md px-2 py-1 text-fg-subtle hover:text-danger">
              Disable feature
            </button>
          </div>

          <div className="border-t border-border pt-2 text-[11px] text-fg-subtle">
            DOUT {cfg.dout} · {cfg.activeHigh ? 'HIGH' : 'LOW'} cuts · guard ≤ {cfg.maxEngageKph} km/h
            {cfg.testedAt && ` · tested ${new Date(cfg.testedAt).toLocaleDateString()}`}
          </div>
        </div>
      )}
    </Modal>
  );
}
