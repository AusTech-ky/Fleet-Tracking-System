'use client';
import { useEffect, useState } from 'react';
import { API_URL } from './config';

const KEY = 'fleet.token';
const REFRESH_KEY = 'fleet.refresh';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(KEY);
}
export function setToken(token: string) {
  window.localStorage.setItem(KEY, token);
}
export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(REFRESH_KEY);
}
/** Store a token pair from login / refresh. */
export function setTokens(accessToken: string, refreshToken?: string) {
  window.localStorage.setItem(KEY, accessToken);
  if (refreshToken) window.localStorage.setItem(REFRESH_KEY, refreshToken);
}
export function clearToken() {
  window.localStorage.removeItem(KEY);
  window.localStorage.removeItem(REFRESH_KEY);
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
    login: (accessToken: string, refreshToken?: string) => {
      setTokens(accessToken, refreshToken);
      setTok(accessToken);
    },
    logout: () => {
      // Best-effort server-side revocation so the refresh token can't be reused.
      const refreshToken = getRefreshToken();
      if (refreshToken) {
        void fetch(`${API_URL}/auth/logout`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        }).catch(() => {});
      }
      clearToken();
      setTok(null);
    },
  };
}
