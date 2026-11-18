import { useCallback, useEffect, useMemo, useState } from 'react';
import { APP_CONFIG, type PositionFilter } from '../config';
import type { CandidateScore, Hero, MatchupRow } from '../types';
import {
  loadBracketTables,
  loadDataset,
  loadSynergy,
  loadSynergyByBracket,
  loadRoleStats,
  loadBuildIndex,
  loadHeroLanes,
  type BuildIndex,
  type HeroLanes,
  type RoleStats,
  type BracketTables,
  type Dataset,
} from './dataset';
import { scoreCandidates } from '../scoring/engine';
import { suggestBans } from '../scoring/bans';
import { assignAllyPositions, lanePartner, LANE_PARTNER } from '../scoring/allyPositions';
import type { LaneInput } from '../scoring/engine';
import { buildDraftSearch, draftTitle, parseDraftUrl } from './draftUrl';
import { useI18n } from '../i18n';

export type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error' };

const LANES: Exclude<PositionFilter, 'all'>[] = ['1', '2', '3', '4', '5'];

/** 'ALL' = all ranks combined; otherwise a STRATZ bracket id (e.g. DIVINE_IMMORTAL). */
export type RankFilter = string;
export const ALL_RANKS = 'ALL';
const RANK_STORAGE_KEY = 'dda.rank';
const POS_STORAGE_KEY = 'dda.pos';
const POSITION_IDS: PositionFilter[] = ['all', '1', '2', '3', '4', '5'];

/** Last role, unless the opened link names one. */
function initialPosition(fromUrl: PositionFilter): PositionFilter {
  try {
    if (new URLSearchParams(window.location.search).has('pos')) return fromUrl;
    const stored = localStorage.getItem(POS_STORAGE_KEY) as PositionFilter | null;
    return stored && POSITION_IDS.includes(stored) ? stored : fromUrl;
  } catch {
    return fromUrl;
  }
}

/** Where a hero picked in the search goes. */
export type PickTarget = 'enemy' | 'ally' | 'ban' | 'me';

const LIMITS: Record<PickTarget, number> = {
  enemy: APP_CONFIG.ui.maxEnemies,
  ally: APP_CONFIG.ui.maxAllies,
  ban: APP_CONFIG.ui.maxBans,
  me: 1,
};

function readStoredRank(): RankFilter {
  try {
    return localStorage.getItem(RANK_STORAGE_KEY) ?? ALL_RANKS;
  } catch {
    return ALL_RANKS;
  }
}

/** The draft a shared link opened with (read once, before the first render). */
function initialUrlState() {
  const { maxEnemies, maxAllies, maxBans } = APP_CONFIG.ui;
  try {
    return parseDraftUrl(window.location.search, maxEnemies, maxAllies, maxBans);
  } catch {
    return parseDraftUrl('', maxEnemies, maxAllies, maxBans);
  }
}

/** Production data flow (§23): one static snapshot → local state → local scoring.
 *  Recommendations recompute automatically on every draft change (§9) — no
 *  Calculate button, no network per pick. */
export function useDraftData() {
  const [urlState] = useState(initialUrlState);
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const i18n = useI18n();
  // A shared link wins over the stored rank preference, but does not overwrite
  // it: opening a friend's Divine link keeps your own default.
  const [enemies, setEnemies] = useState<number[]>(urlState.enemies);
  const [allies, setAllies] = useState<number[]>(urlState.allies);
  /** Positions the user set for allies (others are guessed). */
  const [allyPosSet, setAllyPosSet] = useState<Record<number, Exclude<PositionFilter, 'all'>>>(urlState.allyPos);
  /** Lane data: the builds index (usual lane shares) and allies' lane tables. */
  const [laneIndex, setLaneIndex] = useState<BuildIndex | null | undefined>(undefined);
  const [laneTables, setLaneTables] = useState<Map<number, HeroLanes | null>>(new Map());
  const [bans, setBans] = useState<number[]>(urlState.bans);
  /** Your own hero (its build is shown). Stored as a 0/1-element list like the others. */
  const [meList, setMeList] = useState<number[]>(urlState.me ? [urlState.me] : []);
  const me = meList[0] ?? null;
  const [target, setTarget] = useState<PickTarget>('enemy');
  const [position, setPositionState] = useState<PositionFilter>(() => initialPosition(urlState.position));
  const setPosition = useCallback((next: PositionFilter) => {
    setPositionState(next);
    try {
      localStorage.setItem(POS_STORAGE_KEY, next);
    } catch {
      /* not remembered */
    }
  }, []);
  const [rank, setRankState] = useState<RankFilter>(() => urlState.rank ?? readStoredRank());
  const [bracketTables, setBracketTables] = useState<Map<string, BracketTables> | null>(null);
  /** 'unavailable' (no rank file) | 'failed' (network/parse) — translated in the UI. */
  const [rankError, setRankError] = useState<'unavailable' | 'failed' | null>(null);
  /** undefined = not loaded yet; null = this snapshot has no synergy layer. */
  const [synergyAll, setSynergyAll] = useState<Map<number, MatchupRow[]> | null | undefined>(undefined);
  const [synergyByBracket, setSynergyByBracket] = useState<Map<string, Map<number, MatchupRow[]>> | null | undefined>(undefined);

  /** Per-position win rates (no-draft "top supports"); undefined = loading, null = absent. */
  const [roleStats, setRoleStats] = useState<RoleStats | null | undefined>(undefined);

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
  const hasDraft = enemies.length > 0 || allies.length > 0;
  const heroIdSet = useMemo(() => new Set(dataset?.heroes.map((h) => h.id) ?? []), [dataset]);

  useEffect(() => {
    let alive = true;
    loadDataset()
      .then((ds) => {
        if (!alive) return;
        // Drop ids from the URL that this snapshot does not know.
        const known = (ids: number[]) => ids.filter((id) => ds.heroById.has(id));
        setEnemies(known);
        setAllies(known);
        setBans(known);
        setMeList(known);
        setDataset(ds);
        setLoadState({ kind: 'ready' });
      })
      .catch((e) => {
        if (!alive) return;
        console.error(e);
        setLoadState({ kind: 'error' });
      });
    return () => {
      alive = false;
    };
  }, []);

  // Per-position win rates for the empty-draft screen (small, optional).
  useEffect(() => {
    if (!dataset || roleStats !== undefined) return;
    let alive = true;
    loadRoleStats()
      .then((r) => alive && setRoleStats(r))
      .catch((e) => {
        console.error(e);
        if (alive) setRoleStats(null);
      });
    return () => {
      alive = false;
    };
  }, [dataset, roleStats]);

  // Lane partner data: only with allies (small files, one per ally).
  useEffect(() => {
    if (!dataset || allies.length === 0) return;
    let alive = true;
    if (laneIndex === undefined) {
      loadBuildIndex().then((ix) => alive && setLaneIndex(ix)).catch(() => alive && setLaneIndex(null));
    }
    for (const id of allies) {
      if (laneTables.has(id)) continue;
      loadHeroLanes(id)
        .then((t) => alive && setLaneTables((m) => new Map(m).set(id, t)))
        .catch(() => alive && setLaneTables((m) => new Map(m).set(id, null)));
    }
    return () => {
      alive = false;
    };
  }, [dataset, allies, laneIndex, laneTables]);

  // Per-rank matchup tables: only when a rank is chosen.
  useEffect(() => {
    if (!dataset || activeRank === ALL_RANKS || bracketTables) return;
    let alive = true;
    setRankError(null);
    loadBracketTables(heroIdSet)
      .then((tables) => {
        if (!alive) return;
        if (tables) setBracketTables(tables);
        else setRankError('unavailable');
      })
      .catch((e) => {
        if (!alive) return;
        console.error(e);
        setRankError('failed');
      });
    return () => {
      alive = false;
    };
  }, [dataset, activeRank, bracketTables, heroIdSet]);

  // Synergy (allies + ban suggestions): loaded once any hero is in the draft.
  useEffect(() => {
    if (!dataset || !hasDraft || synergyAll !== undefined) return;
    let alive = true;
    loadSynergy(heroIdSet)
      .then((t) => alive && setSynergyAll(t))
      .catch((e) => {
        console.error(e);
        if (alive) setSynergyAll(null);
      });
    return () => {
      alive = false;
    };
  }, [dataset, hasDraft, synergyAll, heroIdSet]);

  useEffect(() => {
    if (!dataset || !hasDraft || activeRank === ALL_RANKS || synergyByBracket !== undefined) return;
    let alive = true;
    loadSynergyByBracket(heroIdSet)
      .then((t) => alive && setSynergyByBracket(t))
      .catch((e) => {
        console.error(e);
        if (alive) setSynergyByBracket(null);
      });
    return () => {
      alive = false;
    };
  }, [dataset, hasDraft, activeRank, synergyByBracket, heroIdSet]);

  // Keep the URL in sync with the draft (replaceState: no history entry per
  // click). Only after the data has loaded, so unknown ids are already gone.
  useEffect(() => {
    if (!dataset) return;
    try {
      const search = buildDraftSearch(window.location.search, { enemies, allies, bans, me, allyPos: allyPosSet, position, rank: activeRank, lang: i18n.lang });
      if (search !== window.location.search) {
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`);
      }
      document.title = draftTitle(
        enemies.map((id) => { const h = dataset.heroById.get(id); return h ? i18n.heroName(h) : ''; }).filter(Boolean),
        i18n.t('title.base'),
        i18n.t('title.draft'),
      );
    } catch {
      /* a sandboxed frame may forbid history access — sharing just won't update */
    }
  }, [dataset, enemies, allies, bans, me, allyPosSet, position, activeRank, i18n]);

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

  // Same-team tables for the active rank. A rank without synergy falls back to
  // all ranks (an optional layer must not hide the counterpick results).
  const synergyRank = useAllRanks ? undefined : synergyByBracket === undefined ? undefined : synergyByBracket?.get(activeRank) ?? null;
  const synergyLoading = hasDraft && (synergyAll === undefined || (!useAllRanks && synergyByBracket === undefined));
  const synergy = useAllRanks ? synergyAll ?? null : synergyRank ?? synergyAll ?? null;
  /** Allies are picked but this snapshot has no same-team data. */
  const synergyUnavailable = allies.length > 0 && !synergyLoading && !synergy;

  // Strict coverage holds only when every selected enemy has a matchup table.
  const missingTables = useMemo(
    () => (rankLoading ? [] : enemies.filter((id) => !matchups.has(id))),
    [enemies, matchups, rankLoading],
  );

  // Ally positions: set by the user, otherwise guessed (never your own role).
  const allyPositions = useMemo(
    () => assignAllyPositions(allies, positions, allyPosSet, position === 'all' ? null : position),
    [allies, positions, allyPosSet, position],
  );
  /** Lane partner input for a candidate playing `lane`, if the data allows. */
  const laneInputFor = useCallback((lane: Exclude<PositionFilter, 'all'>): LaneInput | null => {
    const partner = lanePartner(lane, allyPositions);
    const partnerPos = LANE_PARTNER[lane];
    if (partner == null || !partnerPos || !laneIndex) return null;
    const table = laneTables.get(partner)?.positions[partnerPos];
    const rankKey = activeRank !== ALL_RANKS && table?.[activeRank] ? activeRank : 'ALL';
    const t = table?.[rankKey];
    if (!t) return null;
    return {
      allyId: partner,
      partners: t.partners,
      allyAvg: t.avg,
      candidateAvg: (id) => laneIndex.laneAvg?.[id]?.[lane]?.[rankKey] ?? laneIndex.laneAvg?.[id]?.[lane]?.ALL,
    };
  }, [allyPositions, laneIndex, laneTables, activeRank]);

  // Auto-recompute (§9): local scoring is fast, no request gate needed.
  const results = useMemo(() => {
    const scoreAllies = allies.length > 0 && !!synergy;
    if ((enemies.length === 0 && !scoreAllies) || missingTables.length > 0 || rankLoading) return null;
    if (allies.length > 0 && synergyLoading) return null;
    const lanes = position === 'all' ? LANES : [position];
    const out = new Map<Exclude<PositionFilter, 'all'>, CandidateScore[]>();
    for (const lane of lanes) {
      out.set(lane, scoreCandidates({
        heroes, enemyIds: enemies, matchupByEnemy: matchups, heroById, positions, baseWinrates,
        allyIds: allies, synergyByAlly: synergy, excludeIds: me ? [...bans, me] : bans,
        lane: laneInputFor(lane),
      }, lane));
    }
    return out;
  }, [enemies, allies, bans, me, position, heroes, matchups, heroById, positions, baseWinrates, synergy, synergyLoading, missingTables.length, rankLoading, laneInputFor]);

  const banSuggestions = useMemo(() => {
    if (!dataset || !hasDraft || rankLoading || synergyLoading) return [];
    return suggestBans({
      heroes, allyIds: allies, enemyIds: enemies, excludeIds: me ? [...bans, me] : bans,
      matchupByHero: matchups, synergyByHero: synergy, baseWinrates,
    });
  }, [dataset, hasDraft, rankLoading, synergyLoading, heroes, allies, enemies, bans, me, matchups, synergy, baseWinrates]);

  /** Put a hero into the enemy team, your team or the bans. A hero lives in
   *  one place only: adding it somewhere moves it out of the others. */
  const addHero = useCallback((id: number, to: PickTarget) => {
    const lists: Record<PickTarget, [number[], (f: (p: number[]) => number[]) => void]> = {
      enemy: [enemies, setEnemies], ally: [allies, setAllies], ban: [bans, setBans], me: [meList, setMeList],
    };
    const [current] = lists[to];
    if (current.includes(id)) return;
    // your hero is replaced, the other lists stop at their limit
    if (to !== 'me' && current.length >= LIMITS[to]) return;
    for (const key of Object.keys(lists) as PickTarget[]) {
      if (key !== to) lists[key][1]((prev) => prev.filter((x) => x !== id));
    }
    if (to === 'me') setMeList([id]);
    else lists[to][1]((prev) => (prev.includes(id) || prev.length >= LIMITS[to] ? prev : [...prev, id]));
  }, [enemies, allies, bans, meList]);

  const remove = useCallback((id: number, from: PickTarget) => {
    const set = from === 'enemy' ? setEnemies : from === 'ally' ? setAllies : from === 'me' ? setMeList : setBans;
    set((prev) => prev.filter((x) => x !== id));
  }, []);

  const clearAll = useCallback(() => {
    setEnemies([]);
    setAllies([]);
    setAllyPosSet({});
    setBans([]);
    setMeList([]);
    setTarget('enemy');
  }, []);

  /** Ids that cannot be picked again (anywhere in the draft). */
  const taken = useMemo(() => new Set([...enemies, ...allies, ...bans, ...meList]), [enemies, allies, bans, meList]);

  return {
    heroes,
    heroById,
    loadState,
    meta: dataset?.meta ?? null,
    enemies,
    allies,
    allyPositions,
    /** Set an ally's position (the lane partner follows). */
    setAllyPos: useCallback((id: number, pos: Exclude<PositionFilter, 'all'>) => setAllyPosSet((m) => ({ ...m, [id]: pos })), []),
    bans,
    me,
    taken,
    target,
    setTarget,
    limits: LIMITS,
    addHero,
    remove,
    clearAll,
    // kept for callers that only deal with enemies
    addEnemy: useCallback((id: number) => addHero(id, 'enemy'), [addHero]),
    removeEnemy: useCallback((id: number) => remove(id, 'enemy'), [remove]),
    clearEnemies: clearAll,
    position,
    setPosition,
    /** Rank selector: ids offered by the snapshot (empty → hide the selector). */
    rankOptions,
    rankLabels: dataset?.meta.brackets?.labels ?? {},
    rank: activeRank,
    setRank,
    rankLoading,
    rankError,
    synergyLoading,
    synergyUnavailable,
    roleStats,
    results,
    banSuggestions,
    /** Enemies without a matchup table — strict coverage blocks ranking (§21). */
    missingTables,
  };
}
