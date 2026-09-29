export interface OpenDotaHero {
  id: number;
  name: string; // npc_dota_hero_*
  localized_name: string;
  primary_attr: string;
  attack_type: string;
  roles: string[];
  legs: number;
}

export interface HeroStatsEntry extends OpenDotaHero {
  img: string;
  icon: string;
  pro_pick: number;
  pro_win: number;
  pro_ban: number;
  pub_pick: number;
  pub_win: number;
  turbo_picks: number;
  turbo_wins: number;
  [k: string]: unknown;
}

export interface MatchupRow {
  hero_id: number; // opponent id when fetched via /heroes/{id}/matchups
  games_played: number;
  wins: number; // wins of the *base* hero (the {id} in the URL) vs hero_id
}

export interface PatchEntry {
  name: string;
  date: string;
  id: number;
}

/** One hero's real pick rates per lane, from STRATZ (ТЗ №9). */
export interface HeroPositionStat {
  games: number;
  /** games / totalGames, in [0, 1]. */
  share: number;
}

export interface HeroPositionEntry {
  totalGames: number;
  positions: Record<'1' | '2' | '3' | '4' | '5', HeroPositionStat>;
}

export type PositionDataset = Record<number, HeroPositionEntry>;

/** Canonical item metadata (public/data/items.json). */
export interface ItemEntry {
  id: number;
  /** Display name, e.g. "Battle Fury". */
  name: string;
  /** STRATZ internal name, e.g. "item_bfury". */
  dname: string;
  shortName: string;
  cost: number;
  isPurchasable: boolean;
  isStackable: boolean;
  isSideShop: boolean;
  stockMax: number;
  isSupportFullItem: boolean;
  image: string;
  components: number[];
}

export type ItemCatalogue = Record<number, ItemEntry>;

/**
 * Purchase statistics for one item on one hero/position (ТЗ §12).
 *
 * `purchases` counts purchase EVENTS, not distinct games — it can and does
 * exceed `heroGames` (measured: Battle Fury 130% for Anti-Mage). There is
 * deliberately no `rate` field: a consumer that wants one must decide what it
 * means, and "purchases / games" is purchases-per-game, not a percentage of
 * games. `wins / purchases` is a winrate *among purchases*, not a causal
 * "this item gives you X%".
 */
export interface ItemStatEntry {
  purchases: number;
  wins: number;
  /** Hero games in the same window/brackets/position, from the position layer. */
  heroGames: number;
  /** minute -> purchase events. A histogram on purpose, not a precomputed mean. */
  byMinute: Record<number, number>;
  /** purchase-events copy index -> count. 0 is the first copy owned. */
  instances: Record<number, number>;
}

/** heroId -> position ('1'..'5') -> itemId -> statistics. */
export type ItemStatsDataset = Record<number, Record<string, Record<number, ItemStatEntry>>>;

export interface Hero {
  id: number;
  key: string; // npc_dota_hero_*
  name: string; // localized
  primaryAttr: string;
  attackType: string;
  roles: string[];
  img: string;
  icon: string;
  proPick: number;
  proWin: number;
  pubPick: number;
  pubWin: number;
  nameRu: string;
}

export interface MatchupDetail {
  enemyId: number;
  games: number;
  winsForCandidate: number;
  winrate: number; // % for candidate vs enemy
  delta: number; // winrate - 50, shrunk
  rawDelta: number;
  usable: boolean;
}

/** Distribution stats over usable matchup deltas (pp). */
export interface DeltaStats {
  mean: number; // plain average of usable deltas
  median: number;
  min: number; // weakest matchup — the "weak link"
  max: number;
}

/** Aggregation models for the experiment lab. All share the same normalized
 *  matchup data and the same position model — only the teamScore aggregation
 *  and the final confidence step differ.
 *  A — current: √games-weighted mean + final confidence blend (production)
 *  M — median: teamScore = median of usable shrunk deltas (final confidence kept)
 *  W — weak-link: current aggregation + small penalty for a very bad matchup
 *      (final confidence kept). Diagnostic, not a tuned ranking. */
export type AggModel = 'A' | 'M' | 'W';

export interface AggOptions {
  model?: AggModel;
  /** Lab override for APP_CONFIG.scoring.requireFullCoverage. */
  requireFullCoverage?: boolean;
}

export interface CandidateScore {
  hero: Hero;
  teamScore: number; // √games-weighted mean delta, pp (models A/W)
  teamScoreM?: number; // median delta, pp — present only in model M
  avgGames: number;
  confidence: number; // 0..1
  positionScore: number; // 0..10 per requested lane
  positionBonus: number; // -range..+range
  finalScore: number;
  matchups: MatchupDetail[];
  usableEnemies: number;
  lowData: boolean;
  explanation: string[];
  bestAgainst: string[];
  worstAgainst: string[];
  /** Distribution of usable shrunk deltas — makes variance visible. */
  deltaStats: DeltaStats;
}

export type DataStatus =
  | { kind: 'loading'; message: string }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };
