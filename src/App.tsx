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
    <div className="min-h-screen bg-[#0a0e14] text-[#e6edf3]">
      <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6">
        <header className="mb-6">
          <button type="button" onClick={() => go('main')} className="block text-left">
            <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">DOTA DRAFT ASSISTANT</h1>
            <p className="mt-1 text-sm text-[#8b949e]">Counter picks for your enemy draft.</p>
          </button>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            {SHOW_PLAYGROUND && (
              <span className="flex overflow-hidden rounded-full border border-[#30363d]">
                <button type="button" onClick={() => { setPage('main'); setView('draft'); }} className={`px-3 py-1 ${view === 'draft' && page === 'main' ? 'bg-[#1f6feb]/30 text-[#e6edf3]' : 'bg-[#161b22] text-[#8b949e]'}`}>Draft</button>
                <button type="button" onClick={() => { setPage('main'); setView('validate'); }} className={`px-3 py-1 ${view === 'validate' && page === 'main' ? 'bg-[#1f6feb]/30 text-[#e6edf3]' : 'bg-[#161b22] text-[#8b949e]'}`}>Draft validation</button>
                <button type="button" onClick={() => { setPage('main'); setView('lab'); }} className={`px-3 py-1 ${view === 'lab' && page === 'main' ? 'bg-[#1f6feb]/30 text-[#e6edf3]' : 'bg-[#161b22] text-[#8b949e]'}`}>Scoring lab</button>
              </span>
            )}
            {d.loadState.kind === 'ready' && d.meta && (
              <>
                <span className="rounded-full border border-[#30363d] bg-[#161b22] px-3 py-1 text-[#8b949e]">
                  Data source: <span className="text-[#e6edf3]">OpenDota</span> · {freshnessLabel(d.meta)}
                </span>
                <span className="rounded-full border border-[#30363d] bg-[#161b22] px-3 py-1 text-[#8b949e]">
                  Latest Dota patch: <span className="text-[#e6edf3]">{d.meta.latestPatch || 'unknown'}</span>
                </span>
              </>
            )}
            <span className="ml-auto flex gap-2">
              <button type="button" onClick={() => go('about')} className={`rounded-full border border-[#30363d] px-3 py-1 ${page === 'about' ? 'bg-[#1f6feb]/30 text-[#e6edf3]' : 'bg-[#161b22] text-[#8b949e] hover:text-[#e6edf3]'}`}>About</button>
              <button type="button" onClick={() => go('privacy')} className={`rounded-full border border-[#30363d] px-3 py-1 ${page === 'privacy' ? 'bg-[#1f6feb]/30 text-[#e6edf3]' : 'bg-[#161b22] text-[#8b949e] hover:text-[#e6edf3]'}`}>Privacy</button>
            </span>
          </div>
        </header>
        {/* CONTENT_SLOT */}
        {page === 'about' && (
          <section className="rounded-2xl border border-[#30363d] bg-[#0d1117] p-6 text-sm leading-relaxed text-[#c9d1d9]">
            <h2 className="mb-3 text-lg font-bold">About Dota Draft Assistant</h2>
            <p>Dota Draft Assistant analyzes statistical hero matchups to help you evaluate picks against the enemy draft.</p>
            <p className="mt-2">Statistics are based on OpenDota data.</p>
            <p className="mt-2 text-[#8b949e]">Recommendations are statistical suggestions, not guarantees of match outcomes.</p>
          </section>
        )}
        {page === 'privacy' && (
          <section className="rounded-2xl border border-[#30363d] bg-[#0d1117] p-6 text-sm leading-relaxed text-[#c9d1d9]">
            <h2 className="mb-3 text-lg font-bold">Privacy</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>No account required.</li>
              <li>No personal data stored.</li>
              <li>No Steam login required.</li>
            </ul>
            <p className="mt-3 text-[#8b949e]">The app does not collect Steam IDs and stores nothing beyond your browser session.</p>
          </section>
        )}
        {/* PAGESLOT */}
        {page === 'main' && (
          SHOW_PLAYGROUND && view === 'lab' ? <ScoringPlayground /> :
          SHOW_PLAYGROUND && view === 'validate' ? <DraftValidation /> : (
          <>
            {d.loadState.kind === 'loading' && (
              <div className="rounded-xl border border-[#30363d] bg-[#161b22] p-6 text-sm text-[#8b949e]">
                <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-[#30363d] border-t-[#58a6ff] align-[-2px]" />
                {d.loadState.message}
              </div>
            )}
            {d.loadState.kind === 'error' && (
              <div className="rounded-xl border border-[#f85149]/40 bg-[#f85149]/10 p-6 text-sm">
                <div className="font-semibold text-[#ffa198]">We&apos;re having trouble loading Dota data.</div>
                <div className="mt-1 text-[#8b949e]">Please try again later.</div>
              </div>
            )}
            {/* DRAFTSLOT */}
            {d.loadState.kind === 'ready' && (
              <section className="rounded-2xl border border-[#30363d] bg-[#0d1117] p-4 sm:p-6">
                <div className="grid gap-5">
                  <div>
                    <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-[#8b949e]">Enemy team</h2>
                    <HeroSearch heroes={d.heroes} excluded={excluded} onPick={(h) => d.addEnemy(h.id)} />
                    <p className="mt-1.5 text-xs text-[#6e7681]">Pick 1–{APP_CONFIG.ui.maxEnemies} enemies. Recommendations update automatically.</p>
                  </div>
                  <EnemySlots enemies={d.enemies} heroById={d.heroById} onRemove={d.removeEnemy} onClear={d.clearEnemies} />
                  <PositionTabs value={d.position} onChange={d.setPosition} />
                </div>
              </section>
            )}
            {d.loadState.kind === 'ready' && d.enemies.length > 0 && d.missingTables.length > 0 && (
              <div className="mt-6 rounded-xl border border-[#d29922]/40 bg-[#d29922]/10 p-4 text-sm text-[#e3b341]">
                Not enough matchup data for {d.missingTables.map((id) => d.heroById.get(id)?.name ?? `#${id}`).join(', ')} — recommendations need coverage vs the full draft.
              </div>
            )}
            {/* RESULTSLOT */}
            {d.loadState.kind === 'ready' && d.results && (
              <div className="mt-8">
                <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-lg font-bold">RECOMMENDED PICKS <span className="text-sm font-normal text-[#8b949e]">· {POSITIONS.find((p) => p.id === d.position)?.label ?? 'All'}</span></h2>
                  <span className="text-xs text-[#6e7681]">Only heroes with usable data vs every selected enemy are shown.</span>
                </div>
                <ResultsGrid results={d.results} heroById={d.heroById} onViewDetails={(c) => setDetails(c)} />
                <p className="mt-6 text-xs leading-relaxed text-[#6e7681]">
                  Statistically favorable matchup — not a guaranteed win. Scores use the median matchup across the enemy draft,
                  sample-size confidence and role fit (role tags + curated lane nudges, not per-position winrates).
                  Matchup data provided by OpenDota (aggregate data, not patch-filtered matches).
                </p>
              </div>
            )}
            {d.loadState.kind === 'ready' && d.enemies.length === 0 && (
              <div className="mt-8 rounded-xl border border-dashed border-[#30363d] p-8 text-center">
                <p className="text-sm font-semibold text-[#8b949e]">Build the enemy draft</p>
                <p className="mt-1 text-sm text-[#6e7681]">Select at least one enemy hero to see counter recommendations.</p>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs">
                  <span className="text-[#6e7681]">Try:</span>
                  {TRY_EXAMPLES.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => {
                        const id = heroByName.get(n.toLowerCase());
                        if (id !== undefined) d.addEnemy(id);
                      }}
                      className="rounded-full border border-[#30363d] bg-[#161b22] px-3 py-1 text-[#8b949e] hover:border-[#58a6ff] hover:text-[#e6edf3]"
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <footer className="mt-10 flex flex-wrap justify-between gap-2 border-t border-[#21262d] pt-4 text-xs text-[#6e7681]">
              <span>Dota Draft Assistant · plain-stats explanations, no AI.</span>
              <a className="underline hover:text-[#8b949e]" href="https://docs.opendota.com/" target="_blank" rel="noreferrer">Matchup data provided by OpenDota</a>
            </footer>
          </>
          )
        )}
      </div>
      {details && <HeroDetailsDrawer candidate={details} enemyIds={d.enemies} heroById={d.heroById} onClose={() => setDetails(null)} />}
    </div>
  );
}