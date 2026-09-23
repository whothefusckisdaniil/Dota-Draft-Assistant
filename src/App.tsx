import { useEffect, useMemo, useState } from 'react';
import { useDraftData } from './data/useDraftData';
import { freshnessLabel } from './data/dataset';
import { APP_CONFIG, POSITIONS } from './config';
import type { CandidateScore } from './types';
import { HeroSearch } from './components/HeroSearch';
import { EnemySlots, PositionTabs } from './components/Selectors';
import { ResultsGrid } from './components/ResultsGrid';
import { HeroDetailsDrawer } from './components/HeroDetailsDrawer';
import { ScoringPlayground } from './components/ScoringPlayground';
import { DraftValidation } from './components/DraftValidation';

const SHOW_PLAYGROUND = import.meta.env.DEV;

type Page = 'main' | 'about' | 'privacy';

const TRY_EXAMPLES = ['Puck', 'Tidehunter', 'Juggernaut'];

export default function App() {
  const d = useDraftData();
  const [view, setView] = useState<'draft' | 'lab' | 'validate'>('draft');
  const [page, setPage] = useState<Page>('main');
  const [details, setDetails] = useState<CandidateScore | null>(null);

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
            <p className="mt-0.5 text-xs text-muted">Find the best picks against the enemy draft.</p>
          </button>
          <nav className="flex flex-wrap items-center gap-2" aria-label="Site">
            {SHOW_PLAYGROUND && (
              <span className="flex overflow-hidden rounded-lg border border-line-2">
                <button type="button" onClick={() => { setPage('main'); setView('draft'); }} className={`px-3 py-1.5 text-xs ${view === 'draft' && page === 'main' ? 'bg-accent text-bg' : 'bg-surface text-muted'}`}>Draft</button>
                <button type="button" onClick={() => { setPage('main'); setView('validate'); }} className={`px-3 py-1.5 text-xs ${view === 'validate' && page === 'main' ? 'bg-accent text-bg' : 'bg-surface text-muted'}`}>Draft validation</button>
                <button type="button" onClick={() => { setPage('main'); setView('lab'); }} className={`px-3 py-1.5 text-xs ${view === 'lab' && page === 'main' ? 'bg-accent text-bg' : 'bg-surface text-muted'}`}>Scoring lab</button>
              </span>
            )}
            <button type="button" onClick={() => go('about')} className={`btn btn-ghost btn-sm ${page === 'about' ? 'text-accent' : ''}`}>About</button>
            <button type="button" onClick={() => go('privacy')} className={`btn btn-ghost btn-sm ${page === 'privacy' ? 'text-accent' : ''}`}>Privacy</button>
          </nav>
        </header>
        {/* CONTENT_SLOT */}
        {page === 'about' && (
          <section className="panel p-6 text-sm leading-relaxed text-muted sm:p-8">
            <h2 className="mb-3 text-lg font-bold text-ink">About Dota Draft Assistant</h2>
            <p>Dota Draft Assistant analyzes statistical hero matchups to help you evaluate picks against the enemy draft.</p>
            <p className="mt-2">Statistics are based on OpenDota data.</p>
            <p className="mt-2 text-dim">Recommendations are statistical suggestions, not guarantees of match outcomes.</p>
          </section>
        )}
        {page === 'privacy' && (
          <section className="panel p-6 text-sm leading-relaxed text-muted sm:p-8">
            <h2 className="mb-3 text-lg font-bold text-ink">Privacy</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>No account required.</li>
              <li>No personal data stored.</li>
              <li>No Steam login required.</li>
            </ul>
            <p className="mt-3 text-dim">The app does not collect Steam IDs and stores nothing beyond your browser session.</p>
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
                {d.loadState.message}
              </div>
            )}
            {d.loadState.kind === 'error' && (
              <div className="rounded-2xl border border-[#E06060]/40 bg-[#E06060]/10 px-5 py-5 text-sm">
                <div className="font-semibold text-[#F0918A]">We&apos;re having trouble loading Dota data.</div>
                <div className="mt-1 text-muted">Please try again later.</div>
              </div>
            )}
            {/* DRAFTSLOT */}
            {d.loadState.kind === 'ready' && (
              <section className="panel p-4 sm:p-6">
                <div className="grid gap-5">
                  <EnemySlots enemies={d.enemies} heroById={d.heroById} onRemove={d.removeEnemy} onClear={d.clearEnemies} />
                  <div className="min-w-0">
                    <HeroSearch heroes={d.heroes} excluded={excluded} onPick={(h) => d.addEnemy(h.id)} />
                    <p className="mt-2 text-xs text-dim">Pick 1–{APP_CONFIG.ui.maxEnemies} enemies — recommendations update automatically.</p>
                  </div>
                  <PositionTabs value={d.position} onChange={d.setPosition} />
                </div>
              </section>
            )}
            {d.loadState.kind === 'ready' && d.enemies.length > 0 && d.missingTables.length > 0 && (
              <div className="panel mt-6 border-accent/40 px-4 py-3.5 text-sm text-accent-2">
                Not enough matchup data for {d.missingTables.map((id) => d.heroById.get(id)?.name ?? `#${id}`).join(', ')} — recommendations need coverage vs the full draft.
              </div>
            )}
            {/* RESULTSLOT */}
            {d.loadState.kind === 'ready' && d.results && (
              <div className="mt-8">
                <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[3px] bg-accent" />
                    <h2 className="text-[13px] font-extrabold uppercase tracking-[0.2em] text-ink">Recommendations</h2>
                    <span className="text-xs text-muted">
                      · {d.position === 'all' ? 'Best pick per role' : (POSITIONS.find((p) => p.id === d.position)?.label ?? 'All')}
                    </span>
                  </div>
                  <span className="text-[11px] text-dim">
                    {d.position === 'all'
                      ? 'Top pick per role — pick a role for the full top 5. Only heroes with usable data vs every enemy are shown.'
                      : 'Only heroes with usable data vs every selected enemy are shown.'}
                  </span>
                </div>
                <ResultsGrid results={d.results} heroById={d.heroById} onViewDetails={(c) => setDetails(c)} summary={d.position === 'all'} />
                <p className="mt-7 max-w-3xl text-[11px] leading-relaxed text-dim">
                  Statistically favorable matchup — not a guaranteed win. Scores use the median matchup across the enemy draft,
                  sample-size confidence and role fit (role tags + curated lane nudges, not per-position winrates).
                  Matchup data provided by OpenDota (aggregate data, not patch-filtered matches).
                </p>
              </div>
            )}
            {d.loadState.kind === 'ready' && d.enemies.length === 0 && (
              <div className="panel mx-auto mt-10 max-w-xl px-6 py-10 text-center">
                <p className="text-lg font-bold text-ink">Build your enemy draft</p>
                <p className="mt-1.5 text-sm text-muted">Select 1–{APP_CONFIG.ui.maxEnemies} enemy heroes to see counter recommendations.</p>
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-xs">
                  <span className="text-dim">Try:</span>
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
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
          )
        )}
        <footer className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-[11px] leading-relaxed text-dim">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold text-muted">Dota Draft Assistant</span>
            <a className="underline-offset-2 hover:text-ink hover:underline" href="https://docs.opendota.com/" target="_blank" rel="noreferrer">Data provided by OpenDota</a>
            {d.loadState.kind === 'ready' && d.meta && (
              <>
                <span aria-hidden="true">·</span>
                <span>{freshnessLabel(d.meta)}</span>
                <span aria-hidden="true">·</span>
                <span>Latest patch {d.meta.latestPatch || 'unknown'}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => go('about')} className="hover:text-ink">About</button>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={() => go('privacy')} className="hover:text-ink">Privacy</button>
          </div>
        </footer>
      </div>
      {details && <HeroDetailsDrawer candidate={details} enemyIds={d.enemies} heroById={d.heroById} onClose={() => setDetails(null)} />}
    </div>
  );
}