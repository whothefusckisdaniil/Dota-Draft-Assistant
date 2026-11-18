import type { CandidateScore, Hero } from '../types';
import { HeroPortrait } from './HeroPortrait';
import { bestWorstAgainst, explainCandidate, useI18n } from '../i18n';

/** Signed score, always with + or − (colour is never the only cue). */
export function scoreText(v: number): string {
  const r = Math.round(v * 100) / 100;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}`;
}

export const scoreTone = (v: number) => (v > 0.005 ? 'text-pos' : v < -0.005 ? 'text-neg' : 'text-muted');

/** Match-count label: <1000 → "<1k"; then "1k" / "12.4k"; ≥1M → "1.2M". */
export function formatMatches(count: number): string {
  if (count < 1000) return '<1k';
  const k = Math.round((count / 1000) * 10) / 10;
  if (k < 1000) return `${k}k`;
  return `${Math.round((count / 1_000_000) * 10) / 10}M`;
}

/** One segment per enemy: green = favourable, red = unfavourable, grey = no data. */
export function MatchBar({ c, className = '' }: { c: CandidateScore; className?: string }) {
  const { t } = useI18n();
  if (c.matchups.length === 0) return null;
  const usable = c.matchups.filter((m) => m.usable);
  const k = usable.filter((m) => m.delta > 0).length;
  return (
    <span className={`match-bar ${className}`} role="img" aria-label={t('row.bar', { k, n: c.matchups.length })} title={t('row.bar', { k, n: c.matchups.length })}>
      {c.matchups.map((m) => (
        <i key={m.enemyId} className={!m.usable ? '' : m.delta > 0 ? 'pos' : 'neg'} />
      ))}
    </span>
  );
}

/** #1 recommendation: 96 px portrait, name, the big advantage number. */
export function BestCard({ c, lane, heroById, onViewDetails }: {
  c: CandidateScore;
  lane: string;
  heroById: Map<number, Hero>;
  onViewDetails: (c: CandidateScore) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const coverage = c.matchups.filter((m) => m.usable).length;
  const { best, worst, goodWith } = bestWorstAgainst(c, i18n, heroById);
  const name = i18n.heroName(c.hero);
  return (
    <article className="best-card fade-up p-4 sm:p-5">
      <div className="flex items-start gap-4">
        <div className="h-24 w-24 shrink-0 overflow-hidden rounded-xl">
          <HeroPortrait hero={c.hero} fill variant="large" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="label text-accent">{t('results.best')}</div>
          <h3 className="mt-1 truncate font-display text-[16px] font-bold leading-5 text-ink sm:text-[20px] sm:leading-6">{name}</h3>
          {i18n.heroAltName(c.hero) && <div className="truncate text-[11px] leading-[14px] text-muted">{i18n.heroAltName(c.hero)}</div>}
          <div className={`tnum mt-1 font-display text-[32px] font-bold leading-[38px] ${scoreTone(c.finalScore)}`}>{scoreText(c.finalScore)}</div>
        </div>
      </div>
      <MatchBar c={c} className="mt-3" />
      <div className="mt-3 flex flex-wrap gap-1.5">
        {c.matchups.length > 0 && <span className="badge">{t('card.coverage', { k: coverage, n: c.matchups.length })}</span>}
        <span className="badge">{t('card.matches', { count: formatMatches(c.avgGames) })}</span>
        {c.synergy.length > 0 && (
          <span className={`badge ${c.synergyScore >= 0 ? 'badge-pos' : 'badge-neg'}`}>{t('card.synergy', { value: scoreText(c.synergyScore) })}</span>
        )}
        {c.lowData && <span className="badge badge-warn">{t('card.limited')}</span>}
      </div>
      <p className="mt-3 text-[13px] leading-[18px] text-muted">{explainCandidate(c, lane, i18n, heroById)[0]}</p>
      {c.lane?.usable && <LaneLine c={c} heroById={heroById} />}
      {(best.length > 0 || worst.length > 0 || goodWith.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] leading-[18px]">
          {best.length > 0 && <span className="text-muted">{t('card.bestVs')} <span className="font-semibold text-ink">{best.join(', ')}</span></span>}
          {worst.length > 0 && <span className="text-muted">{t('card.worstVs')} <span className="font-semibold text-ink">{worst[0]}</span></span>}
          {goodWith.length > 0 && <span className="text-muted">{t('card.goodWith')} <span className="font-semibold text-ink">{goodWith.join(', ')}</span></span>}
        </div>
      )}
      <button type="button" onClick={() => onViewDetails(c)} className="btn btn-accent mt-4 w-full sm:w-auto">
        {t('card.view')} <span aria-hidden="true">→</span>
      </button>
    </article>
  );
}

/** A 64 px result line: portrait 48, name, number, per-enemy match bar.
 *  `tag` replaces the rank number (the role name in the per-role overview). */
export function ResultRow({ c, rank, tag, onViewDetails, style }: {
  c: CandidateScore;
  rank?: number;
  tag?: string;
  onViewDetails: (c: CandidateScore) => void;
  style?: React.CSSProperties;
}) {
  const i18n = useI18n();
  const name = i18n.heroName(c.hero);
  return (
    <button
      type="button"
      onClick={() => onViewDetails(c)}
      aria-label={i18n.t('card.viewFor', { name, rank: rank ?? 1 })}
      className="result-row"
      style={style}
    >
      <span className="h-12 w-12 shrink-0 overflow-hidden rounded-lg">
        <HeroPortrait hero={c.hero} fill variant="large" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          {tag ? (
            <span className="label shrink-0 !text-[11px] text-accent">{tag}</span>
          ) : rank !== undefined ? (
            <span aria-hidden="true" className="tnum shrink-0 text-[11px] font-semibold text-muted">#{rank}</span>
          ) : null}
        </span>
        <span className="block truncate text-[15px] font-semibold leading-5 text-ink">{name}</span>
        <MatchBar c={c} className="mt-1.5 max-w-[160px]" />
      </span>
      <span className={`tnum shrink-0 font-display text-[16px] font-bold ${scoreTone(c.finalScore)}`}>{scoreText(c.finalScore)}</span>
    </button>
  );
}

/** "Lane with Undying: won 60% of lanes, expected 58%". */
export function LaneLine({ c, heroById }: { c: CandidateScore; heroById: Map<number, Hero> }) {
  const i18n = useI18n();
  if (!c.lane) return null;
  const ally = heroById.get(c.lane.allyId);
  return (
    <p className="mt-2 flex items-center gap-2 text-[13px] leading-[18px] text-muted">
      {ally && <span className="h-6 w-6 shrink-0 overflow-hidden rounded-md"><HeroPortrait hero={ally} fill variant="large" /></span>}
      <span className="min-w-0">
        {i18n.t('laneWith.line', { name: ally ? i18n.heroName(ally) : `#${c.lane.allyId}`, share: Math.round(c.lane.share), exp: Math.round(c.lane.expected) })}
        {' '}<span className={`tnum font-semibold ${scoreTone(c.lane.delta)}`}>{scoreText(c.lane.delta)}</span>
      </span>
    </p>
  );
}
