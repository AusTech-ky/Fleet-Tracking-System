'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button, Card, Input } from '@/components/ui';
import { ThemeToggle } from '@/components/ThemeToggle';

/**
 * NB: defined at module level, NOT inside LoginPage — an inline component
 * would be a new type every render, forcing React to remount the input on
 * each keystroke and lose focus.
 */
function Field({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      <Input {...props} />
    </label>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') {
        const res = await api.registerTenant(tenantName, email, password);
        login(res.accessToken);
        router.replace('/dashboard');
        return;
      }
      const res = await api.login(email, password);
      if ('mfaRequired' in res) setMfaToken(res.mfaToken);
      else {
        login(res.accessToken);
        router.replace('/dashboard');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.mfaVerify(mfaToken!, code);
      login(res.accessToken);
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invalid code');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative grid h-full place-items-center overflow-hidden p-4">
      {/* soft branded backdrop */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-brand/20 blur-3xl" />
        <div className="absolute -bottom-24 -right-16 h-72 w-72 rounded-full bg-brand/10 blur-3xl" />
      </div>
      <div className="absolute right-4 top-4"><ThemeToggle /></div>

      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-brand text-brand-fg shadow-sm">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 3l6 16-6-3-6 3z" /></svg>
          </div>
          <span className="text-xl font-semibold tracking-tight">FleetView</span>
        </div>

        <Card className="p-6 shadow-lg">
          <h1 className="text-lg font-semibold">
            {mfaToken ? 'Two-factor authentication' : mode === 'login' ? 'Welcome back' : 'Create your organization'}
          </h1>
          <p className="mb-5 mt-0.5 text-sm text-fg-muted">
            {mfaToken ? 'Enter the 6-digit code from your authenticator app.' : mode === 'login' ? 'Sign in to your fleet dashboard.' : 'Set up a new tenant and admin account.'}
          </p>

          {mfaToken ? (
            <form onSubmit={submitMfa} className="flex flex-col gap-3">
              <Field label="Authenticator code" inputMode="numeric" autoFocus placeholder="123456"
                value={code} onChange={(e) => setCode(e.target.value)} required />
              {error && <p className="text-sm text-danger">{error}</p>}
              <Button type="submit" disabled={busy}>{busy ? 'Verifying…' : 'Verify'}</Button>
              <button type="button" className="text-center text-xs text-fg-muted hover:text-fg"
                onClick={() => { setMfaToken(null); setCode(''); setError(null); }}>
                ← Back to sign in
              </button>
            </form>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-3">
              {mode === 'register' && (
                <Field label="Organization name" placeholder="Acme Fleet" value={tenantName}
                  onChange={(e) => setTenantName(e.target.value)} required />
              )}
              <Field label="Email" type="email" placeholder="you@company.com" value={email}
                onChange={(e) => setEmail(e.target.value)} required />
              <Field label="Password" type="password" placeholder="••••••••" value={password}
                onChange={(e) => setPassword(e.target.value)} required />
              {error && <p className="text-sm text-danger">{error}</p>}
              <Button type="submit" disabled={busy}>
                {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create organization'}
              </Button>
            </form>
          )}

          {!mfaToken && (
            <button
              className="mt-5 w-full text-center text-xs text-fg-muted hover:text-fg"
              onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}
            >
              {mode === 'login' ? 'Need an account? Create an organization' : 'Have an account? Sign in'}
            </button>
          )}
        </Card>
      </div>
    </main>
  );
}
