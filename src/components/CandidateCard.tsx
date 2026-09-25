import type { CandidateScore, Hero } from '../types';
import { HeroPortrait } from './HeroPortrait';

export function scoreText(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}

/** Match-count label for the #1 card badge (Top-15 polish): the old
 *  `Math.round(avgGames / 1000) + "k"` printed "0k matches" for thin samples.
 *  <1000 → "<1k"; 1000–999999 → "1k" / "12.4k"; ≥1000000 → "1.2M". */
export function formatMatches(count: number): string {
  if (count < 1000) return '<1k';
  const k = Math.round((count / 1000) * 10) / 10;
  if (k < 1000) return `${k}k`;
  return `${Math.round((count / 1_000_000) * 10) / 10}M`;
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
    <article className="rec-top fade-up grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2.5 p-4 sm:grid-cols-[176px_minmax(0,1fr)] sm:gap-x-5 sm:p-5 lg:grid-cols-[192px_minmax(0,1fr)]">
      {/* Portrait column: 96×120 on mobile (recognizable, ~90px wide per UX
          brief), 176/192 — unchanged desktop composition. */}
      <div className="relative col-start-1 row-start-1 self-start overflow-hidden rounded-xl sm:row-span-2">
        <div className="aspect-4/5 w-full">
          <HeroPortrait hero={c.hero} fill variant="large" />
        </div>
        <span className="badge badge-accent absolute left-2 top-2 hidden sm:inline-flex">#{rank} best pick</span>
      </div>
      {/* Row 1 (mobile): key info beside the portrait instead of below it. */}
      <div className="col-start-2 row-start-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="badge badge-accent sm:hidden">#{rank} best pick</span>
          <span className="badge">{coverage} / {total} coverage</span>
          <span className="badge">{formatMatches(c.avgGames)} matches</span>
          {c.lowData && <span className="badge badge-warn">Limited data</span>}
        </div>
        <h4 className="mt-2.5 text-2xl font-extrabold uppercase leading-none tracking-wide text-ink sm:text-3xl">
          {c.hero.name}
        </h4>
        <div className="mt-2 text-3xl font-extrabold tabular-nums text-accent sm:text-4xl">
          {scoreText(c.finalScore)}
        </div>
      </div>
      {/* Row 2: full card width on mobile, right column on sm+ (grid gap keeps
          the same 10px rhythm the old mt-2.5 stack had on desktop). */}
      <div className="col-span-2 row-start-2 min-w-0 sm:col-span-1 sm:col-start-2">
        <p className="max-w-xl text-sm leading-relaxed text-muted">{c.explanation[0]}</p>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
          {c.bestAgainst.length > 0 && (
            <span className="text-dim">Best vs <span className="font-semibold text-pos">{c.bestAgainst.join(', ')}</span></span>
          )}
          {c.worstAgainst.length > 0 && (
            <span className="text-dim">Worst vs <span className="font-semibold text-neg">{c.worstAgainst[0]}</span></span>
          )}
        </div>
        <div className="mt-3.5 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => onViewDetails(c)} className="btn btn-accent">
            View analysis <span aria-hidden="true">→</span>
          </button>
        </div>
        <p className="mt-2.5 text-[10px] leading-relaxed text-dim">
          Role fit is heuristic, not measured per-position winrate.
        </p>
      </div>
    </article>
  );
}

/** #2–#15 — one line of the ranked-alternatives list (Top-15 redesign):
 *  rank · portrait · name+coverage · score; the whole row opens the drawer. */
export function RankingRow({ c, rank, onViewDetails }: {
  c: CandidateScore; rank: number;
  onViewDetails: (c: CandidateScore) => void;
}) {
  const coverage = c.matchups.filter((m) => m.usable).length;
  return (
    <button
      type="button"
      onClick={() => onViewDetails(c)}
      aria-label={`View analysis for ${c.hero.name}, rank ${rank}`}
      className="ranking-row"
    >
      <span aria-hidden="true" className="w-5 shrink-0 text-[10px] font-bold tabular-nums text-dim">#{rank}</span>
      <span className="h-8 w-10 shrink-0 overflow-hidden rounded-md sm:h-9 sm:w-11">
        <HeroPortrait hero={c.hero} fill variant="large" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-bold uppercase leading-tight text-ink">{c.hero.name}</span>
        <span className="mt-1 flex items-baseline gap-2">
          <span className="shrink-0 text-[10px] font-semibold text-muted">{coverage}/{c.matchups.length}</span>
          <span className="ml-auto shrink-0 text-[13px] font-extrabold leading-none tabular-nums text-accent">{scoreText(c.finalScore)}</span>
        </span>
      </span>
    </button>
  );
}
