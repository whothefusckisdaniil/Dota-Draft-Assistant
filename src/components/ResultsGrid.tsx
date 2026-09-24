import type { CandidateScore, Hero } from '../types';
import { BestPickCard, CandidateCard, RankingRow } from './CandidateCard';

const TITLES: Record<string, string> = {
  1: 'CARRY',
  2: 'MID',
  3: 'OFFLANE',
  4: 'POSITION 4',
  5: 'POSITION 5',
};

/** Lane sections: #1 gets the dominant Best Pick card and #2–#15 sit beside it
 *  as one compact ranked-alternatives list (2-col rows; stacked under lg).
 *  summary (ALL mode) renders only the top pick per role as a compact card —
 *  detailed ranking belongs to a selected position (FINAL UX PASS, P1). */
export function ResultsGrid({ results, heroById, onViewDetails, summary = false }: {
  results: Map<string, CandidateScore[]> | null;
  heroById: Map<number, Hero>;
  onViewDetails: (c: CandidateScore) => void;
  summary?: boolean;
}) {
  if (!results) return null;
  const lanes = [...results.entries()];

  if (summary) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {lanes.map(([lane, list]) =>
          list.length === 0 ? (
            <div key={lane} className="rec-best !cursor-default">
              <div className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-accent-2">{TITLES[lane] ?? lane}</div>
              <p className="mt-3 text-xs leading-snug text-muted">
                Not enough matchup data to rank this role against the full draft.
              </p>
            </div>
          ) : (
            <BestPickCard key={lane} c={list[0]} title={TITLES[lane] ?? lane} onViewDetails={onViewDetails} />
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
            <h3 className="text-[13px] font-extrabold uppercase tracking-[0.2em] text-ink">
              {TITLES[lane] ?? lane}
            </h3>
            <span className="h-px flex-1 bg-line" />
            {list.length > 0 && (
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-dim">
                {list.length} {list.length === 1 ? 'pick' : 'picks'}
              </span>
            )}
          </div>
          {list.length === 0 ? (
            <div className="panel-2 px-4 py-5 text-sm text-muted">
              No hero has usable matchup data vs every selected enemy for this role.
            </div>
          ) : list.length === 1 ? (
            <CandidateCard c={list[0]} rank={1} heroById={heroById} onViewDetails={onViewDetails} />
          ) : (
            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <CandidateCard c={list[0]} rank={1} heroById={heroById} onViewDetails={onViewDetails} />
              <div className="fade-up">
                <div className="mb-2.5 flex items-center gap-3">
                  <h4 className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-dim">
                    Ranked alternatives
                  </h4>
                  <span className="h-px flex-1 bg-line" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {list.slice(1).map((c, i) => (
                    <RankingRow key={c.hero.id} c={c} rank={i + 2} onViewDetails={onViewDetails} />
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
