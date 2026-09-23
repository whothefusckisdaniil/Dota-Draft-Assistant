import { useState } from 'react';
import type { Hero } from '../types';

/**
 * Portrait quality (FINAL UX PASS, P0):
 *  - large → full-resolution hero.img (cards, draft slots, drawer) — the tiny
 *    `icon` must never stretch onto a big card (pixelated smear).
 *  - small → hero.icon for thumbnails (search dropdown), img only as fallback.
 */
export type PortraitVariant = 'large' | 'small';

export function portraitUrl(h: Hero, variant: PortraitVariant = 'large'): string {
  return variant === 'large' ? h.img || h.icon : h.icon || h.img;
}

export function HeroPortrait({ hero, size = 40, fill = false, variant = 'large' }: {
  hero: Hero;
  size?: number;
  fill?: boolean;
  variant?: PortraitVariant;
}) {
  const [err, setErr] = useState(false);
  const url = portraitUrl(hero, variant);
  const initials = hero.name.split(/[\s'-]+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  if (err || !url) {
    return (
      <div
        className={`flex shrink-0 items-center justify-center rounded-md bg-white/5 font-semibold text-[#8B929D] ${fill ? 'h-full w-full' : ''}`}
        style={fill ? undefined : { width: size, height: size, fontSize: size * 0.32 }}
        title={hero.name}
        role="img"
        aria-label={`${hero.name} portrait unavailable`}
      >
        {initials}
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={hero.name}
      width={fill ? undefined : size}
      height={fill ? undefined : size}
      loading="lazy"
      onError={() => setErr(true)}
      className={`shrink-0 bg-white/5 object-cover ${fill ? 'h-full w-full' : 'rounded-md border border-white/10'}`}
      style={fill ? undefined : { width: size, height: size }}
      title={hero.name}
    />
  );
}
