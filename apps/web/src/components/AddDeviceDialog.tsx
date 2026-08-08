'use client';
import { useEffect, useState } from 'react';
import { Button, Input, Modal } from './ui';
import type { Department } from '@/lib/types';

const IMEI_RE = /^\d{15}$/;

/**
 * Provision a tracker. The IMEI is the device's identity — ingestion only
 * accepts trackers whose IMEI has been registered here, so this must happen
 * before the device is powered on.
 */
export function AddDeviceDialog({
  open, departments, onClose, onCreate,
}: {
  open: boolean;
  departments: Department[];
  onClose: () => void;
  onCreate: (input: { imei: string; model: string; name: string | null; departmentId: string | null }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [imei, setImei] = useState('');
  const [model, setModel] = useState('FTC927');
  const [departmentId, setDepartmentId] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset each time the dialog is opened.
  useEffect(() => {
    if (open) { setName(''); setImei(''); setModel('FTC927'); setDepartmentId(''); setSaving(false); }
  }, [open]);

  const trimmedImei = imei.replace(/\s/g, '');
  const imeiValid = IMEI_RE.test(trimmedImei);
  const showImeiError = trimmedImei.length > 0 && !imeiValid;
  const canSubmit = imeiValid && model.trim().length >= 2 && !saving;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    try {
      await onCreate({
        imei: trimmedImei,
        model: model.trim(),
        name: name.trim() || null,
        departmentId: departmentId || null,
      });
      onClose(); // only closes if onCreate resolved (errors surface as a toast)
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} title="Add device" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg-muted">Name <span className="font-normal text-fg-subtle">(optional)</span></span>
          <Input autoFocus placeholder="Delivery Van 1" value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg-muted">IMEI</span>
          <Input
            inputMode="numeric"
            placeholder="15 digits, printed on the tracker"
            value={imei}
            onChange={(e) => setImei(e.target.value)}
            aria-invalid={showImeiError}
            className={showImeiError ? 'border-danger focus:border-danger focus:ring-danger/30' : ''}
          />
          {showImeiError
            ? <span className="text-xs text-danger">IMEI must be exactly 15 digits ({trimmedImei.length} entered).</span>
            : <span className="text-xs text-fg-subtle">The tracker is rejected until its IMEI is registered here.</span>}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg-muted">Model</span>
          <Input placeholder="FTC927" value={model} onChange={(e) => setModel(e.target.value)} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg-muted">Group <span className="font-normal text-fg-subtle">(optional)</span></span>
          <select
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-brand focus:ring-2 focus:ring-brand/30"
          >
            <option value="">— none —</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>

        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!canSubmit}>{saving ? 'Adding…' : 'Add device'}</Button>
        </div>
      </form>
    </Modal>
  );
}
