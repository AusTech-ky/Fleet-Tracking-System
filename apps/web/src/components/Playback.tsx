'use client';
import { useEffect, useRef, useState } from 'react';
import type { Position } from '@/lib/types';

/**
 * Timeline scrubber for the selected device's history. Drag the slider or press
 * play to animate a marker along the route. Reports the scrubbed position up so
 * the map can render the playback marker.
 */
export function Playback({
  history,
  onScrub,
}: {
  history: Position[];
  onScrub: (p: Position | null) => void;
}) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset when the route changes (device switch / new data).
  useEffect(() => {
    setIndex(0);
    setPlaying(false);
  }, [history]);

  // Report the current scrub position to the map.
  useEffect(() => {
    onScrub(history.length ? history[Math.min(index, history.length - 1)] : null);
  }, [index, history, onScrub]);

  // Animate while playing.
  useEffect(() => {
    if (!playing || history.length < 2) return;
    timer.current = setInterval(() => {
      setIndex((i) => {
        if (i >= history.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 250);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, history]);

  if (history.length < 2) return null;
  const current = history[Math.min(index, history.length - 1)];

  return (
    <div className="absolute bottom-4 left-1/2 z-10 flex w-[min(680px,90%)] -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-surface/95 px-4 py-3 backdrop-blur">
      <button
        onClick={() => setPlaying((p) => !p)}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand text-brand-fg hover:bg-brand-dark"
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <input
        type="range"
        min={0}
        max={history.length - 1}
        value={index}
        onChange={(e) => {
          setPlaying(false);
          setIndex(Number(e.target.value));
        }}
        className="flex-1 accent-brand"
      />
      <div className="w-40 shrink-0 text-right text-xs text-fg-muted">
        {new Date(current.ts).toLocaleTimeString()} · {current.speedKph} km/h
      </div>
    </div>
  );
}
