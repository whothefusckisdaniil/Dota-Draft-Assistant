import { useEffect } from 'react';
import type { CandidateScore, Hero } from '../types';
import { fmtDelta, laneLabel } from '../scoring/engine';
import { HeroPortrait } from './HeroPortrait';
import type { Lane } from '../scoring/positionsExtra';

interface Props {
  candidate: CandidateScore;
  enemyIds: number[];
  heroById: Map<number, Hero>;
  onClose: () => void;
}

/** Matchup breakdown drawer (§15): per-enemy stats + the numbers the score was
 *  built from. Plain statistics, no AI, no guarantees. */
export function HeroDetailsDrawer({ candidate: c, enemyIds, heroById, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const lane = undefined; // lane label comes from the parent ranking context
  void lane;
  const usable = c.matchups.filter((m) => m.usable);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div
        className="nice-scroll max-h-[88vh] w-full max-w-lg overflow-auto rounded-t-2xl border border-[#30363d] bg-[#0d1117] p-6 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start gap-3">
          <HeroPortrait hero={c.hero} size={56} />
          <div className="flex-1">
            <h2 className="text-xl font-bold">{c.hero.name}</h2>
            <p className="text-xs text-[#8b949e]">Against your draft</p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-[#8b949e] hover:text-[#e6edf3]" aria-label="Close">×</button>
        </div>

        <div className="space-y-2">
          {c.matchups.map((m) => (
            <div key={m.enemyId} className="flex items-center gap-3 rounded-lg border border-[#21262d] bg-[#161b22] p-3">
              <span className="w-36 truncate text-sm text-[#e6edf3]">{heroById.get(m.enemyId)?.name ?? `#${m.enemyId}`}</span>
              <span className={`font-mono text-sm font-bold ${m.delta >= 0 ? 'text-[#3fb950]' : 'text-[#f85149]'}`}>
                {m.usable ? fmtDelta(m.delta) : 'n/a'}
              </span>
              <span className="ml-auto text-right text-xs text-[#8b949e]">
                {m.winrate.toFixed(1)}% WR
                <br />
                {Math.round(m.games).toLocaleString()} games
              </span>
            </div>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg border border-[#21262d] bg-[#161b22] p-3">
            <div className="text-[10px] uppercase tracking-wide text-[#6e7681]">Team score</div>
            <div className="font-mono text-sm font-bold text-[#e6edf3]">{(c.teamScoreM ?? c.teamScore).toFixed(2)}</div>
          </div>
          <div className="rounded-lg border border-[#21262d] bg-[#161b22] p-3">
            <div className="text-[10px] uppercase tracking-wide text-[#6e7681]">Median matchup</div>
            <div className="font-mono text-sm font-bold text-[#e6edf3]">{c.deltaStats.median.toFixed(2)}</div>
          </div>
          <div className="rounded-lg border border-[#21262d] bg-[#161b22] p-3">
            <div className="text-[10px] uppercase tracking-wide text-[#6e7681]">Coverage</div>
            <div className="font-mono text-sm font-bold text-[#e6edf3]">{usable.length}/{enemyIds.length || c.matchups.length}</div>
          </div>
        </div>

        <div className="mt-4 space-y-1 border-t border-[#21262d] pt-3 text-xs text-[#8b949e]">
          {c.explanation.map((line) => (
            <p key={line}>• {line}</p>
          ))}
        </div>

        <p className="mt-4 text-[10px] leading-relaxed text-[#6e7681]">
          Statistical suggestions based on aggregate OpenDota matchup data — not a guarantee of match outcomes.
        </p>
      </div>
    </div>
  );
}

export type { Lane as DrawerLane };