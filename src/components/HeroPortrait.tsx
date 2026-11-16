import { useState } from 'react';
import type { Hero } from '../types';

/**
 * Portraits are served as WebP from our own origin (public/heroes/<key>.webp,
 * scripts/fetch-portraits.mjs): ~8 KB instead of ~60 KB, cached offline by the
 * service worker, drawable on a canvas. A hero without a local file (new hero,
 * script not re-run yet) falls back to the Steam CDN image, then to initials.
 * `variant` is kept for callers; both use the same 256×144 source.
 */
export type PortraitVariant = 'large' | 'small';

export function localPortraitUrl(h: Hero): string {
  return `${import.meta.env.BASE_URL}heroes/${h.key.replace('npc_dota_hero_', '')}.webp`;
}

export function portraitUrl(h: Hero, variant: PortraitVariant = 'large'): string {
  return variant === 'large' ? h.img || h.icon : h.icon || h.img;
}

export function HeroPortrait({ hero, size = 40, fill = false, variant = 'large', eager = false }: {
  hero: Hero;
  size?: number;
  fill?: boolean;
  variant?: PortraitVariant;
  eager?: boolean;
}) {
  // 0 = local WebP, 1 = CDN, 2 = initials
  const [stage, setStage] = useState(0);
  const url = stage === 0 ? localPortraitUrl(hero) : portraitUrl(hero, variant);
  const initials = hero.name.split(/[\s'-]+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  if (stage >= 2 || !url) {
    return (
      <div
        className={`flex shrink-0 items-center justify-center bg-white/5 font-semibold text-muted ${fill ? 'h-full w-full' : 'rounded-md'}`}
        style={fill ? undefined : { width: size, height: size, fontSize: size * 0.32 }}
        title={hero.name}
        role="img"
        aria-label={hero.name}
      >
        {initials}
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={hero.name}
      width={fill ? 256 : size}
      height={fill ? 144 : size}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      onError={() => setStage((s) => s + 1)}
      className={`shrink-0 bg-white/5 object-cover ${fill ? 'h-full w-full' : 'rounded-md'}`}
      style={fill ? undefined : { width: size, height: size }}
      title={hero.name}
    />
  );
}
