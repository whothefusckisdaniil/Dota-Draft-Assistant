import { useState } from 'react';
import type { Hero } from '../types';

export function portraitUrl(h: Hero): string {
  return h.icon || h.img;
}

export function HeroPortrait({ hero, size = 40 }: { hero: Hero; size?: number }) {
  const [err, setErr] = useState(false);
  const initials = hero.name.split(/[\s'-]+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  if (err || !portraitUrl(hero)) {
    return (
      <div
        className="flex shrink-0 items-center justify-center rounded-md bg-[#21262d] font-semibold text-[#8b949e]"
        style={{ width: size, height: size, fontSize: size * 0.32 }}
        title={hero.name}
      >
        {initials}
      </div>
    );
  }
  return (
    <img
      src={portraitUrl(hero)}
      alt={hero.name}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setErr(true)}
      className="shrink-0 rounded-md border border-[#30363d] bg-[#21262d] object-cover"
      style={{ width: size, height: size }}
      title={hero.name}
    />
  );
}
