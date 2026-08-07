'use client';
import { useEffect, useState } from 'react';

const KEY = 'fleet.token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(KEY);
}
export function setToken(token: string) {
  window.localStorage.setItem(KEY, token);
}
export function clearToken() {
  window.localStorage.removeItem(KEY);
}

/** Reactive auth state for client components. */
export function useAuth() {
  const [token, setTok] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setTok(getToken());
    setReady(true);
  }, []);
  return {
    token,
    ready,
    isAuthed: !!token,
    login: (t: string) => {
      setToken(t);
      setTok(t);
    },
    logout: () => {
      clearToken();
      setTok(null);
    },
  };
}
