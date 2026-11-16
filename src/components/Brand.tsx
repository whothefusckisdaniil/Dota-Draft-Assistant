import { useId } from 'react';

/* LASTPICK mark: a rounded diamond (the 5th draft slot) with an "advantage"
   arrow cut out of it, kept fully inside the diamond. Same geometry as
   public/brand/*.svg. Up to 32 px a bolder arrow keeps it legible. */
const DIAMOND =
  'M44.48 9.52A7.8 7.8 0 0 1 55.52 9.52L90.48 44.48A7.8 7.8 0 0 1 90.48 55.52L55.52 90.48A7.8 7.8 0 0 1 44.48 90.48L9.52 55.52A7.8 7.8 0 0 1 9.52 44.48Z';
const ARROW = 'M27 44 L53 44 L53 31 L75 50 L53 69 L53 56 L27 56 Z';
const ARROW_BOLD = 'M29 42 L49 42 L49 28 L73 50 L49 72 L49 58 L29 58 Z';

export function LogoMark({ size = 28, className = '', glow = false }: { size?: number; className?: string; glow?: boolean }) {
  const id = useId().replace(/:/g, '');
  const small = size <= 32;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      className={className}
      style={glow ? { filter: 'drop-shadow(0 0 12px rgba(255, 180, 58, 0.35))' } : undefined}
    >
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="4" x2="0" y2="96" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFC857" />
          <stop offset="1" stopColor="#FF9F1C" />
        </linearGradient>
        <mask id={`${id}m`} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <rect width="100" height="100" fill="#fff" />
          <path d={small ? ARROW_BOLD : ARROW} transform="rotate(-45 50 50)" fill="#000" />
        </mask>
      </defs>
      <path d={DIAMOND} fill={`url(#${id}g)`} mask={`url(#${id}m)`} />
    </svg>
  );
}

/** Horizontal logo: mark + LASTPICK (LAST white, PICK amber), Unbounded Bold. */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark size={compact ? 22 : 26} glow />
      <span className="font-display text-[17px] font-bold leading-none tracking-[0.02em]">
        <span className="text-[#F2F5FA]">LAST</span>
        <span className="text-accent">PICK</span>
      </span>
    </span>
  );
}

/** Five diamonds lighting up left to right — the loader. */
export function DiamondLoader({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-3" role="status" aria-live="polite">
      <span className="diamond-loader" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => <i key={i} className="diamond" />)}
      </span>
      {label && <span className="text-[13px] text-muted">{label}</span>}
    </span>
  );
}

/** Five empty slots — the empty state. */
export function EmptyDiamonds() {
  return (
    <span className="inline-flex gap-3" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => <i key={i} className="diamond diamond-outline h-4 w-4" />)}
    </span>
  );
}
