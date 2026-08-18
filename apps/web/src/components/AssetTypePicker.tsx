'use client';
import { ASSET_TYPES, ASSET_LABEL, ASSET_PATH, type AssetType } from '@/lib/asset-icons';

/** Inline asset glyph (React). Same paths the map markers use. */
export function AssetGlyph({ type, size = 18, className = '' }: { type: AssetType; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={className}>
      <path d={ASSET_PATH[type] ?? ASSET_PATH.other} fill="currentColor" />
    </svg>
  );
}

/**
 * A row of icon discs to choose what a tracker is attached to. Mirrors how
 * the vehicle appears on the map — a coloured disc with the glyph — so the
 * choice previews itself.
 */
export function AssetTypePicker({
  value, onChange, disabled = false, size = 'md',
}: {
  value: AssetType;
  onChange: (t: AssetType) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
}) {
  const disc = size === 'sm' ? 'h-8 w-8' : 'h-11 w-11';
  const glyph = size === 'sm' ? 16 : 22;
  return (
    <div role="radiogroup" aria-label="Asset type" className="flex flex-wrap gap-2">
      {ASSET_TYPES.map((t) => {
        const on = t === value;
        return (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={ASSET_LABEL[t]}
            title={ASSET_LABEL[t]}
            disabled={disabled}
            onClick={() => onChange(t)}
            className={`grid ${disc} place-items-center rounded-full transition-all disabled:opacity-50 ${
              on
                ? 'bg-brand text-brand-fg ring-2 ring-brand ring-offset-2 ring-offset-surface'
                : 'bg-surface-2 text-fg-muted hover:bg-brand/15 hover:text-fg'
            }`}
          >
            <AssetGlyph type={t} size={glyph} />
          </button>
        );
      })}
    </div>
  );
}
