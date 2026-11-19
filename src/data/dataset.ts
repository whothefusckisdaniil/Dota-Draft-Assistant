import { APP_CONFIG } from '../config';
import { ruNamesFor, searchHeroes as searchHeroesLocal } from './heroes';
import { computeBaseWinrates } from '../scoring/baseline';
import type {
  Hero,
  HeroPositionEntry,
  MatchupRow,
  PositionDataset,
} from '../types';

/** Population contract shared by the matchup and position layers. */
export interface PopulationMeta {
  type: string;
  description: string;
  brackets: string[];
}

/** Static snapshot produced by scripts/update-data-stratz.mjs (see meta.json for freshness).
 *  Matchups cover the last 30 days of the current patch (STRATZ, refreshed daily), hero metadata from OpenDota.
 *  No runtime third-party calls in production — the app runs fully on this dataset. */
export interface DatasetMeta {
  source: string;
  heroMetadataSource?: string;
  generatedAt: string;
  latestPatch: string;
  heroCount: number;
  /** Rolling window: the last `days` days, recomputed daily (see scripts/stratz/buckets.mjs). */
  matchupWindow?: {
    kind: 'rolling-days';
    days: number;
    windowStartUtc: string;
    windowEndUtc: string;
    weeklyBuckets: number[];
    bucketWeights: Record<string, number>;
    currentBucket: number;
    /** Weighted days of data in the window (< days right after a patch). */
    effectiveDays: number;
    /** The window never reaches back before this patch (see getRollingWindow). */
    patch: {
      name: string | null;
      releasedUtc: string | null;
      mode: 'FULL_WINDOW_SAME_PATCH' | 'CUT_AT_PATCH' | 'YOUNG_PATCH_FILLED' | 'NO_PATCH_DATE';
      prePatchWeight: number | null;
    };
    method?: string;
  };
  population?: {
    type: string;
    description: string;
    brackets: string[];
  };
  matchupPatchFilter?: boolean;
  /** Per-rank matchup tables (STRATZ only; absent in the OpenDota fallback). */
  brackets?: {
    file: string;
    ids: string[];
    labels: Record<string, string>;
  };
  positionData?: {
    source: string;
    days: number;
    weeklyBuckets: number[];
    bucketWeights: Record<string, number>;
    population: PopulationMeta;
    eligibility?: { minShare: number; minGames: number; rule: string };
  };
}

export interface Dataset {
  heroes: Hero[];
  heroById: Map<number, Hero>;
  matchups: Map<number, MatchupRow[]>;
  /** Real pick rates per lane (ТЗ №9) — the hard eligibility gate. */
  positions: PositionDataset;
  /** Baseline win rate per hero over the whole snapshot — the matchup-advantage reference. */
  baseWinrates: Map<number, number>;
  meta: DatasetMeta;
}

/** One rank bracket's matchup tables and its own baselines (advantage reference). */
export interface BracketTables {
  matchups: Map<number, MatchupRow[]>;
  baseWinrates: Map<number, number>;
}

let bracketCache: Map<string, BracketTables> | null = null;
let bracketInflight: Promise<Map<string, BracketTables> | null> | null = null;

/**
 * Lazily load the per-rank tables (only when a rank is chosen). Returns null
 * when the dataset has none (OpenDota fallback) — the UI then hides the rank
 * selector. Baselines are per rank: a hero's usual win rate differs by rank.
 */
export async function loadBracketTables(heroIds: Set<number>): Promise<Map<string, BracketTables> | null> {
  if (bracketCache) return bracketCache;
  if (bracketInflight) return bracketInflight;
  bracketInflight = (async () => {
    const raw = await fetchOptionalJson<Record<string, Record<string, MatchupRow[]>>>('matchups-by-bracket.json');
    if (!raw) return null;
    const out = new Map<string, BracketTables>();
    for (const [bracket, tables] of Object.entries(raw)) {
      const matchups = new Map<number, MatchupRow[]>();
      for (const [id, rows] of Object.entries(tables)) {
        const numId = Number(id);
        if (heroIds.has(numId) && Array.isArray(rows)) matchups.set(numId, rows);
      }
      out.set(bracket, { matchups, baseWinrates: computeBaseWinrates(matchups) });
    }
    bracketCache = out;
    return out;
  })();
  try {
    return await bracketInflight;
  } finally {
    bracketInflight = null;
  }
}

/**
 * Same-team (synergy) tables — `heroId -> teammate rows`, `wins` = wins of the
 * team with both heroes. Optional layer: null when the snapshot has none.
 * `all` is loaded when any draft exists; `byBracket` only when a rank is chosen.
 */
const synergyCache: { all?: Map<number, MatchupRow[]> | null; byBracket?: Map<string, Map<number, MatchupRow[]>> | null } = {};
const synergyInflight: { all?: Promise<Map<number, MatchupRow[]> | null>; byBracket?: Promise<Map<string, Map<number, MatchupRow[]>> | null> } = {};

function toTables(raw: Record<string, MatchupRow[]>, heroIds: Set<number>): Map<number, MatchupRow[]> {
  const m = new Map<number, MatchupRow[]>();
  for (const [id, rows] of Object.entries(raw)) {
    const n = Number(id);
    if (heroIds.has(n) && Array.isArray(rows)) m.set(n, rows);
  }
  return m;
}

async function fetchOptionalJson<T>(file: string, dir = 'data'): Promise<T | null> {
  const res = await fetch(`${import.meta.env.BASE_URL}${dir}/${file}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load ${file} (${res.status}).`);
  const type = res.headers.get('content-type') ?? '';
  // SPA hosting rewrites a missing file to index.html — treat that as "absent".
  if (type.includes('text/html')) return null;
  return (await res.json()) as T;
}

export async function loadSynergy(heroIds: Set<number>): Promise<Map<number, MatchupRow[]> | null> {
  if (synergyCache.all !== undefined) return synergyCache.all;
  synergyInflight.all ??= fetchOptionalJson<Record<string, MatchupRow[]>>('synergy.json').then((raw) => {
    synergyCache.all = raw ? toTables(raw, heroIds) : null;
    return synergyCache.all;
  }).finally(() => { synergyInflight.all = undefined; });
  return synergyInflight.all;
}

export async function loadSynergyByBracket(heroIds: Set<number>): Promise<Map<string, Map<number, MatchupRow[]>> | null> {
  if (synergyCache.byBracket !== undefined) return synergyCache.byBracket;
  synergyInflight.byBracket ??= fetchOptionalJson<Record<string, Record<string, MatchupRow[]>>>('synergy-by-bracket.json').then((raw) => {
    synergyCache.byBracket = raw ? new Map(Object.entries(raw).map(([b, t]) => [b, toTables(t, heroIds)])) : null;
    return synergyCache.byBracket;
  }).finally(() => { synergyInflight.byBracket = undefined; });
  return synergyInflight.byBracket;
}

/** Per-position win rates by rank: `{ ALL | bracket: { heroId: [[games, wins] × 5] } }`. Optional. */
export type RoleStats = Record<string, Record<string, [number, number][]>>;
let roleStatsPromise: Promise<RoleStats | null> | null = null;

export function loadRoleStats(): Promise<RoleStats | null> {
  roleStatsPromise ??= fetchOptionalJson<RoleStats>('role-stats.json').catch((e) => {
    roleStatsPromise = null;
    throw e;
  });
  return roleStatsPromise;
}

/** Hero builds (public/builds, scripts/update-builds-stratz.mjs). */
export type BuildItem = [itemId: number, pct: number, minute: number, winrate: number];
/** pct / wr are null for a pair nobody has picked yet (new talents early in a patch). */
export type BuildTalent = [heroLevel: number, a: [id: number, pct: number | null, wr: number | null], b: [id: number, pct: number | null, wr: number | null]];
export interface Build {
  m: number;
  low: boolean;
  start: [itemId: number, pct: number, qty: number][];
  boots: [itemId: number, pct: number, minute: number][];
  items: BuildItem[];
  talents: BuildTalent[];
  skills: [abilityId: number, maxedAtLevel: number, pctMaxed: number][];
}
export interface HeroBuilds {
  heroId: number;
  /** position '1'..'5' → 'ALL' | bracket → build */
  positions: Record<string, Record<string, Build>>;
}
export interface BuildIndex {
  generatedAt: string;
  patch: string;
  heroes: number[];
  /** itemId → [key, English name, component keys?] */
  items: Record<string, [string, string, string[]?]>;
  /** abilityId → [key, English name, Russian name] */
  abilities: Record<string, [string, string, string]>;
  /** heroId → position → rank → usual lane win share (0..1). */
  laneAvg?: Record<string, Record<string, Record<string, number>>>;
}

/** A hero's lane results with each partner, per position and rank. */
export interface HeroLanes {
  heroId: number;
  positions: Record<string, Record<string, { avg: number; partners: Record<string, [number, number, number]> }>>;
}
const heroLaneCache = new Map<number, Promise<HeroLanes | null>>();

export function loadHeroLanes(heroId: number): Promise<HeroLanes | null> {
  let p = heroLaneCache.get(heroId);
  if (!p) {
    p = fetchOptionalJson<HeroLanes>(`lanes/${heroId}.json`, 'builds').catch((e) => {
      heroLaneCache.delete(heroId);
      throw e;
    });
    heroLaneCache.set(heroId, p);
  }
  return p;
}

let buildIndexPromise: Promise<BuildIndex | null> | null = null;
const heroBuildCache = new Map<number, Promise<HeroBuilds | null>>();

export function loadBuildIndex(): Promise<BuildIndex | null> {
  buildIndexPromise ??= fetchOptionalJson<BuildIndex>('index.json', 'builds').catch((e) => {
    buildIndexPromise = null;
    throw e;
  });
  return buildIndexPromise;
}

export function loadHeroBuild(heroId: number): Promise<HeroBuilds | null> {
  let p = heroBuildCache.get(heroId);
  if (!p) {
    p = fetchOptionalJson<HeroBuilds>(`${heroId}.json`, 'builds').catch((e) => {
      heroBuildCache.delete(heroId);
      throw e;
    });
    heroBuildCache.set(heroId, p);
  }
  return p;
}

let cache: Dataset | null = null;
let inflight: Promise<Dataset> | null = null;

/** heroes.json as committed: every Hero field except the loader-added `nameRu`. */
type RawHeroFile = Omit<Hero, 'nameRu'>;

export async function loadDataset(): Promise<Dataset> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const [heroesRes, matchupsRes, positionsRes, metaRes] = await Promise.all([
      fetch(`${import.meta.env.BASE_URL}data/heroes.json`),
      fetch(`${import.meta.env.BASE_URL}data/matchups.json`),
      fetch(`${import.meta.env.BASE_URL}data/positions.json`),
      fetch(`${import.meta.env.BASE_URL}data/meta.json`),
    ]);
    if (!heroesRes.ok) throw new Error(`Failed to load hero data (${heroesRes.status}).`);
    if (!matchupsRes.ok) throw new Error(`Failed to load matchup data (${matchupsRes.status}).`);
    // Positions are a HARD eligibility gate, not an optional signal: without
    // them we cannot tell a real pos-4 pick from a forced one, so the app must
    // refuse to rank rather than fall back to the old generic role tags.
    if (!positionsRes.ok) throw new Error(`Failed to load position data (${positionsRes.status}).`);
    if (!metaRes.ok) throw new Error(`Failed to load dataset metadata (${metaRes.status}).`);
    // The raw file already carries the authoritative `key` (written by
    // normalizeHero). It is read as-is: no display-name slugification, because
    // that produced wrong keys for 20 heroes (ТЗ №18.1). An older snapshot
    // without `key` fails closed below.
    const raw = (await heroesRes.json()) as RawHeroFile[];
    const heroes: Hero[] = raw.map((h) => ({ ...h, nameRu: ruNamesFor(h.key).ru }));
    for (const h of heroes) {
      if (typeof h.key !== 'string' || !/^npc_dota_hero_[a-z0-9_]+$/.test(h.key)) {
        throw new Error(
          `Hero ${h.id} (${h.name}) has no valid npc_dota_hero key in heroes.json — ` +
          'regenerate the dataset. Deriving one from the display name is not safe.',
        );
      }
    }
    const matchupsRaw = (await matchupsRes.json()) as Record<string, MatchupRow[]>;
    const positionsRaw = (await positionsRes.json()) as Record<string, HeroPositionEntry>;
    const meta = (await metaRes.json()) as DatasetMeta;
    const heroById = new Map(heroes.map((h) => [h.id, h]));
    const matchups = new Map<number, MatchupRow[]>();
    for (const [id, rows] of Object.entries(matchupsRaw)) {
      const numId = Number(id);
      if (heroById.has(numId) && Array.isArray(rows)) matchups.set(numId, rows);
    }
    const positions: PositionDataset = {};
    for (const [id, entry] of Object.entries(positionsRaw)) {
      const numId = Number(id);
      if (heroById.has(numId)) positions[numId] = entry;
    }
    // A roster/positions mismatch would silently drop heroes from every lane.
    if (Object.keys(positions).length !== heroes.length) {
      throw new Error(
        `Position data covers ${Object.keys(positions).length} of ${heroes.length} heroes — refusing to rank on incomplete position data.`,
      );
    }

    const baseWinrates = computeBaseWinrates(matchups);
    // A hero with no games yet (released today) has no baseline; scoring falls
    // back to the neutral 50% for it (see expectedWinrate) and its 0-game pairs
    // are "no data". It must not take the whole site down.
    const ds: Dataset = { heroes, heroById, matchups, positions, baseWinrates, meta };
    cache = ds;
    return ds;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Freshness of the snapshot for the UI (§17), as a language-neutral value. */
export type Freshness =
  | { kind: 'unknown' | 'now' | 'yesterday' | 'outdated' }
  | { kind: 'hours' | 'days'; n: number };

export function freshness(meta: DatasetMeta, now = Date.now()): Freshness {
  const h = (now - new Date(meta.generatedAt).getTime()) / 3600_000;
  if (!Number.isFinite(h) || h < 0) return { kind: 'unknown' };
  if (h < 1) return { kind: 'now' };
  if (h < 24) return { kind: 'hours', n: Math.floor(h) };
  const d = Math.floor(h / 24);
  if (d === 1) return { kind: 'yesterday' };
  if (d <= 3) return { kind: 'days', n: d };
  return { kind: 'outdated' };
}

export function searchHeroes(heroes: Hero[], q: string, limit?: number): Hero[] {
  return searchHeroesLocal(heroes, q, limit ?? Number(APP_CONFIG.ui.searchLimit));
}