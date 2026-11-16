import type { CandidateScore, Hero } from '../types';
import type { PositionFilter } from '../config';
import { BestPickCard, CandidateCard, RankingRow } from './CandidateCard';
import { useI18n } from '../i18n';
import type { StringKey } from '../i18n/strings';

type Lane = Exclude<PositionFilter, 'all'>;

/** Lane sections: #1 gets the dominant Best Pick card and #2–#15 sit beside it
 *  as one compact ranked-alternatives list (2-col rows; stacked under lg).
 *  summary (ALL mode) renders only the top pick per role as a compact card —
 *  detailed ranking belongs to a selected position (FINAL UX PASS, P1). */
export function ResultsGrid({ results, heroById, onViewDetails, summary = false }: {
  results: Map<Lane, CandidateScore[]> | null;
  heroById: Map<number, Hero>;
  onViewDetails: (c: CandidateScore, lane: Lane) => void;
  summary?: boolean;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  if (!results) return null;
  const lanes = [...results.entries()];
  const title = (lane: Lane) => t(`lane.${lane}` as StringKey);

  if (summary) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {lanes.map(([lane, list]) =>
          list.length === 0 ? (
            <div key={lane} className="rec-best !cursor-default">
              <div className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-accent-2">{title(lane)}</div>
              <p className="mt-3 text-xs leading-snug text-muted">{t('results.noDataRole')}</p>
            </div>
          ) : (
            <BestPickCard
              key={lane}
              c={list[0]}
              title={title(lane)}
              heroById={heroById}
              onViewDetails={(candidate) => onViewDetails(candidate, lane)}
            />
          ),
        )}
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {lanes.map(([lane, list]) => (
        <section key={lane}>
          <div className="mb-4 flex items-center gap-3">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[3px] bg-accent" />
            <h3 className="text-[13px] font-extrabold uppercase tracking-[0.2em] text-ink">{title(lane)}</h3>
            <span className="h-px flex-1 bg-line" />
            {list.length > 0 && (
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-dim">
                {list.length} {i18n.plural(list.length, 'pick')}
              </span>
            )}
          </div>
          {list.length === 0 ? (
            <div className="panel-2 px-4 py-5 text-sm text-muted">{t('results.noHero')}</div>
          ) : list.length === 1 ? (
            <CandidateCard c={list[0]} rank={1} lane={title(lane)} heroById={heroById} onViewDetails={(candidate) => onViewDetails(candidate, lane)} />
          ) : (
            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <CandidateCard c={list[0]} rank={1} lane={title(lane)} heroById={heroById} onViewDetails={(candidate) => onViewDetails(candidate, lane)} />
              <div className="fade-up">
                <div className="mb-2.5 flex items-center gap-3">
                  <h4 className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-dim">
                    {t('results.alternatives')}
                  </h4>
                  <span className="h-px flex-1 bg-line" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {list.slice(1).map((c, i) => (
                    <RankingRow key={c.hero.id} c={c} rank={i + 2} onViewDetails={(candidate) => onViewDetails(candidate, lane)} />
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
