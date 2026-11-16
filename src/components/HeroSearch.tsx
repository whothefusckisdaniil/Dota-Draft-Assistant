import { useEffect, useMemo, useRef, useState } from 'react';
import type { Hero } from '../types';
import { searchHeroes } from '../data/heroes';
import { HeroPortrait } from './HeroPortrait';
import { useI18n } from '../i18n';

interface Props {
  heroes: Hero[];
  excluded: Set<number>;
  onPick: (hero: Hero) => void;
  disabled?: boolean;
}

export function HeroSearch({ heroes, excluded, onPick, disabled }: Props) {
  const i18n = useI18n();
  const { t } = i18n;
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
      <span aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 z-10 -translate-y-1/2 text-sm text-muted">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" />
        </svg>
      </span>
      <input
        id="hero-search"
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
        placeholder={t('search.placeholder')}
        aria-label={t('search.label')}
        autoComplete="off"
        className="field"
      />
      {open && q.trim().length > 0 && (
        <div className="drop nice-scroll" role="listbox" aria-label={t('search.results')}>
          {results.length === 0 && (
            <div className="px-4 py-3 text-sm text-muted">{t('search.none', { q })}</div>
          )}
          {results.map((h, i) => (
            <button
              key={h.id}
              type="button"
              role="option"
              aria-selected={i === hi}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(h)}
              className={`drop-item ${i === hi ? 'is-hi' : ''}`}
            >
              <span className="h-9 w-9 shrink-0 overflow-hidden rounded-md">
                <HeroPortrait hero={h} fill variant="small" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-ink">{i18n.heroName(h)}</span>
                <span className="block truncate text-xs text-muted">
                  {/* the other language's name helps match the in-game (English) name */}
                  {i18n.lang === 'ru' ? `${h.name} · ` : h.nameRu ? `${h.nameRu} · ` : ''}
                  {h.roles.slice(0, 3).map(i18n.role).join(' / ')}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
