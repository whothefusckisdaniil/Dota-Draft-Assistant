import type { CandidateScore, Hero } from '../types';
import { CandidateCard } from './CandidateCard';

const TITLES: Record<string, string> = {
  1: 'CARRY',
  2: 'MID',
  3: 'OFFLANE',
  4: 'POSITION 4',
  5: 'POSITION 5',
};

export function ResultsGrid({ results, heroById, onViewDetails }: {
  results: Map<string, CandidateScore[]> | null;
  heroById: Map<number, Hero>;
  onViewDetails: (c: CandidateScore) => void;
}) {
  if (!results) return null;
  const lanes = [...results.entries()];
  const multi = lanes.length > 1;
  return (
    <div className={multi ? 'grid gap-6 lg:grid-cols-2 xl:grid-cols-3' : 'grid gap-6'}>
      {lanes.map(([lane, list]) => (
        <section key={lane} className={multi ? '' : 'mx-auto w-full max-w-2xl'}>
          <h3 className="mb-3 text-sm font-bold uppercase tracking-widest text-[#e6edf3]">
            {TITLES[lane] ?? lane}
          </h3>
          {list.length === 0 ? (
            <div className="rounded-xl border border-[#30363d] bg-[#161b22] p-4 text-sm text-[#8b949e]">
              No hero has usable matchup data vs every selected enemy for this role.
            </div>
          ) : (
            <div className="space-y-3">
              {list.map((c, i) => (
                <CandidateCard key={c.hero.id} c={c} rank={i + 1} heroById={heroById} onViewDetails={onViewDetails} />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
