import { useCallback, useEffect, useMemo, useState } from 'react';
import { APP_CONFIG, type PositionFilter } from '../config';
import type { CandidateScore, Hero, MatchupRow } from '../types';
import { loadDataset, type Dataset } from './dataset';
import { scoreCandidates } from '../scoring/engine';

export type LoadState =
  | { kind: 'loading'; message: string }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

const LANES: Exclude<PositionFilter, 'all'>[] = ['1', '2', '3', '4', '5'];

/** Production data flow (§23): one static snapshot → local state → local scoring.
 *  Recommendations recompute automatically on every draft change (§9) — no
 *  Calculate button, no network per pick. */
export function useDraftData() {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading', message: 'Loading hero data…' });
  const [enemies, setEnemies] = useState<number[]>([]);
  const [position, setPosition] = useState<PositionFilter>('all');

  useEffect(() => {
    let alive = true;
    loadDataset()
      .then((ds) => {
        if (!alive) return;
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

  const heroes = dataset?.heroes ?? [];
  const heroById = dataset?.heroById ?? new Map<number, Hero>();
  const matchups = dataset?.matchups ?? new Map<number, MatchupRow[]>();

  // Strict coverage holds only when every selected enemy has a matchup table.
  const missingTables = useMemo(
    () => enemies.filter((id) => !matchups.has(id)),
    [enemies, matchups],
  );

  // Auto-recompute (§9): local scoring is fast, no request gate needed.
  const results = useMemo(() => {
    if (enemies.length === 0 || missingTables.length > 0) return null;
    const lanes = position === 'all' ? LANES : [position];
    const out = new Map<Exclude<PositionFilter, 'all'>, CandidateScore[]>();
    for (const lane of lanes) {
      out.set(lane, scoreCandidates({ heroes, enemyIds: enemies, matchupByEnemy: matchups, heroById }, lane));
    }
    return out;
  }, [enemies, position, heroes, matchups, heroById, missingTables.length]);

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
    addEnemy,
    removeEnemy,
    clearEnemies,
    results,
    /** Enemies without a matchup table — strict coverage blocks ranking (§21). */
    missingTables,
  };
}
