import { useEffect, useMemo, useRef, useState } from 'react';
import type { Hero } from '../types';
import { searchHeroes } from '../data/heroes';
import { HeroPortrait } from './HeroPortrait';

interface Props {
  heroes: Hero[];
  excluded: Set<number>;
  onPick: (hero: Hero) => void;
  disabled?: boolean;
}

export function HeroSearch({ heroes, excluded, onPick, disabled }: Props) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => searchHeroes(heroes, q).filter((h) => !excluded.has(h.id)), [heroes, q, excluded]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => setHi(0), [q]);

  function pick(h: Hero) {
    onPick(h);
    setQ('');
    setOpen(false);
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        value={q}
        disabled={disabled}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); if (results.length === 0) return; setHi((v) => Math.min(v + 1, results.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); if (results.length === 0) return; setHi((v) => Math.max(v - 1, 0)); }
          else if (e.key === 'Enter' && results.length > 0 && results[hi]) { e.preventDefault(); pick(results[hi]); }
          else if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="Search hero… (jug / пак / anti)"
        className="w-full rounded-lg border border-[#30363d] bg-[#0d1117] px-4 py-2.5 text-sm text-[#e6edf3] placeholder-[#6e7681] outline-none focus:border-[#58a6ff]"
      />
      {open && q.trim().length > 0 && (
        <div className="nice-scroll absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-[#30363d] bg-[#161b22] shadow-xl">
          {results.length === 0 && (
            <div className="px-4 py-3 text-sm text-[#8b949e]">No heroes found for “{q}”.</div>
          )}
          {results.map((h, i) => (
            <button
              key={h.id}
              type="button"
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(h)}
              className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm ${i === hi ? 'bg-[#21262d]' : ''}`}
            >
              <HeroPortrait hero={h} size={32} />
              <span className="flex-1">
                <span className="block text-[#e6edf3]">{h.name}</span>
                {h.nameRu && <span className="block text-xs text-[#8b949e]">{h.nameRu} · {h.roles.slice(0, 3).join(' / ')}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
