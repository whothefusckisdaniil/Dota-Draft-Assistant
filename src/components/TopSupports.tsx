import { useMemo, useState } from 'react';
import type { Hero } from '../types';
import type { RoleStats } from '../data/dataset';
import { topHeroesForPosition } from '../scoring/topByRole';
import { useI18n } from '../i18n';
import type { StringKey } from '../i18n/strings';
import { HeroPortrait } from './HeroPortrait';
import { Medals } from './Selectors';

const pct = (x: number) => (x * 100 >= 10 ? Math.round(x * 100).toString() : (x * 100).toFixed(1));

/** Empty-draft screen: the strongest pos 4 / pos 5 heroes in the chosen rank,
 *  by their win rate on that position. Shares the rank with the header chip. */
export function TopSupports({ stats, heroes, rank, rankOptions, onRank, initialPos }: {
  stats: RoleStats | null | undefined;
  heroes: Hero[];
  rank: string;
  rankOptions: string[];
  onRank: (rank: string) => void;
  initialPos: 4 | 5;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [pos, setPos] = useState<4 | 5>(initialPos);
  const list = useMemo(() => topHeroesForPosition(stats ?? null, heroes, rank, pos), [stats, heroes, rank, pos]);
  if (stats === null) return null; // snapshot without this layer: hide quietly
  const rankLabel = (id: string) => (id === 'ALL' ? t('rank.all') : t(`rank.${id}` as StringKey));
  const ranks = ['ALL', ...rankOptions];

  return (
    <section className="min-w-0 rounded-[14px] border border-line bg-surface p-3 sm:p-5" aria-labelledby="top-supports-title">
      <h2 id="top-supports-title" className="font-display text-[16px] font-bold leading-5 text-ink sm:text-[20px] sm:leading-6">{t('top.title')}</h2>
      <p className="mt-1 text-[13px] leading-4 text-muted">{t('top.sub', { rank: rankLabel(rank) })}</p>

      <div className="seg mt-4" role="tablist" aria-label={t('role.select')}>
        {([4, 5] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={pos === p}
            onClick={() => setPos(p)}
            className={`seg-btn ${pos === p ? 'is-active' : ''}`}
          >
            {t(p === 4 ? 'top.pos4' : 'top.pos5')}
            <span className="max-sm:hidden"> · {t(p === 4 ? 'top.pos4sub' : 'top.pos5sub')}</span>
          </button>
        ))}
      </div>

      {ranks.length > 1 && (
        <div className="no-scrollbar -mx-3 mt-2 flex gap-2 overflow-x-auto px-3 sm:-mx-5 sm:px-5" role="tablist" aria-label={t('rank.select')}>
          {ranks.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={rank === id}
              title={id === 'ALL' ? t('rank.allTitle') : rankLabel(id)}
              onClick={() => onRank(id)}
              className={`chip flex-none ${rank === id ? '!border-accent !bg-accent/10 !text-accent' : ''}`}
            >
              <Medals id={id} size={24} />
              <span className="whitespace-nowrap">{rankLabel(id)}</span>
            </button>
          ))}
        </div>
      )}

      {stats === undefined ? (
        <div className="mt-4 grid gap-2" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-16 !rounded-xl" />)}
        </div>
      ) : list.length === 0 ? (
        <p className="notice mt-4">{t('top.none')}</p>
      ) : (
        <ol key={`${rank}-${pos}`} className="stagger mt-4 grid grid-cols-[minmax(0,1fr)] gap-2">
          {list.map((x, i) => {
            const delta = x.winrate - 50;
            const name = i18n.heroName(x.hero);
            return (
              <li
                key={x.hero.id}
                className="flex min-h-16 min-w-0 items-center gap-2.5 rounded-xl border border-line bg-bg-2 py-2 pl-1.5 pr-3"
                style={{ '--i': i } as React.CSSProperties}
              >
                <span className="tnum w-4 shrink-0 text-center text-[11px] font-semibold text-muted">{i + 1}</span>
                <span className="h-12 w-12 shrink-0 overflow-hidden rounded-lg">
                  <HeroPortrait hero={x.hero} fill variant="large" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold leading-5 text-ink">{name}</span>
                  <span className="block truncate text-[11px] leading-[14px] text-muted" title={t('top.row', { pick: pct(x.pickRate), share: pct(x.laneShare) })}>
                    {i18n.number(Math.round(x.games))} {i18n.plural(Math.round(x.games), 'game')}
                    <span className="max-sm:hidden"> · {t('top.row', { pick: pct(x.pickRate), share: pct(x.laneShare) })}</span>
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="tnum block font-display text-[16px] font-bold leading-5 text-ink">{x.winrate.toFixed(1)}%</span>
                  <span
                    className={`tnum block text-[11px] font-semibold leading-[14px] ${delta > 0.05 ? 'text-pos' : delta < -0.05 ? 'text-neg' : 'text-muted'}`}
                    title={t('top.vs50')}
                  >
                    {delta > 0 ? '+' : delta < 0 ? '−' : ''}{Math.abs(delta).toFixed(1)}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <p className="mt-4 text-[11px] leading-[14px] text-muted">{t('top.note')}</p>
    </section>
  );
}
