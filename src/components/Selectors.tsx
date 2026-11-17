import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Hero } from '../types';
import { POSITIONS, type PositionFilter } from '../config';
import { HeroPortrait } from './HeroPortrait';
import { shareableUrl } from '../data/draftUrl';
import { useI18n, type Lang } from '../i18n';
import type { StringKey } from '../i18n/strings';

export type Target = 'enemy' | 'ally' | 'ban' | 'me';

/** Enemy team (5 slots) or your team (4 slots + "you"). An empty slot opens
 *  the hero picker for that team. Mobile: one row of 56 px slots; tablet and
 *  desktop: enemies stacked with names (CSS, see .enemy-slots). */
export function TeamSlots({ team, ids, max, heroById, active, onRemove, onAdd, title, actions, me = null, meActive = false, onRemoveMe }: {
  team: 'enemy' | 'ally';
  ids: number[];
  max: number;
  heroById: Map<number, Hero>;
  active: boolean;
  onRemove: (id: number) => void;
  onAdd: (t: Target) => void;
  title?: boolean;
  actions?: ReactNode;
  /** Your own hero in the "You" slot (team="ally"). */
  me?: number | null;
  meActive?: boolean;
  onRemoveMe?: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const meHero = me != null ? heroById.get(me) : undefined;
  const slots = Array.from({ length: max }, (_, i) => ids[i]);
  const firstEmpty = ids.length;
  const small = team === 'ally';
  return (
    <div className="min-w-0">
      {title !== false && (
        <div className="mb-2 flex min-h-[28px] items-center justify-between gap-2">
          <h2 className="label">
            <span className={active ? 'text-accent' : ''}>{t(team === 'enemy' ? 'draft.title' : 'draft.allies')}</span>
            <span className="tnum ml-2 font-semibold normal-case tracking-normal">{ids.length}/{max}</span>
          </h2>
          {actions}
        </div>
      )}
      <div className={`flex gap-2 ${team === 'enemy' ? 'enemy-slots' : ''}`}>
        {slots.map((id, i) => {
          const h = id !== undefined ? heroById.get(id) : undefined;
          const label = t(team === 'enemy' ? 'draft.addHero' : 'draft.addAlly');
          if (!h) {
            return (
              <div key={`${team}${i}`} className="slot-wrap">
                <button
                  type="button"
                  onClick={() => onAdd(team)}
                  className={`slot slot-empty ${small ? 'slot-sm' : ''} ${active && i === firstEmpty ? 'is-target' : ''}`}
                  aria-label={label}
                >
                  <span aria-hidden="true" className="slot-plus">+</span>
                </button>
                <span className="slot-name text-[13px] text-muted">{label}</span>
              </div>
            );
          }
          const name = i18n.heroName(h);
          return (
            <div key={id} className="slot-wrap">
              <div className={`slot slot-filled pop-in team-${team} ${small ? 'slot-sm' : ''}`}>
                <HeroPortrait hero={h} fill variant="large" />
                <button type="button" onClick={() => onRemove(id)} aria-label={t('draft.remove', { name })} className="slot-x">×</button>
              </div>
              <span className="slot-name min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{name}</span>
            </div>
          );
        })}
        {team === 'ally' && (meHero ? (
          <div className="slot-wrap">
            <div className="slot slot-filled slot-sm pop-in team-me" title={`${t('draft.you')}: ${i18n.heroName(meHero)}`}>
              <HeroPortrait hero={meHero} fill variant="large" />
              <button type="button" onClick={onRemoveMe} aria-label={t('draft.remove', { name: i18n.heroName(meHero) })} className="slot-x">×</button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onAdd('me')}
            className={`slot slot-sm slot-you ${meActive ? 'is-target' : ''}`}
            aria-label={t('draft.pickMe')}
            title={t('draft.pickMe')}
          >
            {t('draft.you')}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Banned heroes: excluded from recommendations and ban suggestions. */
export function BanRow({ ids, max, heroById, active, onRemove, onAdd }: {
  ids: number[];
  max: number;
  heroById: Map<number, Hero>;
  active: boolean;
  onRemove: (id: number) => void;
  onAdd: (t: Target) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <div className="min-w-0">
      <h2 className="label mb-2">
        <span className={active ? 'text-accent' : ''}>{t('draft.bans')}</span>
        <span className="tnum ml-2 font-semibold normal-case tracking-normal">{ids.length}/{max}</span>
      </h2>
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
        {ids.length < max && (
          <button type="button" onClick={() => onAdd('ban')} className={`btn btn-ghost btn-sm flex-none ${active ? '!border-accent/60 !text-accent' : ''}`}>
            + {t('draft.addBan')}
          </button>
        )}
        {ids.map((id) => {
          const h = heroById.get(id);
          if (!h) return null;
          return (
            <span key={id} className="ban-chip fade-up">
              <span className="h-7 w-7 shrink-0 overflow-hidden rounded-md"><HeroPortrait hero={h} fill variant="small" /></span>
              <span className="max-w-[120px] truncate">{i18n.heroName(h)}</span>
              <button type="button" onClick={() => onRemove(id)} aria-label={t('draft.unban', { name: i18n.heroName(h) })} className="ban-chip-x">×</button>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Which list a picked hero goes to. */
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
    { id: 'me', label: t('target.me') },
  ];
  return (
    <div className="seg seg-sm" role="radiogroup" aria-label={t('target.title')}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="radio"
          aria-checked={value === it.id}
          disabled={it.id !== 'me' && counts[it.id] >= limits[it.id] && value !== it.id}
          onClick={() => onChange(it.id)}
          className={`seg-btn target-btn ${value === it.id ? 'is-active' : ''}`}
        >
          {it.label}{it.id !== 'me' && <span className="count tnum">{counts[it.id]}/{limits[it.id]}</span>}
        </button>
      ))}
    </div>
  );
}

/** Copies the current draft link (the URL already encodes the whole draft). */
export function ShareLinkButton() {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(timer);
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
      className={`btn btn-ghost btn-sm ${state === 'copied' ? '!text-accent' : ''}`}
      title={t('draft.copyTitle')}
      aria-live="polite"
    >
      {state === 'copied' ? t('draft.copied') : state === 'failed' ? t('draft.copyFailed') : t('draft.copyLink')}
    </button>
  );
}

/** Role tabs: All · 1 · 2 · 3 · 4 · 5, each number with a caption. */
export function PositionTabs({ value, onChange }: { value: PositionFilter; onChange: (p: PositionFilter) => void }) {
  const { t } = useI18n();
  return (
    <div className="seg" role="tablist" aria-label={t('role.select')}>
      {POSITIONS.map((p) => (
        <button
          key={p.id}
          type="button"
          role="tab"
          aria-selected={value === p.id}
          title={t(`pos.${p.id}.long` as StringKey)}
          onClick={() => onChange(p.id)}
          className={`role-tab ${value === p.id ? 'is-active' : ''}`}
        >
          {p.id === 'all' ? (
            <b className="!text-[13px]">{t('pos.all')}</b>
          ) : (
            <>
              <b>{p.id}</b>
              <small>{t(`pos.sub.${p.id}` as StringKey)}</small>
            </>
          )}
        </button>
      ))}
    </div>
  );
}

/** EN / RU switch (header). */
export function LanguageSwitch() {
  const { lang, setLang, t } = useI18n();
  const next: Lang = lang === 'ru' ? 'en' : 'ru';
  return (
    <button
      type="button"
      onClick={() => setLang(next)}
      className="chip !px-3 font-display !text-[12px]"
      aria-label={`${t('nav.language')}: ${next === 'ru' ? 'Русский' : 'English'}`}
      title={next === 'ru' ? 'Русский' : 'English'}
      lang={next}
    >
      <span className={lang === 'ru' ? 'text-ink' : 'text-muted'}>RU</span>
      <span className="text-line-2" aria-hidden="true">/</span>
      <span className={lang === 'en' ? 'text-ink' : 'text-muted'}>EN</span>
    </button>
  );
}

/** Official Dota 2 rank medals (public/ranks/*.png), two per STRATZ bracket. */
const RANK_MEDALS: Record<string, [string, string]> = {
  HERALD_GUARDIAN: ['herald', 'guardian'],
  CRUSADER_ARCHON: ['crusader', 'archon'],
  LEGEND_ANCIENT: ['legend', 'ancient'],
  DIVINE_IMMORTAL: ['divine', 'immortal'],
};
const medalSrc = (name: string) => `${import.meta.env.BASE_URL}ranks/${name}.png`;

export function Medals({ id, size = 32 }: { id: string; size?: number }) {
  const medals = RANK_MEDALS[id] ?? ['herald', 'immortal'];
  return (
    <span className="flex flex-none items-center" aria-hidden="true">
      {medals.map((m, i) => (
        <img
          key={m}
          src={medalSrc(m)}
          alt=""
          width={size}
          height={size}
          decoding="async"
          className="rank-medal"
          style={{ width: size, height: size, marginLeft: i > 0 ? -size * 0.35 : 0, opacity: RANK_MEDALS[id] ? 1 : 0.85 }}
        />
      ))}
    </span>
  );
}

/** Header rank chip: medal + name; opens the bracket menu. */
export function RankChip({ value, options, onChange }: {
  value: string;
  options: string[];
  onChange: (rank: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (options.length === 0) return null;
  const label = (id: string) => (id === 'ALL' ? t('rank.all') : t(`rank.${id}` as StringKey));
  const items = ['ALL', ...options];
  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        className="chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t('rank.title')}: ${label(value)}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Medals id={value} size={28} />
        <span className="max-[399px]:hidden">{label(value)}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="text-muted"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <div className="menu" role="menu" aria-label={t('rank.select')}>
          {items.map((id) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={value === id}
              title={id === 'ALL' ? t('rank.allTitle') : undefined}
              onClick={() => { onChange(id); setOpen(false); }}
              className="menu-item"
            >
              <Medals id={id} size={32} />
              <span>{label(id)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
