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
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id="ban-suggestions-title" className="label">{t('bans.title')}</h2>
        <span className="hidden text-[11px] leading-[14px] text-muted sm:block">{t('bans.hint')}</span>
      </div>
      <div className="no-scrollbar -mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:grid md:grid-cols-2 md:px-0 2xl:grid-cols-3">
        {items.map((b, i) => {
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
              className="result-row fade-up w-[240px] flex-none snap-start !items-start md:w-auto"
              style={{ animationDelay: `${i * 30}ms` }}
            >
              <span className="h-12 w-12 shrink-0 overflow-hidden rounded-lg">
                <HeroPortrait hero={b.hero} fill variant="large" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-[15px] font-semibold leading-5 text-ink">{name}</span>
                  <span className="tnum ml-auto shrink-0 text-[13px] font-semibold text-neg">{scoreText(b.score)}</span>
                </span>
                {threats.length > 0 && (
                  <span className="mt-0.5 block truncate text-[11px] leading-[14px] text-muted">{t('bans.counters', { names: names(threats.map((x) => x.allyId)) })}</span>
                )}
                {fits.length > 0 && (
                  <span className="mt-0.5 block truncate text-[11px] leading-[14px] text-muted">{t('bans.fits', { names: names(fits.map((x) => x.enemyId)) })}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
