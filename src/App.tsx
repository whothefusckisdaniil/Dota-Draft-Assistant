import { useEffect, useMemo, useState } from 'react';
import { useDraftData } from './data/useDraftData';
import { freshness } from './data/dataset';
import { freshnessText, useI18n } from './i18n';
import type { StringKey } from './i18n/strings';
import { APP_CONFIG, type PositionFilter } from './config';
import type { CandidateScore } from './types';
import { HeroSearch } from './components/HeroSearch';
import { EnemySlots, LanguageSwitch, PositionTabs, RankTabs } from './components/Selectors';
import { ResultsGrid } from './components/ResultsGrid';
import { HeroDetailsDrawer } from './components/HeroDetailsDrawer';
import { ScoringPlayground } from './components/ScoringPlayground';
import { DraftValidation } from './components/DraftValidation';

const SHOW_PLAYGROUND = import.meta.env.DEV;

type Page = 'main' | 'about' | 'privacy';

const TRY_EXAMPLES = ['Puck', 'Tidehunter', 'Juggernaut'];

export default function App() {
  const d = useDraftData();
  const i18n = useI18n();
  const { t } = i18n;
  const [view, setView] = useState<'draft' | 'lab' | 'validate'>('draft');
  const [page, setPage] = useState<Page>('main');
  const [details, setDetails] = useState<{ c: CandidateScore; lane: Exclude<PositionFilter, 'all'> } | null>(null);

  // Close the details drawer whenever the draft changes or the user navigates —
  // otherwise it keeps showing a stale CandidateScore for the previous lineup.
  useEffect(() => {
    setDetails(null);
  }, [d.enemies]);
  useEffect(() => {
    setDetails(null);
  }, [page]);

  const excluded = useMemo(() => new Set(d.enemies), [d.enemies]);

  const heroByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of d.heroes) m.set(h.name.toLowerCase(), h.id);
    return m;
  }, [d.heroes]);

  function go(next: Page) {
    setPage(next);
    window.scrollTo({ top: 0 });
  }

  return (
    <div className="min-h-screen bg-bg text-ink">
      <div className="mx-auto w-full max-w-[1200px] px-4 pb-16 pt-5 sm:px-6 sm:pt-7">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
          <button type="button" onClick={() => go('main')} className="text-left">
            <h1 className="text-xl font-extrabold uppercase tracking-tight sm:text-2xl">DOTA DRAFT ASSISTANT</h1>
            <p className="mt-0.5 text-xs text-muted">{t('app.tagline')}</p>
          </button>
          <nav className="flex flex-wrap items-center gap-2" aria-label="Site">
            {SHOW_PLAYGROUND && (
              <span className="flex overflow-hidden rounded-lg border border-line-2">
                <button type="button" onClick={() => { setPage('main'); setView('draft'); }} className={`px-3 py-1.5 text-xs ${view === 'draft' && page === 'main' ? 'bg-accent text-bg' : 'bg-surface text-muted'}`}>Draft</button>
                <button type="button" onClick={() => { setPage('main'); setView('validate'); }} className={`px-3 py-1.5 text-xs ${view === 'validate' && page === 'main' ? 'bg-accent text-bg' : 'bg-surface text-muted'}`}>Draft validation</button>
                <button type="button" onClick={() => { setPage('main'); setView('lab'); }} className={`px-3 py-1.5 text-xs ${view === 'lab' && page === 'main' ? 'bg-accent text-bg' : 'bg-surface text-muted'}`}>Scoring lab</button>
              </span>
            )}
            <button type="button" onClick={() => go('about')} className={`btn btn-ghost btn-sm ${page === 'about' ? 'text-accent' : ''}`}>{t('nav.about')}</button>
            <button type="button" onClick={() => go('privacy')} className={`btn btn-ghost btn-sm ${page === 'privacy' ? 'text-accent' : ''}`}>{t('nav.privacy')}</button>
            <LanguageSwitch />
          </nav>
        </header>
        {/* CONTENT_SLOT */}
        {page === 'about' && (
          <section className="panel p-6 text-sm leading-relaxed text-muted sm:p-8">
            <h2 className="mb-3 text-lg font-bold text-ink">{t('about.title')}</h2>
            <p>{t('about.p1')}</p>
            <p className="mt-2">{t('about.p2')}</p>
            <p className="mt-2">{t('about.p3')}</p>
            <p className="mt-2">{t('about.p4')}</p>
            <p className="mt-2 text-dim">{t('about.disclaimer')}</p>
            <p className="mt-2 text-dim">
              {t('about.data')} <a href="https://stratz.com" target="_blank" rel="noopener" className="underline hover:text-ink">Powered by STRATZ</a>{' '}
              {t('about.dataStratz')} <a href="https://www.opendota.com" target="_blank" rel="noopener" className="underline hover:text-ink">OpenDota</a>{' '}
              {t('about.dataOpenDota')} {t('about.trademark')}
            </p>
          </section>
        )}
        {page === 'privacy' && (
          <section className="panel p-6 text-sm leading-relaxed text-muted sm:p-8">
            <h2 className="mb-3 text-lg font-bold text-ink">{t('privacy.title')}</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>{t('privacy.noAccount')}</li>
              <li>{t('privacy.noData')}</li>
              <li>{t('privacy.noSteam')}</li>
            </ul>
            <p className="mt-3 text-dim">{t('privacy.note')}</p>
          </section>
        )}
        {/* PAGESLOT */}
        {page === 'main' && (
          SHOW_PLAYGROUND && view === 'lab' ? <ScoringPlayground /> :
          SHOW_PLAYGROUND && view === 'validate' ? <DraftValidation /> : (
          <>
            {d.loadState.kind === 'loading' && (
              <div className="panel flex items-center gap-3 px-5 py-5 text-sm text-muted">
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-line-2 border-t-accent" aria-hidden="true" />
                {t('load.loading')}
              </div>
            )}
            {d.loadState.kind === 'error' && (
              <div className="rounded-2xl border border-[#E06060]/40 bg-[#E06060]/10 px-5 py-5 text-sm">
                <div className="font-semibold text-[#F0918A]">{t('load.errorTitle')}</div>
                <div className="mt-1 text-muted">{t('load.errorRetry')}</div>
              </div>
            )}
            {/* DRAFTSLOT */}
            {d.loadState.kind === 'ready' && (
              <section className="panel p-4 sm:p-6">
                <div className="grid gap-5">
                  <EnemySlots enemies={d.enemies} heroById={d.heroById} onRemove={d.removeEnemy} onClear={d.clearEnemies} />
                  <div className="min-w-0">
                    <HeroSearch heroes={d.heroes} excluded={excluded} onPick={(h) => d.addEnemy(h.id)} />
                    <p className="mt-2 text-xs text-dim">{t('draft.hint', { max: APP_CONFIG.ui.maxEnemies })}</p>
                  </div>
                  <PositionTabs value={d.position} onChange={d.setPosition} />
                  {d.rankOptions.length > 0 && (
                    <RankTabs value={d.rank} options={d.rankOptions} onChange={d.setRank} />
                  )}
                </div>
              </section>
            )}
            {d.loadState.kind === 'ready' && d.enemies.length > 0 && d.missingTables.length > 0 && (
              <div className="panel mt-6 border-accent/40 px-4 py-3.5 text-sm text-accent-2">
                {t('missing.data', { names: d.missingTables.map((id) => { const h = d.heroById.get(id); return h ? i18n.heroName(h) : `#${id}`; }).join(', ') })}
              </div>
            )}
            {d.loadState.kind === 'ready' && d.enemies.length > 0 && d.rankLoading && (
              <div className="panel mt-6 flex items-center gap-3 px-5 py-4 text-sm text-muted">
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-line-2 border-t-accent" aria-hidden="true" />
                {t('rank.loading', { rank: t(`rank.${d.rank}` as StringKey) })}
              </div>
            )}
            {d.loadState.kind === 'ready' && d.rankError && d.rank !== 'ALL' && (
              <div className="panel mt-6 border-accent/40 px-4 py-3.5 text-sm text-accent-2">{t(`rank.${d.rankError}` as StringKey)}</div>
            )}
            {/* RESULTSLOT */}
            {d.loadState.kind === 'ready' && d.results && (
              <div className="mt-8">
                <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[3px] bg-accent" />
                    <h2 className="text-[13px] font-extrabold uppercase tracking-[0.2em] text-ink">{t('results.title')}</h2>
                    <span className="text-xs text-muted">
                      · {d.position === 'all' ? t('results.perRole') : t(`pos.${d.position}.long` as StringKey)}
                      {' · '}{d.rank === 'ALL' || d.rankError ? t('rank.all') : t(`rank.${d.rank}` as StringKey)}
                    </span>
                  </div>
                  <span className="text-[11px] text-dim">
                    {d.position === 'all' ? t('results.hintAll') : t('results.hint')}
                  </span>
                </div>
                <ResultsGrid
                  results={d.results}
                  heroById={d.heroById}
                  onViewDetails={(candidate, lane) => setDetails({ c: candidate, lane })}
                  summary={d.position === 'all'}
                />
                <p className="mt-7 max-w-3xl text-[11px] leading-relaxed text-dim">{t('results.footnote')}</p>
              </div>
            )}
            {d.loadState.kind === 'ready' && d.enemies.length === 0 && (
              <div className="panel mx-auto mt-10 max-w-xl px-6 py-10 text-center">
                <p className="text-lg font-bold text-ink">{t('empty.title')}</p>
                <p className="mt-1.5 text-sm text-muted">{t('empty.text', { max: APP_CONFIG.ui.maxEnemies })}</p>
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-xs">
                  <span className="text-dim">{t('empty.try')}</span>
                  {TRY_EXAMPLES.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => {
                        const id = heroByName.get(n.toLowerCase());
                        if (id !== undefined) d.addEnemy(id);
                      }}
                      className="btn btn-ghost btn-sm"
                    >
                      {(() => { const id = heroByName.get(n.toLowerCase()); const h = id !== undefined ? d.heroById.get(id) : undefined; return h ? i18n.heroName(h) : n; })()}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
          )
        )}
        <footer className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-[11px] leading-relaxed text-dim">
          <p className="order-last w-full text-[10px] text-dim/80">
            {t('footer.trademark')}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold text-muted">Dota Draft Assistant</span>
            {/* Attribution: STRATZ asks API users to link back; OpenDota is credited too. */}
            <span>
              {t('footer.matchups')}{' '}
              <a href="https://stratz.com" target="_blank" rel="noopener" className="underline decoration-line-2 underline-offset-2 hover:text-ink">Powered by STRATZ</a>
              {t('footer.window')}{' '}
              <a href="https://www.opendota.com" target="_blank" rel="noopener" className="underline decoration-line-2 underline-offset-2 hover:text-ink">OpenDota</a>
            </span>
            {d.loadState.kind === 'ready' && d.meta && (
              <>
                <span aria-hidden="true">·</span>
                <span>{freshnessText(freshness(d.meta), i18n)}</span>
                <span aria-hidden="true">·</span>
                <span>{t('footer.patch', { patch: d.meta.latestPatch || t('footer.unknown') })}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => go('about')} className="hover:text-ink">{t('nav.about')}</button>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={() => go('privacy')} className="hover:text-ink">{t('nav.privacy')}</button>
          </div>
        </footer>
      </div>
      {details && (
        <HeroDetailsDrawer
          candidate={details.c}
          laneName={t(`lane.${details.lane}` as StringKey)}
          enemyIds={d.enemies}
          heroById={d.heroById}
          onClose={() => setDetails(null)}
        />
      )}
    </div>
  );
}