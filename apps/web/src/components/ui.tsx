'use client';
import { forwardRef, useEffect } from 'react';

/** Token-based primitives (theme-aware via CSS variables). */

type ButtonVariant = 'primary' | 'ghost' | 'outline';

export function Button({
  className = '',
  variant = 'primary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-all disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40';
  const styles: Record<ButtonVariant, string> = {
    primary: 'bg-brand text-brand-fg shadow-sm hover:brightness-110 active:brightness-95',
    ghost: 'bg-transparent text-fg-muted hover:bg-surface-2 hover:text-fg',
    outline: 'border border-border bg-surface text-fg hover:bg-surface-2',
  };
  return <button className={`${base} ${styles[variant]} ${className}`} {...props} />;
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...props }, ref) {
    return (
      <input
        ref={ref}
        className={`w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/30 ${className}`}
        {...props}
      />
    );
  },
);

export function Card({ className = '', ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-xl border border-border bg-surface shadow-sm ${className}`} {...props} />;
}

/** Centered modal dialog. Closes on Escape or backdrop click. */
export function Modal({
  open, title, onClose, children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-label={title}
        className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="font-semibold text-fg">{title}</h2>
          <button onClick={onClose} aria-label="Close"
            className="rounded-md px-1.5 text-fg-subtle hover:bg-surface-2 hover:text-fg">✕</button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Badge({ children, tone = 'slate' }: { children: React.ReactNode; tone?: string }) {
  const tones: Record<string, string> = {
    green: 'bg-success/10 text-success ring-1 ring-success/20',
    amber: 'bg-warning/10 text-warning ring-1 ring-warning/20',
    red: 'bg-danger/10 text-danger ring-1 ring-danger/20',
    brand: 'bg-brand/10 text-brand ring-1 ring-brand/20',
    slate: 'bg-surface-2 text-fg-muted ring-1 ring-border',
  };
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${tones[tone] ?? tones.slate}`}>
      {children}
    </span>
  );
}
