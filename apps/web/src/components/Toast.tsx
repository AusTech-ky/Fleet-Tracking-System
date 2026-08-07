'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';

/**
 * Minimal toast system — actions (save, delete, rename) currently succeed or
 * fail silently, which leaves the user guessing. `useToast()` gives every
 * mutation a visible outcome.
 */
type ToastTone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

const ToastContext = createContext<{ push: (message: string, tone?: ToastTone) => void }>({
  push: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

/** Wrap an async action: shows `ok` on success, or the error message on failure. */
export function useAction() {
  const { push } = useToast();
  return useCallback(
    async (fn: () => Promise<unknown>, ok?: string, fallbackError = 'Something went wrong') => {
      try {
        await fn();
        if (ok) push(ok, 'success');
        return true;
      } catch (err) {
        push(err instanceof Error && err.message ? err.message : fallbackError, 'error');
        return false;
      }
    },
    [push],
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: ToastTone = 'info') => {
    setToasts((prev) => [...prev, { id: Date.now() + Math.random(), tone, message }].slice(-4));
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDone={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const toneStyles: Record<ToastTone, string> = {
  success: 'border-success/30 bg-success/10 text-success',
  error: 'border-danger/30 bg-danger/10 text-danger',
  info: 'border-border bg-surface text-fg',
};
const toneIcon: Record<ToastTone, string> = { success: '✓', error: '!', info: 'i' };

function ToastItem({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = requestAnimationFrame(() => setVisible(true));
    const hide = setTimeout(() => setVisible(false), 3200);
    const done = setTimeout(onDone, 3500);
    return () => {
      cancelAnimationFrame(show);
      clearTimeout(hide);
      clearTimeout(done);
    };
  }, [onDone]);

  return (
    <div
      role="status"
      className={`pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg backdrop-blur transition-all duration-200 ${
        toneStyles[toast.tone]
      } ${visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}`}
    >
      <span className="mt-px grid h-4 w-4 shrink-0 place-items-center rounded-full bg-current/15 text-[10px] font-bold">
        {toneIcon[toast.tone]}
      </span>
      <span className="leading-snug">{toast.message}</span>
    </div>
  );
}
