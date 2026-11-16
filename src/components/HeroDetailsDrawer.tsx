import { useEffect } from 'react';
import type { CandidateScore, Hero } from '../types';
import { fmtDelta } from '../scoring/engine';
import { explainCandidate, useI18n } from '../i18n';
import { HeroPortrait } from './HeroPortrait';
import type { Lane } from '../scoring/positionsExtra';

interface Props {
  candidate: CandidateScore;
  /** Localized lane name the candidate was ranked for (explanation text). */
  laneName: string;
  enemyIds: number[];
  heroById: Map<number, Hero>;
  onClose: () => void;
}

/** Matchup breakdown drawer (§15): per-enemy stats + the numbers the score was
 *  built from. Plain statistics, no AI, no guarantees. */
export function HeroDetailsDrawer({ candidate: c, laneName, enemyIds, heroById, onClose }: Props) {
  const i18n = useI18n();
  const { t } = i18n;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const usable = c.matchups.filter((m) => m.usable);

  return (
    <div className="fade-in fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-[2px] sm:items-center" onClick={onClose} role="dialog" aria-modal="true" aria-label={t('drawer.label', { name: i18n.heroName(c.hero) })}>
      <div
        className="drawer-panel nice-scroll h-[92vh] w-full max-h-[92vh] overflow-auto p-5 sm:h-auto sm:max-h-[86vh] sm:max-w-lg sm:p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex justify-end">
          <button type="button" onClick={onClose} className="slot-x static" aria-label={t('drawer.close')}>
            ×
          </button>
        </div>

        <div className="flex flex-col items-center text-center">
          <div className="h-28 w-28 overflow-hidden rounded-2xl sm:h-32 sm:w-32">
            <HeroPortrait hero={c.hero} fill variant="large" />
          </div>
          <h2 className="mt-4 text-2xl font-extrabold uppercase tracking-wide text-ink sm:text-3xl">{i18n.heroName(c.hero)}</h2>
          {i18n.heroAltName(c.hero) && <div className="mt-0.5 text-xs font-semibold uppercase tracking-wide text-dim">{i18n.heroAltName(c.hero)}</div>}
          <div className="mt-1 text-3xl font-extrabold tabular-nums text-accent">
            {(c.teamScoreM ?? c.teamScore) > 0 ? '+' : ''}{(c.teamScoreM ?? c.teamScore).toFixed(2)}
          </div>
          <p className="mt-1 text-xs text-muted">{t('drawer.against')}</p>
        </div>

        <div className="mb-2 mt-7 flex items-center gap-3">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted">{t('drawer.matchups')}</h3>
          <span className="h-px flex-1 bg-line" />
        </div>
        <div className="mb-1.5 flex items-center gap-3 px-3.5 text-[10px] font-semibold uppercase tracking-wide text-dim">
          <span className="flex-1">{t('drawer.enemy')}</span>
          <span className="w-20 text-right" title={t('drawer.advantageTitle')}>{t('drawer.advantage')}</span>
          <span className="w-24 text-right">{t('drawer.winrate')}</span>
        </div>

        <div className="space-y-2">
          {c.matchups.map((m) => (
            <div key={m.enemyId} className="panel-2 flex items-center gap-3 px-3.5 py-3">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                {(() => { const h = heroById.get(m.enemyId); return h ? i18n.heroName(h) : `#${m.enemyId}`; })()}
              </span>
              <span className={`w-20 text-right text-sm font-bold tabular-nums ${m.delta >= 0 ? 'text-pos' : 'text-neg'}`}>
                {m.usable ? fmtDelta(m.delta) : t('drawer.na')}
              </span>
              <span className="w-24 text-right text-[11px] leading-tight text-muted">
                {t('drawer.wr', { wr: m.winrate.toFixed(1) })}
                <br />
                {i18n.number(Math.round(m.games))} {i18n.plural(Math.round(m.games), 'game')}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-5 grid grid-cols-3 gap-2 text-center">
          <div className="panel-2 px-2 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-dim">{t('drawer.teamScore')}</div>
            <div className="mt-1 text-sm font-bold tabular-nums text-ink">{(c.teamScoreM ?? c.teamScore).toFixed(2)}</div>
          </div>
          <div className="panel-2 px-2 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-dim">{t('drawer.median')}</div>
            <div className="mt-1 text-sm font-bold tabular-nums text-ink">{c.deltaStats.median.toFixed(2)}</div>
          </div>
          <div className="panel-2 px-2 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-dim">{t('drawer.coverage')}</div>
            <div className="mt-1 text-sm font-bold tabular-nums text-ink">{usable.length}/{enemyIds.length || c.matchups.length}</div>
          </div>
        </div>

        <div className="mt-5 space-y-1.5 border-t border-line pt-4 text-xs leading-relaxed text-muted">
          {explainCandidate(c, laneName, i18n, heroById).map((line) => (
            <p key={line}>• {line}</p>
          ))}
        </div>

        <p className="mt-4 text-[10px] leading-relaxed text-dim">
          {t('drawer.footnote')}
        </p>
      </div>
    </div>
  );
}

export type { Lane as DrawerLane };