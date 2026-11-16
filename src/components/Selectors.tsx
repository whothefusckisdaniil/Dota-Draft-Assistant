import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Hero } from '../types';
import { APP_CONFIG, POSITIONS, type PositionFilter } from '../config';
import { HeroPortrait } from './HeroPortrait';
import { shareableUrl } from '../data/draftUrl';
import { useI18n, type Lang } from '../i18n';
import type { StringKey } from '../i18n/strings';

/** Empty slot focuses the hero picker (§7): slots are part of the draft flow. */
function focusSearch() {
  document.getElementById('hero-search')?.focus();
}

type Target = 'enemy' | 'ally' | 'ban';

/** Enemy team (5 slots) or your team (4 slots + "you"). Clicking an empty slot
 *  switches the search to that team. */
export function TeamSlots({ team, ids, max, heroById, active, onRemove, onPickTarget, actions }: {
  team: 'enemy' | 'ally';
  ids: number[];
  max: number;
  heroById: Map<number, Hero>;
  active: boolean;
  onRemove: (id: number) => void;
  onPickTarget: (t: Target) => void;
  actions?: ReactNode;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const slots = Array.from({ length: max }, (_, i) => ids[i]);
  return (
    <div className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <h2 className={`text-[11px] font-bold uppercase tracking-[0.18em] ${active ? 'text-accent-2' : 'text-muted'}`}>
            {t(team === 'enemy' ? 'draft.title' : 'draft.allies')}
          </h2>
          <span className="text-xs font-semibold tabular-nums text-dim">{ids.length} / {max}</span>
        </div>
        {actions}
      </div>
      <div className={`grid gap-2.5 sm:gap-3 ${team === 'enemy' ? 'grid-cols-3 sm:grid-cols-5' : 'grid-cols-3 sm:grid-cols-5'}`}>
        {slots.map((id, i) => {
          const h = id !== undefined ? heroById.get(id) : undefined;
          if (!h) {
            return (
              <button
                key={`${team}${i}`}
                type="button"
                onClick={() => { onPickTarget(team); focusSearch(); }}
                className={`slot slot-empty ${team === 'ally' ? 'slot-ally' : ''}`}
                aria-label={t(team === 'enemy' ? 'draft.addHero' : 'draft.addAlly')}
              >
                <span aria-hidden="true" className="text-2xl font-light leading-none">+</span>
                <span className="text-[10px] font-bold uppercase tracking-widest">{t(team === 'enemy' ? 'draft.addHero' : 'draft.addAlly')}</span>
              </button>
            );
          }
          return (
            <div key={id} className={`slot fade-up ${team === 'ally' ? 'slot-ally' : ''}`}>
              <HeroPortrait hero={h} fill variant="large" />
              <div className="slot-overlay">
                <div className="truncate text-[13px] font-bold leading-tight text-ink sm:text-sm">{i18n.heroName(h)}</div>
                <div className="truncate text-[10px] text-muted">{h.roles.slice(0, 2).map(i18n.role).join(' · ')}</div>
              </div>
              <button type="button" onClick={() => onRemove(id)} aria-label={t('draft.remove', { name: i18n.heroName(h) })} className="slot-x">
                ×
              </button>
            </div>
          );
        })}
        {team === 'ally' && (
          <div className="slot slot-you" aria-hidden="true">
            <span className="text-[10px] font-bold uppercase tracking-widest">{t('draft.you')}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Banned heroes: excluded from recommendations and ban suggestions. */
export function BanRow({ ids, max, heroById, active, onRemove, onPickTarget }: {
  ids: number[];
  max: number;
  heroById: Map<number, Hero>;
  active: boolean;
  onRemove: (id: number) => void;
  onPickTarget: (t: Target) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline gap-3">
        <h2 className={`text-[11px] font-bold uppercase tracking-[0.18em] ${active ? 'text-accent-2' : 'text-muted'}`}>{t('draft.bans')}</h2>
        <span className="text-xs font-semibold tabular-nums text-dim">{ids.length} / {max}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {ids.map((id) => {
          const h = heroById.get(id);
          if (!h) return null;
          return (
            <span key={id} className="ban-chip fade-up">
              <span className="h-6 w-6 shrink-0 overflow-hidden rounded"><HeroPortrait hero={h} fill variant="small" /></span>
              <span className="truncate">{i18n.heroName(h)}</span>
              <button type="button" onClick={() => onRemove(id)} aria-label={t('draft.unban', { name: i18n.heroName(h) })} className="ban-chip-x">×</button>
            </span>
          );
        })}
        {ids.length < max && (
          <button type="button" onClick={() => { onPickTarget('ban'); focusSearch(); }} className="btn btn-ghost btn-sm">
            + {t('draft.addBan')}
          </button>
        )}
      </div>
    </div>
  );
}

/** Which list the search adds to. */
export function TargetSwitch({ value, onChange, counts, limits }: {
  value: Target;
  onChange: (t: Target) => void;
  counts: Record<Target, number>;
  limits: Record<Target, number>;
}) {
  const { t } = useI18n();
  const items: { id: Target; label: string }[] = [
    { id: 'enemy', label: t('target.enemy') },
    { id: 'ally', label: t('target.ally') },
    { id: 'ban', label: t('target.ban') },
  ];
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-semibold text-dim">{t('target.title')}</span>
      <div className="seg seg-sm" role="radiogroup" aria-label={t('target.title')}>
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            role="radio"
            aria-checked={value === it.id}
            disabled={counts[it.id] >= limits[it.id] && value !== it.id}
            onClick={() => onChange(it.id)}
            className={`seg-btn ${value === it.id ? 'is-active' : ''}`}
          >
            {it.label} <span className="tabular-nums opacity-70">{counts[it.id]}/{limits[it.id]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Kept for older callers: the enemy team only. */
export function EnemySlots({ enemies, heroById, onRemove, onClear }: {
  enemies: number[];
  heroById: Map<number, Hero>;
  onRemove: (id: number) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  return (
    <TeamSlots
      team="enemy"
      ids={enemies}
      max={APP_CONFIG.ui.maxEnemies}
      heroById={heroById}
      active
      onRemove={onRemove}
      onPickTarget={() => {}}
      actions={enemies.length > 0 ? (
        <div className="flex items-center gap-2">
          <ShareLinkButton />
          <button type="button" onClick={onClear} className="btn btn-ghost btn-sm">{t('draft.clear')}</button>
        </div>
      ) : undefined}
    />
  );
}

/** Copies the current draft link (the URL already encodes enemies, role and
 *  rank) so it can be pasted into Discord / Telegram. */
export function ShareLinkButton() {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(t);
  }, [state]);

  async function copy() {
    const url = shareableUrl(window.location.href);
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
    } catch {
      // Clipboard API blocked (insecure context, permissions): legacy fallback.
      const field = document.createElement('textarea');
      field.value = url;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(field);
      setState(ok ? 'copied' : 'failed');
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={`btn btn-ghost btn-sm ${state === 'copied' ? 'text-accent' : ''}`}
      title={t('draft.copyTitle')}
      aria-live="polite"
    >
      {state === 'copied' ? t('draft.copied') : state === 'failed' ? t('draft.copyFailed') : t('draft.copyLink')}
    </button>
  );
}

export function PositionTabs({ value, onChange }: { value: PositionFilter; onChange: (p: PositionFilter) => void }) {
  const { t } = useI18n();
  return (
    <div className="min-w-0">
      <div className="mb-2.5 flex items-center gap-3">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted">{t('role.title')}</h2>
        <span className="h-px flex-1 bg-line" />
      </div>
      <div className="seg" role="tablist" aria-label={t('role.select')}>
        {POSITIONS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={value === p.id}
            title={t(`pos.${p.id}.long` as StringKey)}
            onClick={() => onChange(p.id)}
            className={`seg-btn ${value === p.id ? 'is-active' : ''}`}
          >
            {t(`pos.${p.id}` as StringKey)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** EN / RU switch (header). */
export function LanguageSwitch() {
  const { lang, setLang, t } = useI18n();
  const options: { id: Lang; label: string; title: string }[] = [
    { id: 'en', label: 'EN', title: 'English' },
    { id: 'ru', label: 'RU', title: 'Русский' },
  ];
  return (
    <span className="flex overflow-hidden rounded-lg border border-line-2" role="group" aria-label={t('nav.language')}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          lang={o.id}
          title={o.title}
          aria-pressed={lang === o.id}
          onClick={() => setLang(o.id)}
          className={`px-2.5 py-1 text-[11px] font-bold tracking-wide ${lang === o.id ? 'bg-accent text-bg' : 'bg-surface text-muted hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

/** Official Dota 2 rank medals (public/ranks/*.png, 80px for 2× screens), two per STRATZ bracket. */
const RANK_MEDALS: Record<string, [string, string]> = {
  HERALD_GUARDIAN: ['herald', 'guardian'],
  CRUSADER_ARCHON: ['crusader', 'archon'],
  LEGEND_ANCIENT: ['legend', 'ancient'],
  DIVINE_IMMORTAL: ['divine', 'immortal'],
};
const medalSrc = (name: string) => `${import.meta.env.BASE_URL}ranks/${name}.png`;

/** Rank bracket selector (STRATZ brackets). Matchups differ a lot between
 *  Herald and Divine+, so the user can rank counters for their own bracket.
 *  Brackets are shown as rank medals; the full name is the tooltip/label. */
export function RankTabs({ value, options, onChange }: {
  value: string;
  options: string[];
  onChange: (rank: string) => void;
}) {
  const { t } = useI18n();
  const items = [{ id: 'ALL', label: t('rank.all') }, ...options.map((id) => ({ id, label: t(`rank.${id}` as StringKey) }))];
  // On narrow screens the strip scrolls sideways: keep the chosen rank visible
  // (a remembered "Divine–Immortal" would otherwise sit off-screen).
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = stripRef.current;
    const active = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !active) return;
    const left = active.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft || left + active.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = left - (strip.clientWidth - active.offsetWidth) / 2;
    }
  }, [value]);
  return (
    <div className="min-w-0">
      <div className="mb-2.5 flex items-center gap-3">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted">{t('rank.title')}</h2>
        <span className="h-px flex-1 bg-line" />
      </div>
      <div ref={stripRef} className="seg" role="tablist" aria-label={t('rank.select')}>
        {items.map((r) => {
          const medals = RANK_MEDALS[r.id];
          const active = value === r.id;
          return (
            <button
              key={r.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={r.label}
              title={r.id === 'ALL' ? t('rank.allTitle') : r.label}
              onClick={() => onChange(r.id)}
              className={`seg-btn ${medals ? 'rank-btn' : ''} ${active ? 'is-active' : ''}`}
            >
              {medals ? (
                <span className="flex items-center" aria-hidden="true">
                  {medals.map((m, i) => (
                    <img
                      key={m}
                      src={medalSrc(m)}
                      alt=""
                      title={t(`rank.medal.${m}` as StringKey)}
                      width={40}
                      height={40}
                      loading="lazy"
                      decoding="async"
                      className={`rank-medal ${i > 0 ? '-ml-2' : ''}`}
                    />
                  ))}
                </span>
              ) : (
                r.label
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
