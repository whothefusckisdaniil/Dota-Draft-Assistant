import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { Hero } from '../types';
import { searchHeroes } from '../data/heroes';
import { HeroPortrait } from './HeroPortrait';
import { useI18n } from '../i18n';
import type { StringKey } from '../i18n/strings';

type Attr = 'any' | 'str' | 'agi' | 'int' | 'all';
const ATTRS: Attr[] = ['any', 'str', 'agi', 'int', 'all'];
const ATTR_DOT: Record<Attr, string> = { any: '', str: '#E5484D', agi: '#3DDC97', int: '#4FA3FF', all: '#C9A0FF' };

/** Hero grid with search (RU + EN + slang) and attribute tabs. Tap = pick.
 *  Used in the picker sheet (phones, tablets) and as the always-visible left
 *  column on desktop. */
export function HeroPool({ heroes, taken, onPick, autoFocus = false, inputId, header }: {
  heroes: Hero[];
  taken: Set<number>;
  onPick: (h: Hero) => void;
  autoFocus?: boolean;
  inputId?: string;
  header?: ReactNode;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [q, setQ] = useState('');
  const [attr, setAttr] = useState<Attr>('any');
  const inputRef = useRef<HTMLInputElement>(null);

  const sorted = useMemo(
    () => [...heroes].sort((a, b) => i18n.heroName(a).localeCompare(i18n.heroName(b), i18n.lang)),
    [heroes, i18n],
  );
  const list = useMemo(() => {
    if (q.trim()) return searchHeroes(heroes, q, heroes.length);
    return attr === 'any' ? sorted : sorted.filter((h) => h.primaryAttr === attr);
  }, [q, attr, heroes, sorted]);

  function pick(h: Hero) {
    if (taken.has(h.id)) return;
    onPick(h);
    if (q) {
      setQ('');
      inputRef.current?.focus();
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <div className="relative">
        <span aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" />
          </svg>
        </span>
        <input
          ref={inputRef}
          id={inputId}
          value={q}
          autoFocus={autoFocus}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const first = list.find((h) => !taken.has(h.id));
              if (first) { e.preventDefault(); pick(first); }
            }
          }}
          placeholder={t('picker.open')}
          aria-label={t('search.label')}
          autoComplete="off"
          enterKeyHint="done"
          className="field"
        />
      </div>
      <div className="seg seg-sm mt-2 flex-none" role="tablist" aria-label={t('search.label')}>
        {ATTRS.map((a) => (
          <button
            key={a}
            type="button"
            role="tab"
            aria-selected={!q && attr === a}
            onClick={() => { setAttr(a); setQ(''); }}
            className={`seg-btn inline-flex items-center justify-center gap-1.5 ${!q && attr === a ? 'is-active' : ''}`}
          >
            {a !== 'any' && <span aria-hidden="true" className="h-2 w-2 rotate-45 rounded-[2px]" style={{ background: ATTR_DOT[a] }} />}
            {t(`attr.${a}` as StringKey)}
          </button>
        ))}
      </div>
      <div className="nice-scroll mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
        {list.length === 0 ? (
          <p className="px-1 py-6 text-center text-[13px] text-muted">{t('search.none', { q })}</p>
        ) : (
          <div className="hero-grid" role="list">
            {list.map((h) => {
              const isTaken = taken.has(h.id);
              const name = i18n.heroName(h);
              return (
                <button
                  key={h.id}
                  type="button"
                  role="listitem"
                  disabled={isTaken}
                  onClick={() => pick(h)}
                  title={isTaken ? `${name} — ${t('picker.taken')}` : name}
                  aria-label={name}
                  className="hero-tile"
                >
                  <HeroPortrait hero={h} fill variant="large" />
                  <span className="name">{name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
