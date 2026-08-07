'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { WS_URL } from './config';
import type { Position, AlertEvent, RtMessage } from './types';

export type ConnState = 'connecting' | 'open' | 'closed';

/**
 * Subscribes to the control-plane /rt live feed and returns the latest position
 * per device plus a rolling list of live alerts, and connection state.
 * Auto-reconnects with backoff. Positions are keyed by deviceId so the map can
 * diff-update markers.
 */
export function useLivePositions(token: string | null) {
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [state, setState] = useState<ConnState>('closed');
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!token) return;
    let closedByUs = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;

    const connect = () => {
      setState('connecting');
      const ws = new WebSocket(`${WS_URL}/rt?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        retry = 0;
        setState('open');
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as RtMessage;
        if (msg.type === 'position') {
          setPositions((prev) => ({ ...prev, [msg.position.deviceId]: msg.position }));
        } else if (msg.type === 'alert') {
          setAlerts((prev) => [msg.alert, ...prev].slice(0, 100));
        }
      };
      ws.onclose = () => {
        setState('closed');
        if (closedByUs) return;
        retry += 1;
        const delay = Math.min(1000 * 2 ** retry, 15000);
        timer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closedByUs = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [token]);

  /**
   * Seed the map with positions fetched over REST (e.g. on first load).
   * NB: these MUST be stable (useCallback) — callers put them in effect deps,
   * and an unstable identity turns "seed once" into an infinite fetch/render
   * loop. They also return the previous state unchanged when there is nothing
   * new, so they never trigger a pointless re-render.
   */
  const seed = useCallback((list: Position[]) => {
    if (list.length === 0) return;
    setPositions((prev) => {
      const next = { ...prev };
      for (const p of list) next[p.deviceId] = p;
      return next;
    });
  }, []);

  const seedAlerts = useCallback((list: AlertEvent[]) => {
    setAlerts((prev) => (prev.length === 0 && list.length === 0 ? prev : list));
  }, []);

  return { positions, alerts, state, seed, seedAlerts };
}
