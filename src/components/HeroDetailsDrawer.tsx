import { useEffect, useRef } from 'react';
import type { CandidateScore, Hero } from '../types';
import { explainCandidate, useI18n } from '../i18n';
import { HeroPortrait } from './HeroPortrait';
import { scoreText, scoreTone } from './CandidateCard';
import type { StringKey } from '../i18n/strings';
import type { Lane } from '../scoring/positionsExtra';

interface Props {
  candidate: CandidateScore;
  /** Localized lane name the candidate was ranked for (explanation text). */
  laneName: string;
  enemyIds: number[];
  heroById: Map<number, Hero>;
  onClose: () => void;
}

/** Reliability: 3 dots by sample size (same thresholds as the explanation). */
function reliability(avgGames: number): 1 | 2 | 3 {
  return avgGames >= 800 ? 3 : avgGames >= 200 ? 2 : 1;
}

/** A per-hero line: mini portrait, name, win rate + games, a centred ±bar. */
function PairRow({ hero, name, delta, usable, winrate, games, wrKey }: {
  hero?: Hero; name: string; delta: number; usable: boolean; winrate: number; games: number; wrKey: StringKey;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  // ±6 pp fills half the bar
  const w = Math.min(50, (Math.abs(delta) / 6) * 50);
  return (
    <div className="flex items-center gap-3 py-2.5">
      <span className="h-10 w-10 shrink-0 overflow-hidden rounded-lg">{hero && <HeroPortrait hero={hero} fill variant="large" />}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-5 text-ink">{name}</span>
          <span className={`tnum shrink-0 text-[15px] font-semibold ${usable ? scoreTone(delta) : 'text-muted'}`}>
            {usable ? scoreText(delta) : t('drawer.na')}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-3">
          <span className="tnum min-w-0 flex-1 truncate text-[11px] leading-[14px] text-muted">
            {t(wrKey, { wr: winrate.toFixed(1) })} · {i18n.number(Math.round(games))} {i18n.plural(Math.round(games), 'game')}
          </span>
          <span className="delta-bar w-20 shrink-0" aria-hidden="true">
            {usable && <i className={delta >= 0 ? 'bg-pos' : 'bg-neg'} style={delta >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} />}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Hero analysis: full-screen sheet on phones, 420 px side panel from 768 px. */
export function HeroDetailsDrawer({ candidate: c, laneName, enemyIds, heroById, onClose }: Props) {
  const i18n = useI18n();
  const { t } = i18n;
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const usable = c.matchups.filter((m) => m.usable);
  const level = reliability(c.avgGames);
  const name = (id: number) => { const h = heroById.get(id); return h ? i18n.heroName(h) : `#${id}`; };
  const stat = (label: string, value: string, tone = 'text-ink') => (
    <div className="panel-2 px-2 py-2.5 text-center">
      <div className="text-[11px] leading-[14px] text-muted">{label}</div>
      <div className={`tnum mt-1 text-[15px] font-semibold ${tone}`}>{value}</div>
    </div>
  );

  return (
    <>
      <div className="scrim hidden md:block" onClick={onClose} aria-hidden="true" />
      <div className="side-panel" role="dialog" aria-modal="true" aria-label={t('drawer.label', { name: i18n.heroName(c.hero) })}>
        <div className="flex flex-none items-center justify-between border-b border-line px-4 py-2" style={{ paddingTop: 'max(8px, env(safe-area-inset-top))' }}>
          <span className="label">{laneName}</span>
          <button ref={closeRef} type="button" onClick={onClose} className="icon-btn" aria-label={t('drawer.close')}>
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M4 4l10 10M14 4 4 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="nice-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-8" style={{ paddingBottom: 'calc(32px + var(--safe-bottom))' }}>
          <div className="flex items-center gap-4 pt-5">
            <div className="h-24 w-24 shrink-0 overflow-hidden rounded-xl">
              <HeroPortrait hero={c.hero} fill variant="large" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate font-display text-[20px] font-bold leading-6 text-ink">{i18n.heroName(c.hero)}</h2>
              {i18n.heroAltName(c.hero) && <div className="truncate text-[11px] leading-[14px] text-muted">{i18n.heroAltName(c.hero)}</div>}
              <div className={`tnum mt-1 font-display text-[32px] font-bold leading-[38px] ${scoreTone(c.draftScore)}`}>{scoreText(c.draftScore)}</div>
              <div className="mt-1 flex items-center gap-2 text-[11px] leading-[14px] text-muted" title={`${Math.round(c.avgGames)}`}>
                <span className="reliability" aria-hidden="true">
                  {[1, 2, 3].map((n) => <i key={n} className={n <= level ? 'on' : ''} />)}
                </span>
                {t(`drawer.reliability.${level}` as StringKey)}
              </div>
            </div>
          </div>

          {c.matchups.length > 0 && (
            <section className="mt-6">
              <h3 className="label">{t('drawer.vsEach')}</h3>
              <div className="mt-1 divide-y divide-line">
                {c.matchups.map((m) => (
                  <PairRow key={m.enemyId} hero={heroById.get(m.enemyId)} name={name(m.enemyId)} delta={m.delta} usable={m.usable} winrate={m.winrate} games={m.games} wrKey="drawer.wr" />
                ))}
              </div>
            </section>
          )}

          {c.synergy.length > 0 && (
            <section className="mt-5">
              <h3 className="label">{t('drawer.withEach')}</h3>
              <div className="mt-1 divide-y divide-line">
                {c.synergy.map((sy) => (
                  <PairRow key={sy.allyId} hero={heroById.get(sy.allyId)} name={name(sy.allyId)} delta={sy.delta} usable={sy.usable} winrate={sy.winrate} games={sy.games} wrKey="drawer.together" />
                ))}
              </div>
            </section>
          )}

          <div className="mt-5 grid grid-cols-3 gap-2">
            {stat(t('drawer.teamScore'), scoreText(c.teamScoreM ?? c.teamScore))}
            {stat(t('drawer.median'), scoreText(c.deltaStats.median))}
            {stat(t('drawer.coverage'), `${usable.length}/${enemyIds.length || c.matchups.length}`)}
          </div>
          {c.synergy.length > 0 && (
            <div className="mt-2 grid grid-cols-3 gap-2">
              {stat(t('drawer.counterScore'), scoreText(c.teamScoreM ?? c.teamScore))}
              {stat(t('drawer.synergyScore'), scoreText(c.synergyScore))}
              {stat(t('drawer.draftScore'), scoreText(c.draftScore), scoreTone(c.draftScore))}
            </div>
          )}

          <div className="mt-5 space-y-1.5 border-t border-line pt-4 text-[13px] leading-[18px] text-muted">
            {explainCandidate(c, laneName, i18n, heroById).map((line) => <p key={line}>{line}</p>)}
          </div>
          <p className="mt-4 text-[11px] leading-[14px] text-muted">
            {t('drawer.footnote')}
            {c.synergy.length > 0 && <> {t('drawer.synergyNote')}</>}
          </p>
        </div>
      </div>
    </>
  );
}

export type { Lane as DrawerLane };
