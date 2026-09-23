import type { CandidateScore, Hero } from '../types';
import { HeroPortrait } from './HeroPortrait';

function ScoreBadge({ v }: { v: number }) {
  const cls = v >= 5 ? 'text-[#3fb950]' : v >= 1.5 ? 'text-[#d29922]' : 'text-[#8b949e]';
  return <span className={`font-mono text-lg font-bold ${cls}`}>{v > 0 ? '+' : ''}{v.toFixed(2)}</span>;
}

export function CandidateCard({ c, rank, heroById, onViewDetails }: {
  c: CandidateScore; rank: number; heroById: Map<number, Hero>;
  onViewDetails: (c: CandidateScore) => void;
}) {
  void heroById;
  const coverage = c.matchups.filter((m) => m.usable).length;
  return (
    <div className="fade-up rounded-xl border border-[#30363d] bg-[#161b22] p-3">
      <div className="flex items-center gap-3">
        <span className="w-5 shrink-0 font-mono text-sm text-[#8b949e]">{rank}</span>
        <HeroPortrait hero={c.hero} size={44} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-[#e6edf3]">{c.hero.name}</span>
          <span className="block text-xs text-[#8b949e]">
            {c.bestAgainst.length > 0 ? `Best vs ${c.bestAgainst.join(', ')}` : 'Mixed matchups'}
            {c.worstAgainst.length > 0 && ` · Worst vs ${c.worstAgainst[0]}`}
          </span>
        </span>
        <ScoreBadge v={c.finalScore} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[#6e7681]">
        <span className="rounded bg-[#21262d] px-2 py-0.5">Coverage {coverage}/{c.matchups.length}</span>
        <span className="rounded bg-[#21262d] px-2 py-0.5">{(c.avgGames / 1000).toFixed(1)}k matches</span>
        {c.lowData && <span className="rounded bg-[#21262d] px-2 py-0.5 text-[#d29922]">Limited data</span>}
        <button
          type="button"
          onClick={() => onViewDetails(c)}
          className="ml-auto rounded-lg border border-[#30363d] px-3 py-1 font-semibold text-[#8b949e] hover:border-[#58a6ff] hover:text-[#e6edf3]"
        >
          View details
        </button>
      </div>
      <p className="mt-2 text-xs leading-snug text-[#8b949e]">{c.explanation[0]}</p>
      <div className="mt-1 text-[10px] text-[#6e7681]">Role fit is heuristic, not measured per-position winrate.</div>
    </div>
  );
}
