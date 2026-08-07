'use client';
import { useEffect, useState } from 'react';

/** Light/dark toggle. Persists to localStorage; the layout script sets the
 *  initial value before paint so there's no flash. */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => {
    setTheme((document.documentElement.dataset.theme as 'light' | 'dark') || 'light');
  }, []);

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('fleet.theme', next);
    setTheme(next);
  }

  return (
    <button
      onClick={toggle}
      aria-label="Toggle theme"
      title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
      className={`grid h-8 w-8 place-items-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg ${className}`}
    >
      {theme === 'dark' ? '☀️' : '🌙'}
    </button>
  );
}
