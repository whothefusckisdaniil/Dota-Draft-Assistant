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
    <div className="fade-in fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-[2px] sm:items-center" onClick={onClose} role="dialog" aria-modal="true" aria-label={`${c.hero.name} analysis`}>
      <div
        className="drawer-panel nice-scroll h-[92vh] w-full max-h-[92vh] overflow-auto p-5 sm:h-auto sm:max-h-[86vh] sm:max-w-lg sm:p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex justify-end">
          <button type="button" onClick={onClose} className="slot-x static" aria-label="Close">
            ×
          </button>
        </div>

        <div className="flex flex-col items-center text-center">
          <div className="h-28 w-28 overflow-hidden rounded-2xl sm:h-32 sm:w-32">
            <HeroPortrait hero={c.hero} fill variant="large" />
          </div>
          <h2 className="mt-4 text-2xl font-extrabold uppercase tracking-wide text-ink sm:text-3xl">{c.hero.name}</h2>
          <div className="mt-1 text-3xl font-extrabold tabular-nums text-accent">
            {(c.teamScoreM ?? c.teamScore) > 0 ? '+' : ''}{(c.teamScoreM ?? c.teamScore).toFixed(2)}
          </div>
          <p className="mt-1 text-xs text-muted">Against your draft</p>
        </div>

        <div className="mb-2 mt-7 flex items-center gap-3">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted">Matchups</h3>
          <span className="h-px flex-1 bg-line" />
        </div>

        <div className="space-y-2">
          {c.matchups.map((m) => (
            <div key={m.enemyId} className="panel-2 flex items-center gap-3 px-3.5 py-3">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                {heroById.get(m.enemyId)?.name ?? `#${m.enemyId}`}
              </span>
              <span className={`w-14 text-right text-sm font-bold tabular-nums ${m.delta >= 0 ? 'text-pos' : 'text-neg'}`}>
                {m.usable ? fmtDelta(m.delta) : 'n/a'}
              </span>
              <span className="w-24 text-right text-[11px] leading-tight text-muted">
                {m.winrate.toFixed(1)}% WR
                <br />
                {Math.round(m.games).toLocaleString()} games
              </span>
            </div>
          ))}
        </div>

        <div className="mt-5 grid grid-cols-3 gap-2 text-center">
          <div className="panel-2 px-2 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-dim">Team score</div>
            <div className="mt-1 text-sm font-bold tabular-nums text-ink">{(c.teamScoreM ?? c.teamScore).toFixed(2)}</div>
          </div>
          <div className="panel-2 px-2 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-dim">Median matchup</div>
            <div className="mt-1 text-sm font-bold tabular-nums text-ink">{c.deltaStats.median.toFixed(2)}</div>
          </div>
          <div className="panel-2 px-2 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-dim">Coverage</div>
            <div className="mt-1 text-sm font-bold tabular-nums text-ink">{usable.length}/{enemyIds.length || c.matchups.length}</div>
          </div>
        </div>

        <div className="mt-5 space-y-1.5 border-t border-line pt-4 text-xs leading-relaxed text-muted">
          {c.explanation.map((line) => (
            <p key={line}>• {line}</p>
          ))}
        </div>

        <p className="mt-4 text-[10px] leading-relaxed text-dim">
          Statistical suggestions based on aggregate OpenDota matchup data — not a guarantee of match outcomes.
        </p>
      </div>
    </div>
  );
}

export type { Lane as DrawerLane };