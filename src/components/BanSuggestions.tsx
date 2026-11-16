import type { Hero } from '../types';
import type { BanSuggestion } from '../scoring/bans';
import { useI18n } from '../i18n';
import { HeroPortrait } from './HeroPortrait';
import { scoreText } from './CandidateCard';

/** "Who to ban": heroes that counter your team or fit the enemy team.
 *  Clicking one bans it (it then drops out of every list). */
export function BanSuggestions({ items, heroById, canBan, onBan }: {
  items: BanSuggestion[];
  heroById: Map<number, Hero>;
  canBan: boolean;
  onBan: (id: number) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  if (items.length === 0) return null;
  const names = (ids: number[]) =>
    ids.map((id) => { const h = heroById.get(id); return h ? i18n.heroName(h) : `#${id}`; }).join(', ');

  return (
    <section className="mt-6" aria-labelledby="ban-suggestions-title">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[3px] bg-[#E06060]" />
          <h2 id="ban-suggestions-title" className="text-[13px] font-extrabold uppercase tracking-[0.2em] text-ink">{t('bans.title')}</h2>
        </div>
        <span className="text-[11px] text-dim">{t('bans.hint')}</span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((b) => {
          // the strongest reasons: who it beats on your team, who it fits on theirs
          const threats = [...b.threats].sort((x, y) => y.delta - x.delta).filter((x) => x.delta > 0.5).slice(0, 2);
          const fits = [...b.fits].sort((x, y) => y.delta - x.delta).filter((x) => x.delta > 0.5).slice(0, 2);
          const name = i18n.heroName(b.hero);
          return (
            <button
              key={b.hero.id}
              type="button"
              disabled={!canBan}
              onClick={() => onBan(b.hero.id)}
              aria-label={t('bans.ban', { name })}
              title={t('bans.ban', { name })}
              className="ranking-row !items-start text-left disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="h-9 w-11 shrink-0 overflow-hidden rounded-md">
                <HeroPortrait hero={b.hero} fill variant="large" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-[12px] font-bold uppercase leading-tight text-ink">{name}</span>
                  <span className="ml-auto shrink-0 text-[13px] font-extrabold tabular-nums text-[#F0918A]">{scoreText(b.score)}</span>
                </span>
                {threats.length > 0 && (
                  <span className="mt-1 block truncate text-[10px] text-muted">{t('bans.counters', { names: names(threats.map((x) => x.allyId)) })}</span>
                )}
                {fits.length > 0 && (
                  <span className="mt-0.5 block truncate text-[10px] text-muted">{t('bans.fits', { names: names(fits.map((x) => x.enemyId)) })}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
