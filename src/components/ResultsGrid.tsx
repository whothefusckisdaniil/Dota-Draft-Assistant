import type { CandidateScore, Hero } from '../types';
import type { PositionFilter } from '../config';
import { BestCard, ResultRow } from './CandidateCard';
import { useI18n } from '../i18n';
import type { StringKey } from '../i18n/strings';

type Lane = Exclude<PositionFilter, 'all'>;

/** All roles: the best pick per role as one row each.
 *  One role: the big best-pick card, then #2–#15 as rows. Rows fade in 30 ms
 *  apart; the parent re-keys this on every draft change (crossfade). */
export function ResultsGrid({ results, heroById, onViewDetails, summary = false }: {
  results: Map<Lane, CandidateScore[]> | null;
  heroById: Map<number, Hero>;
  onViewDetails: (c: CandidateScore, lane: Lane) => void;
  summary?: boolean;
}) {
  const { t } = useI18n();
  if (!results) return null;
  const lanes = [...results.entries()];
  const title = (lane: Lane) => t(`lane.${lane}` as StringKey);

  if (summary) {
    return (
      <div className="stagger grid gap-2">
        {lanes.map(([lane, list], i) =>
          list.length === 0 ? (
            <div key={lane} className="result-row !cursor-default" style={{ '--i': i } as React.CSSProperties}>
              <span className="diamond diamond-outline mx-4 h-4 w-4 flex-none" aria-hidden="true" />
              <span className="min-w-0">
                <span className="label block text-accent">{title(lane)}</span>
                <span className="block text-[13px] leading-[18px] text-muted">{t('results.noDataRole')}</span>
              </span>
            </div>
          ) : (
            <ResultRow
              key={lane}
              c={list[0]}
              tag={title(lane)}
              style={{ '--i': i } as React.CSSProperties}
              onViewDetails={(candidate) => onViewDetails(candidate, lane)}
            />
          ),
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {lanes.map(([lane, list]) => (
        <section key={lane} aria-label={title(lane)}>
          {list.length === 0 ? (
            <div className="notice">{t('results.noHero')}</div>
          ) : (
            <>
              <BestCard c={list[0]} lane={title(lane)} heroById={heroById} onViewDetails={(candidate) => onViewDetails(candidate, lane)} />
              {list.length > 1 && (
                <>
                  <h3 className="label mb-2 mt-5">{t('results.more')}</h3>
                  <div className="stagger grid gap-2">
                    {list.slice(1).map((c, i) => (
                      <ResultRow
                        key={c.hero.id}
                        c={c}
                        rank={i + 2}
                        style={{ '--i': i } as React.CSSProperties}
                        onViewDetails={(candidate) => onViewDetails(candidate, lane)}
                      />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </section>
      ))}
    </div>
  );
}

/** Skeleton in the shape of the results (no spinners). */
export function ResultsSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="skeleton h-[236px]" />
      <div className="mt-5 grid gap-2">
        {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-16 !rounded-xl" />)}
      </div>
    </div>
  );
}
