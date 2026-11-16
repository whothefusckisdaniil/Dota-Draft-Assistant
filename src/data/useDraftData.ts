import { useCallback, useEffect, useMemo, useState } from 'react';
import { APP_CONFIG, type PositionFilter } from '../config';
import type { CandidateScore, Hero, MatchupRow } from '../types';
import { loadBracketTables, loadDataset, type BracketTables, type Dataset } from './dataset';
import { scoreCandidates } from '../scoring/engine';
import { buildDraftSearch, draftTitle, parseDraftUrl } from './draftUrl';

export type LoadState =
  | { kind: 'loading'; message: string }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

const LANES: Exclude<PositionFilter, 'all'>[] = ['1', '2', '3', '4', '5'];

/** 'ALL' = all ranks combined; otherwise a STRATZ bracket id (e.g. DIVINE_IMMORTAL). */
export type RankFilter = string;
export const ALL_RANKS = 'ALL';
const RANK_STORAGE_KEY = 'dda.rank';

function readStoredRank(): RankFilter {
  try {
    return localStorage.getItem(RANK_STORAGE_KEY) ?? ALL_RANKS;
  } catch {
    return ALL_RANKS;
  }
}

/** Production data flow (§23): one static snapshot → local state → local scoring.
 *  Recommendations recompute automatically on every draft change (§9) — no
 *  Calculate button, no network per pick. */
const BASE_TITLE = 'Dota Draft Assistant — Counter Picks';

/** The draft a shared link opened with (read once, before the first render). */
function initialUrlState() {
  try {
    return parseDraftUrl(window.location.search, APP_CONFIG.ui.maxEnemies);
  } catch {
    return parseDraftUrl('', APP_CONFIG.ui.maxEnemies);
  }
}

export function useDraftData() {
  const [urlState] = useState(initialUrlState);
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading', message: 'Loading hero data…' });
  // A shared link (`?enemy=…&pos=…&rank=…`) wins over the stored rank preference,
  // but does not overwrite it: opening a friend's Divine link keeps your own default.
  const [enemies, setEnemies] = useState<number[]>(urlState.enemies);
  const [position, setPosition] = useState<PositionFilter>(urlState.position);
  const [rank, setRankState] = useState<RankFilter>(() => urlState.rank ?? readStoredRank());
  const [bracketTables, setBracketTables] = useState<Map<string, BracketTables> | null>(null);
  const [rankError, setRankError] = useState<string | null>(null);

  const setRank = useCallback((next: RankFilter) => {
    setRankState(next);
    try {
      localStorage.setItem(RANK_STORAGE_KEY, next);
    } catch {
      /* storage unavailable — the choice just isn't remembered */
    }
  }, []);

  // Ranks offered by this snapshot; a stored rank the snapshot lacks falls back to all ranks.
  const rankOptions = dataset?.meta.brackets?.ids ?? [];
  const activeRank = rank !== ALL_RANKS && rankOptions.includes(rank) ? rank : ALL_RANKS;

  useEffect(() => {
    if (!dataset || activeRank === ALL_RANKS || bracketTables) return;
    let alive = true;
    setRankError(null);
    loadBracketTables(new Set(dataset.heroes.map((h) => h.id)))
      .then((tables) => {
        if (!alive) return;
        if (tables) setBracketTables(tables);
        else setRankError('Rank data is not available right now — showing all ranks.');
      })
      .catch((e) => {
        if (!alive) return;
        console.error(e);
        setRankError('Could not load rank data — showing all ranks.');
      });
    return () => {
      alive = false;
    };
  }, [dataset, activeRank, bracketTables]);

  useEffect(() => {
    let alive = true;
    loadDataset()
      .then((ds) => {
        if (!alive) return;
        // Drop enemy ids from the URL that this snapshot does not know.
        setEnemies((prev) => prev.filter((id) => ds.heroById.has(id)));
        setDataset(ds);
        setLoadState({ kind: 'ready' });
      })
      .catch((e) => {
        if (!alive) return;
        console.error(e);
        setLoadState({ kind: 'error', message: "We're having trouble loading Dota data. Please try again later." });
      });
    return () => {
      alive = false;
    };
  }, []);

  // Keep the URL in sync with the draft (replaceState: no history entry per
  // click). Only after the data has loaded, so unknown ids are already gone.
  useEffect(() => {
    if (!dataset) return;
    try {
      const search = buildDraftSearch(window.location.search, { enemies, position, rank: activeRank });
      if (search !== window.location.search) {
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`);
      }
      document.title = draftTitle(enemies.map((id) => dataset.heroById.get(id)?.name ?? '').filter(Boolean), BASE_TITLE);
    } catch {
      /* a sandboxed frame may forbid history access — sharing just won't update */
    }
  }, [dataset, enemies, position, activeRank]);

  const heroes = dataset?.heroes ?? [];
  const heroById = dataset?.heroById ?? new Map<number, Hero>();
  const positions = dataset?.positions ?? {};
  // Selected rank: its own tables and baselines. While they load (or if they
  // failed) the all-ranks data is NOT silently shown under a rank label.
  const rankTables = activeRank === ALL_RANKS ? null : bracketTables?.get(activeRank) ?? null;
  const rankLoading = activeRank !== ALL_RANKS && !rankTables && !rankError;
  const useAllRanks = activeRank === ALL_RANKS || (!rankTables && !!rankError);
  const matchups = useAllRanks
    ? dataset?.matchups ?? new Map<number, MatchupRow[]>()
    : rankTables?.matchups ?? new Map<number, MatchupRow[]>();
  const baseWinrates = useAllRanks ? dataset?.baseWinrates : rankTables?.baseWinrates;

  // Strict coverage holds only when every selected enemy has a matchup table.
  const missingTables = useMemo(
    () => (rankLoading ? [] : enemies.filter((id) => !matchups.has(id))),
    [enemies, matchups, rankLoading],
  );

  // Auto-recompute (§9): local scoring is fast, no request gate needed.
  const results = useMemo(() => {
    if (enemies.length === 0 || missingTables.length > 0 || rankLoading) return null;
    const lanes = position === 'all' ? LANES : [position];
    const out = new Map<Exclude<PositionFilter, 'all'>, CandidateScore[]>();
    for (const lane of lanes) {
      out.set(lane, scoreCandidates({ heroes, enemyIds: enemies, matchupByEnemy: matchups, heroById, positions, baseWinrates }, lane));
    }
    return out;
  }, [enemies, position, heroes, matchups, heroById, positions, baseWinrates, missingTables.length, rankLoading]);

  const addEnemy = useCallback((id: number) => {
    setEnemies((prev) => (prev.includes(id) || prev.length >= APP_CONFIG.ui.maxEnemies ? prev : [...prev, id]));
  }, []);

  const removeEnemy = useCallback((id: number) => {
    setEnemies((prev) => prev.filter((e) => e !== id));
  }, []);

  const clearEnemies = useCallback(() => setEnemies([]), []);

  return {
    heroes,
    heroById,
    loadState,
    meta: dataset?.meta ?? null,
    enemies,
    position,
    setPosition,
    /** Rank selector: ids offered by the snapshot (empty → hide the selector). */
    rankOptions,
    rankLabels: dataset?.meta.brackets?.labels ?? {},
    rank: activeRank,
    setRank,
    rankLoading,
    rankError,
    addEnemy,
    removeEnemy,
    clearEnemies,
    results,
    /** Enemies without a matchup table — strict coverage blocks ranking (§21). */
    missingTables,
  };
}
