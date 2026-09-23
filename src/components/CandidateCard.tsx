import type { CandidateScore, Hero } from '../types';
import { HeroPortrait } from './HeroPortrait';

export function scoreText(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}

/** ALL mode (FINAL UX PASS, P1): one compact best-pick card per role —
 *  fast overview, not 5 full ranking sections (page was ~4600px desktop). */
export function BestPickCard({ c, title, onViewDetails }: {
  c: CandidateScore;
  title: string;
  onViewDetails: (c: CandidateScore) => void;
}) {
  const coverage = c.matchups.filter((m) => m.usable).length;
  return (
    <button
      type="button"
      onClick={() => onViewDetails(c)}
      aria-label={`Best ${title} pick: ${c.hero.name}, score ${scoreText(c.finalScore)}. View analysis`}
      className="rec-best fade-up group text-left"
    >
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-accent-2">{title}</span>
        <span className="badge ml-auto">{coverage}/{c.matchups.length}</span>
      </div>
      <div className="mt-3 flex items-center gap-3.5">
        <div className="h-[76px] w-[60px] shrink-0 overflow-hidden rounded-lg">
          <HeroPortrait hero={c.hero} fill variant="large" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-extrabold uppercase leading-tight tracking-wide text-ink">{c.hero.name}</div>
          <div className="text-[22px] font-extrabold leading-tight tabular-nums text-accent">{scoreText(c.finalScore)}</div>
        </div>
      </div>
      <p className="mt-2.5 line-clamp-2 text-xs leading-snug text-muted">{c.explanation[0]}</p>
      <span className="mt-2.5 inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-accent-2 transition-all duration-150 group-hover:gap-1.5">
        View analysis <span aria-hidden="true">→</span>
      </span>
    </button>
  );
}

/** #1 recommendation — visually dominant card (§11). */
export function CandidateCard({ c, rank, heroById, onViewDetails }: {
  c: CandidateScore; rank: number; heroById: Map<number, Hero>;
  onViewDetails: (c: CandidateScore) => void;
}) {
  const coverage = c.matchups.filter((m) => m.usable).length;
  const total = c.matchups.length;
  void heroById;
  return (
    <article className="rec-top fade-up flex flex-col gap-5 p-4 sm:flex-row sm:gap-6 sm:p-6">
      <div className="relative mx-auto w-36 shrink-0 overflow-hidden rounded-xl sm:mx-0 sm:w-48 lg:w-52">
        <div className="aspect-4/5 w-full">
          <HeroPortrait hero={c.hero} fill variant="large" />
        </div>
        <span className="badge badge-accent absolute left-2 top-2">#{rank} best pick</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="badge">{coverage} / {total} coverage</span>
          <span className="badge">{Math.round(c.avgGames / 1000).toLocaleString()}k matches</span>
          {c.lowData && <span className="badge badge-warn">Limited data</span>}
        </div>
        <h4 className="mt-2.5 text-2xl font-extrabold uppercase leading-none tracking-wide text-ink sm:text-3xl">
          {c.hero.name}
        </h4>
        <div className="mt-2 text-3xl font-extrabold tabular-nums text-accent sm:text-4xl">
          {scoreText(c.finalScore)}
        </div>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">{c.explanation[0]}</p>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
          {c.bestAgainst.length > 0 && (
            <span className="text-dim">Best vs <span className="font-semibold text-pos">{c.bestAgainst.join(', ')}</span></span>
          )}
          {c.worstAgainst.length > 0 && (
            <span className="text-dim">Worst vs <span className="font-semibold text-neg">{c.worstAgainst[0]}</span></span>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => onViewDetails(c)} className="btn btn-accent">
            View analysis <span aria-hidden="true">→</span>
          </button>
        </div>
        <p className="mt-3 text-[10px] leading-relaxed text-dim">
          Role fit is heuristic, not measured per-position winrate.
        </p>
      </div>
    </article>
  );
}

/** #2–#5 — compact tile, whole tile opens the analysis drawer. */
export function MiniCard({ c, rank, onViewDetails }: {
  c: CandidateScore; rank: number;
  onViewDetails: (c: CandidateScore) => void;
}) {
  const coverage = c.matchups.filter((m) => m.usable).length;
  return (
    <button
      type="button"
      onClick={() => onViewDetails(c)}
      aria-label={`View analysis for ${c.hero.name}, rank ${rank}`}
      className="rec-mini fade-up group text-left"
    >
      <div className="relative aspect-4/5 overflow-hidden">
        <HeroPortrait hero={c.hero} fill variant="large" />
        <span className="absolute left-1.5 top-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-ink/90">#{rank}</span>
        <span className="absolute right-1.5 top-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-muted">{coverage}/{c.matchups.length}</span>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-2.5 pb-2 pt-6">
          <div className="truncate text-[13px] font-bold uppercase tracking-wide text-ink">{c.hero.name}</div>
          <div className="text-lg font-extrabold leading-tight tabular-nums text-accent">{scoreText(c.finalScore)}</div>
        </div>
      </div>
    </button>
  );
}
