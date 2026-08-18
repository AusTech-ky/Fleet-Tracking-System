'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/components/Toast';
import { Button, Card, Input, Badge } from '@/components/ui';
import type { Role, Department } from '@/lib/types';

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

/** Order departments as a flattened tree with depth, for indented display. */
function orderByTree(depts: Department[]): { dept: Department; depth: number }[] {
  const children = new Map<string | null, Department[]>();
  for (const d of depts) {
    const arr = children.get(d.parentId) ?? [];
    arr.push(d);
    children.set(d.parentId, arr);
  }
  const out: { dept: Department; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const d of children.get(parentId) ?? []) {
      out.push({ dept: d, depth });
      walk(d.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export default function SettingsPage() {
  const { ready, isAuthed } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  useEffect(() => { if (ready && !isAuthed) router.replace('/login'); }, [ready, isAuthed, router]);

  if (!ready) return null;

  return (
    <main className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-4">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded bg-brand" />
          <span className="font-semibold">SwiftView</span>
          <span className="text-fg-muted">/ Settings</span>
        </div>
        <Link href="/dashboard" className="text-sm text-fg-muted hover:text-fg">← Back to map</Link>
      </header>

      <BillingSection qc={qc} />
      <NotificationsSection qc={qc} />
      <SecuritySection />
      <DepartmentsSection qc={qc} />
      <TeamSection qc={qc} />
    </main>
  );
}

function BillingSection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { data } = useQuery({ queryKey: ['billing'], queryFn: api.billing, retry: false });
  const [busy, setBusy] = useState<string | null>(null);
  if (!data) return null;

  async function choose(planId: string) {
    setBusy(planId);
    try {
      await api.subscribe(planId);
      qc.invalidateQueries({ queryKey: ['billing'] });
    } finally { setBusy(null); }
  }
  const bar = (used: number, limit: number) => Math.min(100, Math.round((used / limit) * 100));

  return (
    <Card className="p-4">
      <h2 className="mb-1 font-semibold">Plan &amp; usage</h2>
      <p className="mb-3 text-xs text-fg-muted">Current plan: <span className="text-fg">{data.plan.name}</span></p>
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        {(['devices', 'users'] as const).map((res) => (
          <div key={res}>
            <div className="mb-1 flex justify-between text-xs text-fg-muted">
              <span className="capitalize">{res}</span>
              <span>{data.usage[res]} / {data.plan.limits[res]}</span>
            </div>
            <div className="h-2 overflow-hidden rounded bg-surface-2">
              <div className="h-full bg-brand" style={{ width: `${bar(data.usage[res], data.plan.limits[res])}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {data.plans.map((p) => (
          <button key={p.id} disabled={busy === p.id || p.id === data.plan.id} onClick={() => choose(p.id)}
            className={`rounded-md border px-3 py-2 text-left text-xs transition-colors ${
              p.id === data.plan.id ? 'border-brand bg-brand/10' : 'border-border hover:bg-surface-2'
            }`}>
            <div className="font-medium text-fg">{p.name}{p.id === data.plan.id && ' ✓'}</div>
            <div className="text-fg-muted">{p.priceUsdMonthly ? `$${p.priceUsdMonthly}/mo` : 'Free'} · {p.limits.devices} devices</div>
          </button>
        ))}
      </div>
    </Card>
  );
}

function DepartmentsSection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { data: depts, error } = useQuery({ queryKey: ['departments'], queryFn: api.listDepartments, retry: false });
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  if (error instanceof ApiError && error.status === 403) return null; // non-admin

  async function add() {
    setMsg(null);
    try {
      await api.createDepartment({ name, parentId: parentId || null });
      setName(''); setParentId('');
      qc.invalidateQueries({ queryKey: ['departments'] });
    } catch (e) { setMsg(e instanceof ApiError ? e.message : 'Failed'); }
  }
  async function del(id: string) {
    await api.deleteDepartment(id);
    qc.invalidateQueries({ queryKey: ['departments'] });
  }

  const ordered = orderByTree(depts ?? []);
  return (
    <Card className="p-4">
      <h2 className="mb-1 font-semibold">Departments</h2>
      <p className="mb-3 text-xs text-fg-muted">Sub-orgs for scoping access. Users assigned to a department see only its subtree.</p>
      <div className="mb-4 overflow-hidden rounded-md border border-border">
        {ordered.length === 0 && <p className="px-3 py-3 text-sm text-fg-muted">No departments yet.</p>}
        {ordered.map(({ dept, depth }) => (
          <div key={dept.id} className="flex items-center justify-between border-b border-border px-3 py-2 last:border-0">
            <span className="text-sm text-fg" style={{ paddingLeft: depth * 16 }}>
              {depth > 0 && <span className="text-fg-subtle">└ </span>}{dept.name}
            </span>
            <button className="text-xs text-danger hover:text-danger" onClick={() => del(dept.id)}>Delete</button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Input className="max-w-52" placeholder="Department name" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={parentId} onChange={(e) => setParentId(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-2 text-sm text-fg">
          <option value="">— top level —</option>
          {ordered.map(({ dept, depth }) => <option key={dept.id} value={dept.id}>{' '.repeat(depth * 2)}{dept.name}</option>)}
        </select>
        <Button disabled={!name.trim()} onClick={add}>Add department</Button>
        {msg && <span className="text-xs text-danger">{msg}</span>}
      </div>
    </Card>
  );
}

function NotificationsSection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { data } = useQuery({ queryKey: ['notification-config'], queryFn: api.notificationConfig });
  const [webhooks, setWebhooks] = useState('');
  const [emails, setEmails] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (data) { setWebhooks(data.webhookUrls.join('\n')); setEmails(data.emailRecipients.join('\n')); }
  }, [data]);

  async function save() {
    setMsg(null);
    try {
      await api.saveNotificationConfig({ webhookUrls: lines(webhooks), emailRecipients: lines(emails) });
      qc.invalidateQueries({ queryKey: ['notification-config'] });
      setMsg('Saved.');
    } catch (e) { setMsg(e instanceof ApiError ? e.message : 'Failed to save'); }
  }
  async function test() {
    setMsg(null);
    const r = await api.testNotification();
    setMsg(r.delivered ? 'Test notification sent to your channels.' : 'No channels configured yet.');
  }

  return (
    <Card className="p-4">
      <h2 className="mb-1 font-semibold">Alert notifications</h2>
      <p className="mb-3 text-xs text-fg-muted">Deliver alerts to webhooks and email in addition to the live feed.</p>
      <label className="mb-1 block text-xs text-fg-muted">Webhook URLs (one per line)</label>
      <textarea value={webhooks} onChange={(e) => setWebhooks(e.target.value)} rows={2}
        placeholder="https://hooks.example.com/fleet"
        className="mb-3 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg" />
      <label className="mb-1 block text-xs text-fg-muted">Email recipients (one per line)</label>
      <textarea value={emails} onChange={(e) => setEmails(e.target.value)} rows={2}
        placeholder="ops@yourfleet.com"
        className="mb-3 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg" />
      {data?.webhookSecret && (
        <p className="mb-3 break-all text-xs text-fg-muted">
          Webhook signing secret: <span className="font-mono text-fg">{data.webhookSecret}</span> (verify the
          <span className="font-mono"> X-Fleet-Signature</span> header)
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button onClick={save}>Save</Button>
        <Button variant="ghost" className="border border-border" onClick={test}>Send test</Button>
        {msg && <span className="text-xs text-fg-muted">{msg}</span>}
      </div>
    </Card>
  );
}

function SecuritySection() {
  const [status, setStatus] = useState<'unknown' | 'enrolling' | 'enabled' | 'disabled'>('unknown');
  const [secret, setSecret] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  async function startSetup() {
    setMsg(null);
    const r = await api.mfaSetup();
    setSecret(r.secret); setUri(r.otpauthUri); setStatus('enrolling');
  }
  async function enable() {
    setMsg(null);
    try { await api.mfaEnable(code); setStatus('enabled'); setSecret(null); setCode(''); }
    catch (e) { setMsg(e instanceof ApiError ? e.message : 'Failed'); }
  }
  async function disable() {
    setMsg(null);
    try { await api.mfaDisable(code); setStatus('disabled'); setCode(''); }
    catch (e) { setMsg(e instanceof ApiError ? e.message : 'Failed'); }
  }

  return (
    <Card className="p-4">
      <h2 className="mb-1 font-semibold">Security · Two-factor authentication</h2>
      <p className="mb-3 text-xs text-fg-muted">Protect your account with a TOTP authenticator app.</p>
      {status === 'enabled' ? (
        <div className="flex flex-col gap-2">
          <Badge tone="green">MFA enabled</Badge>
          <div className="flex items-center gap-2">
            <Input className="max-w-40" placeholder="Code to disable" value={code} onChange={(e) => setCode(e.target.value)} />
            <Button variant="ghost" className="border border-border" onClick={disable}>Disable</Button>
          </div>
        </div>
      ) : status === 'enrolling' ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-fg-muted">Scan this in your authenticator app, or enter the secret manually:</p>
          <p className="break-all font-mono text-xs text-fg">{secret}</p>
          <p className="break-all text-[10px] text-fg-subtle">{uri}</p>
          <div className="flex items-center gap-2">
            <Input className="max-w-40" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
            <Button onClick={enable}>Enable</Button>
          </div>
        </div>
      ) : (
        <Button onClick={startSetup}>Set up MFA</Button>
      )}
      {msg && <p className="mt-2 text-xs text-danger">{msg}</p>}
    </Card>
  );
}

function TeamSection({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const { data: users, error } = useQuery({ queryKey: ['users'], queryFn: api.listUsers, retry: false });
  const { data: depts } = useQuery({ queryKey: ['departments'], queryFn: api.listDepartments, retry: false });
  const run = useAction();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('operator');
  const [departmentId, setDepartmentId] = useState('');
  // which user's password is being edited, and the draft value
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [newPw, setNewPw] = useState('');

  // Non-admins get 403 on /users — hide the section for them.
  if (error instanceof ApiError && error.status === 403) return null;
  const deptName = (id: string | null) => depts?.find((d) => d.id === id)?.name ?? null;

  async function addUser() {
    const ok = await run(async () => {
      await api.createUser({ email, password, role, departmentId: departmentId || null });
      qc.invalidateQueries({ queryKey: ['users'] });
    }, `User ${email} created`);
    if (ok) { setEmail(''); setPassword(''); setDepartmentId(''); }
  }
  async function toggleActive(id: string, active: boolean) {
    await run(async () => {
      await api.updateUser(id, { active: !active });
      qc.invalidateQueries({ queryKey: ['users'] });
    }, active ? 'User deactivated' : 'User reactivated');
  }
  async function savePassword(id: string, emailOf: string) {
    if (newPw.length < 8) return; // button is disabled anyway
    const ok = await run(() => api.updateUser(id, { password: newPw }), `Password updated for ${emailOf}`);
    if (ok) { setResetFor(null); setNewPw(''); }
  }

  return (
    <Card className="p-4">
      <h2 className="mb-3 font-semibold">Team</h2>
      <div className="mb-4 overflow-hidden rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-xs text-fg-muted">
            <tr><th className="px-3 py-2">Email</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Department</th><th className="px-3 py-2">Status</th><th /></tr>
          </thead>
          <tbody>
            {(users ?? []).map((u) => (
              <tr key={u.id} className="border-t border-border">
                <td className="px-3 py-2 text-fg">{u.email}</td>
                <td className="px-3 py-2"><Badge>{u.role}</Badge></td>
                <td className="px-3 py-2 text-xs text-fg-muted">{deptName(u.departmentId) ?? 'tenant-wide'}</td>
                <td className="px-3 py-2">{u.active ? <Badge tone="green">active</Badge> : <Badge tone="red">disabled</Badge>}</td>
                <td className="px-3 py-2 text-right">
                  {resetFor === u.id ? (
                    <div className="flex items-center justify-end gap-1.5">
                      <Input
                        autoFocus type="password" placeholder="new password (min 8)" value={newPw}
                        onChange={(e) => setNewPw(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void savePassword(u.id, u.email); if (e.key === 'Escape') { setResetFor(null); setNewPw(''); } }}
                        className="w-44 py-1 text-xs"
                      />
                      <button className="text-xs font-medium text-brand disabled:opacity-40" disabled={newPw.length < 8}
                        onClick={() => void savePassword(u.id, u.email)}>Save</button>
                      <button className="text-xs text-fg-subtle hover:text-fg" onClick={() => { setResetFor(null); setNewPw(''); }}>Cancel</button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-end gap-3">
                      <button className="text-xs text-fg-muted hover:text-fg" onClick={() => { setResetFor(u.id); setNewPw(''); }}>Set password</button>
                      <button className="text-xs text-fg-muted hover:text-fg" onClick={() => toggleActive(u.id, u.active)}>
                        {u.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Input className="max-w-52" placeholder="new.user@email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input className="max-w-40" type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}
          className="rounded-md border border-border bg-surface px-2 py-2 text-sm text-fg">
          <option value="operator">operator</option>
          <option value="viewer">viewer</option>
          <option value="admin">admin</option>
        </select>
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-2 text-sm text-fg">
          <option value="">tenant-wide</option>
          {orderByTree(depts ?? []).map(({ dept, depth }) => (
            <option key={dept.id} value={dept.id}>{' '.repeat(depth * 2)}{dept.name}</option>
          ))}
        </select>
        <Button onClick={addUser}>Add user</Button>
      </div>
    </Card>
  );
}
