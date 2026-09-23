import { useCallback, useMemo, useRef, useState } from 'react';
import type { AggModel, CandidateScore, Hero, MatchupRow } from '../types';
import { getHeroStats, getHeroes, getMatchupsMany, isMatchupError } from '../data/opendota';
import { mergeHeroes } from '../data/heroes';
import { APP_CONFIG } from '../config';
import { fmtDelta, laneLabel, scoreCandidates } from '../scoring/engine';
import type { Lane } from '../scoring/positionsExtra';
import { HeroSearch } from './HeroSearch';
import { HeroPortrait } from './HeroPortrait';

const LANES: Lane[] = ['1', '2', '3', '4', '5'];
const MODELS: { id: AggModel; label: string }[] = [
  { id: 'A', label: 'A — current (weighted mean)' },
  { id: 'M', label: 'M — median teamScore' },
  { id: 'W', label: 'W — weak-link penalty' },
];

interface LoadState {
  kind: 'idle' | 'loading' | 'ready' | 'error';
  message?: string;
}

/** Dev-only Draft validation: pick a real draft, inspect every score component
 *  the engine produces, per lane, plus coverage / weakest / best matchup. */
export function DraftValidation() {
  const [heroes, setHeroes] = useState<Hero[]>([]);
  const [enemyIds, setEnemyIds] = useState<number[]>([]);
  const [matchups, setMatchups] = useState<Map<number, MatchupRow[]>>(new Map());
  const [failed, setFailed] = useState<Set<number>>(new Set());
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [model, setModel] = useState<AggModel>('A');
  // Any draft change invalidates in-flight and finished runs (same policy as useDraftData).
  const requestId = useRef(0);
  const snapshot = useRef(enemyIds);

  function changeDraft(next: number[] | ((p: number[]) => number[])) {
    requestId.current += 1; // stale load() responses are dropped
    snapshot.current = typeof next === 'function' ? next(snapshot.current) : next;
    setEnemyIds(snapshot.current);
    setState({ kind: 'idle' }); // old results are no longer valid for the new draft
  }

  const heroById = useMemo(() => new Map(heroes.map((h) => [h.id, h])), [heroes]);
  const enemySet = useMemo(() => new Set(enemyIds), [enemyIds]);

  const load = useCallback(async () => {
    const myRequest = requestId.current;
    const draft = snapshot.current;
    if (draft.length === 0) return;
    setState({ kind: 'loading', message: 'Loading hero data…' });
    try {
      const [list, stats] = await Promise.all([getHeroes(), getHeroStats().catch(() => [])]);
      if (requestId.current !== myRequest) return; // draft changed mid-flight
      const merged = mergeHeroes(list, stats);
      setHeroes(merged);
      const byId = new Map(merged.map((h) => [h.id, h]));
      setState({ kind: 'loading', message: 'Analyzing matchups…' });
      const res = await getMatchupsMany(draft);
      if (requestId.current !== myRequest) return; // draft changed mid-flight
      const ok = new Map<number, MatchupRow[]>();
      const bad = new Set<number>();
      for (const [id, v] of res) {
        if (isMatchupError(v)) bad.add(id);
        else ok.set(id, v);
      }
      setMatchups(ok);
      setFailed(bad);
      setState(bad.size > 0
        ? { kind: 'error', message: `Matchup data failed for: ${[...bad].map((id) => byId.get(id)?.name ?? `#${id}`).join(', ')}` }
        : { kind: 'ready' });
    } catch (e) {
      if (requestId.current !== myRequest) return; // draft changed mid-flight
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const results = useMemo(() => {
    if (state.kind !== 'ready' || enemyIds.length === 0) return null;
    const failedIds = [...failed].filter((id) => enemyIds.includes(id));
    const out = new Map<Lane, CandidateScore[]>();
    for (const lane of LANES) {
      out.set(lane, scoreCandidates({ heroes, enemyIds, matchupByEnemy: matchups, heroById, failedEnemyIds: failedIds }, lane, { model }));
    }
    return out;
  }, [state, enemyIds, heroes, matchups, heroById, failed, model]);

  const nameOf = (id: number) => heroById.get(id)?.name ?? `#${id}`;

  function breakdown(c: CandidateScore, model: AggModel) {
    const usable = c.matchups.filter((m) => m.usable);
    const sorted = [...usable].sort((a, b) => b.delta - a.delta);
    const s = c.deltaStats;
    const badCount = usable.filter((m) => m.delta < APP_CONFIG.scoring.weakLinkThreshold).length;
    // The team figure shown must be the one this model's finalScore was built from:
    // M ranks by median, A/W by the √games-weighted mean; W additionally subtracts
    // weakLinkPenalty per very bad matchup — show that too.
    const teamStr = model === 'M'
      ? `team ${c.teamScoreM!.toFixed(2)} (median)`
      : `team ${c.teamScore.toFixed(2)} (weighted mean)`;
    const penaltyStr = model === 'W'
      ? ` · weak-link penalty −${APP_CONFIG.scoring.weakLinkPenalty}×${badCount}`
      : '';
    return (
      <div className="mt-2 space-y-1 border-t border-[#21262d] pt-2 font-mono text-xs text-[#8b949e]">
        <div>
          {teamStr}{penaltyStr} · conf {c.confidence.toFixed(2)} · role {c.positionScore.toFixed(1)} →
          bonus {c.positionBonus >= 0 ? '+' : ''}{c.positionBonus.toFixed(2)} · avg {Math.round(c.avgGames).toLocaleString()}g ·
          final <span className="text-[#e6edf3]">{c.finalScore.toFixed(2)}</span>
        </div>
        <div>
          mean {s.mean >= 0 ? '+' : ''}{s.mean.toFixed(1)} · median {s.median >= 0 ? '+' : ''}{s.median.toFixed(1)} ·
          min <span className={s.min < -2 ? 'text-[#f85149]' : ''}>{s.min >= 0 ? '+' : ''}{s.min.toFixed(1)}</span> ·
          max {s.max >= 0 ? '+' : ''}{s.max.toFixed(1)}
        </div>
        <div>
          Coverage {usable.length}/{c.matchups.length} enemies
          {sorted.length > 0 && <> · best {nameOf(sorted[0].enemyId)} {fmtDelta(sorted[0].delta)}</>}
          {sorted.length > 1 && <> · worst {nameOf(sorted[sorted.length - 1].enemyId)} {fmtDelta(sorted[sorted.length - 1].delta)}</>}
        </div>
        {usable.map((m) => (
          <div key={m.enemyId} className="flex gap-2">
            <span className="w-40 shrink-0 truncate text-[#e6edf3]">{nameOf(m.enemyId)}</span>
            <span className={m.delta >= 0 ? 'text-[#3fb950]' : 'text-[#f85149]'}>{fmtDelta(m.delta)}</span>
            <span className="ml-auto">{Math.round(m.games).toLocaleString()}g · {m.winrate.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-[#30363d] bg-[#0d1117] p-4 sm:p-6">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">DRAFT VALIDATION <span className="text-xs font-normal text-[#8b949e]">dev-only</span></h2>
        <span className="text-xs text-[#6e7681]">Real OpenDota data · full engine output, no UI shortcuts</span>
      </div>
      <div className="mb-3">
        <HeroSearch
          heroes={heroes}
          excluded={enemySet}
          onPick={(h) => changeDraft((p) => (p.includes(h.id) || p.length >= 5 ? p : [...p, h.id]))}
          disabled={state.kind === 'loading' || heroes.length === 0}
        />
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {enemyIds.map((id) => {
          const h = heroById.get(id);
          return (
            <span key={id} className="flex items-center gap-2 rounded-lg border border-[#30363d] bg-[#161b22] py-1 pl-1 pr-2 text-sm">
              {h && <HeroPortrait hero={h} size={24} variant="small" />}
              {h?.name ?? `#${id}`}
              <button type="button" onClick={() => changeDraft((p) => p.filter((x) => x !== id))} className="text-[#8b949e] hover:text-[#f85149]">×</button>
            </span>
          );
        })}
        <select
          value={model}
          onChange={(e) => setModel(e.target.value as AggModel)}
          className="rounded border border-[#30363d] bg-[#161b22] px-2 py-1.5 text-xs"
          title="Aggregation model: A = current (confidence), B = confidence removed, C = A + weak-link stats"
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={enemyIds.length === 0 || state.kind === 'loading'}
          onClick={() => void load()}
          className="ml-auto rounded-lg bg-[#1f6feb] px-4 py-1.5 text-xs font-bold uppercase tracking-wide hover:bg-[#388bfd] disabled:opacity-40"
        >
          {state.kind === 'loading' ? 'Loading…' : 'Run engine'}
        </button>
      </div>
      {state.kind === 'idle' && enemyIds.length > 0 && (
        <div className="rounded-lg border border-[#30363d] bg-[#161b22] p-3 text-sm text-[#6e7681]">
          Draft changed — run the engine to recalculate.
        </div>
      )}
      {state.kind === 'loading' && (
        <div className="rounded-lg border border-[#30363d] bg-[#161b22] p-3 text-sm text-[#8b949e]">{state.message}</div>
      )}
      {state.kind === 'error' && (
        <div className="rounded-lg border border-[#f85149]/40 bg-[#f85149]/10 p-3 text-sm text-[#f85149]">
          {state.message} — engine output is blocked until every selected enemy has matchup data.
        </div>
      )}
      {state.kind === 'ready' && results && (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {LANES.map((lane) => (
            <div key={lane} className="rounded-xl border border-[#30363d] bg-[#161b22] p-3">
              <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-[#e6edf3]">{laneLabel(lane)}</h3>
              {(results.get(lane) ?? []).length === 0 && (
                <p className="text-xs text-[#6e7681]">No hero passed coverage/role filters.</p>
              )}
              {(results.get(lane) ?? []).map((c, i) => (
                <div key={c.hero.id} className="border-b border-[#21262d] py-2 last:border-0">
                  <div className="flex items-center gap-2">
                    <span className="w-4 text-xs text-[#6e7681]">{i + 1}</span>
                    <HeroPortrait hero={c.hero} size={28} variant="small" />
                    <span className="flex-1 truncate text-sm text-[#e6edf3]">{c.hero.name}</span>
                    <span className="font-mono text-sm font-bold text-[#58a6ff]">{c.finalScore.toFixed(2)}</span>
                  </div>
                  <p className="ml-6 mt-0.5 text-xs text-[#8b949e]">{c.explanation[0]}</p>
                  {breakdown(c, model)}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}