import { APP_CONFIG } from '../config';
import { RU_NAMES } from './ruNames';
import { searchHeroes as searchHeroesLocal } from './heroes';
import type {
  Hero,
  HeroPositionEntry,
  ItemEntry,
  ItemStatEntry,
  ItemCatalogue,
  ItemStatsDataset,
  MatchupRow,
  PositionDataset,
} from '../types';

/** Static snapshot produced by scripts/update-data-stratz.mjs (see meta.json for freshness).
 *  Matchups come from STRATZ weekly buckets, hero metadata from OpenDota.
 *  No runtime third-party calls in production — the app runs fully on this dataset. */
export interface DatasetMeta {
  source: string;
  heroMetadataSource?: string;
  generatedAt: string;
  latestPatch: string;
  heroCount: number;
  matchupWindow?: {
    kind?: string;
    weeks: number;
    weeklyBuckets: number[];
    completeWeeksOnly: boolean;
    windowStartUtc: string;
    windowEndUtcExclusive: string;
    excludedBuckets?: {
      currentIncomplete: number;
      reason: string;
    };
  };
  population?: {
    type: string;
    description: string;
    brackets: string[];
  };
  matchupPatchFilter?: boolean;
  positionData?: {
    source: string;
    weeks: number;
    weeklyBuckets: number[];
    completeWeeksOnly: boolean;
    population: { type: string; description: string; brackets: string[] };
    eligibility?: { minShare: number; minGames: number; rule: string };
  };
}

export interface Dataset {
  heroes: Hero[];
  heroById: Map<number, Hero>;
  matchups: Map<number, MatchupRow[]>;
  /** Real pick rates per lane (ТЗ №9) — the hard eligibility gate. */
  positions: PositionDataset;
  /** Item metadata (ТЗ §12). */
  items: ItemCatalogue;
  /** Hero + Position -> item purchase statistics (ТЗ §12, LEVEL 1 only). */
  itemStats: ItemStatsDataset;
  meta: DatasetMeta;
}

let cache: Dataset | null = null;
let inflight: Promise<Dataset> | null = null;

export async function loadDataset(): Promise<Dataset> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const [heroesRes, matchupsRes, positionsRes, itemsRes, itemStatsRes, metaRes] = await Promise.all([
      fetch(`${import.meta.env.BASE_URL}data/heroes.json`),
      fetch(`${import.meta.env.BASE_URL}data/matchups.json`),
      fetch(`${import.meta.env.BASE_URL}data/positions.json`),
      fetch(`${import.meta.env.BASE_URL}data/items.json`),
      fetch(`${import.meta.env.BASE_URL}data/item-stats.json`),
      fetch(`${import.meta.env.BASE_URL}data/meta.json`),
    ]);
    if (!heroesRes.ok) throw new Error(`Failed to load hero data (${heroesRes.status}).`);
    if (!matchupsRes.ok) throw new Error(`Failed to load matchup data (${matchupsRes.status}).`);
    // Positions are a HARD eligibility gate, not an optional signal: without
    // them we cannot tell a real pos-4 pick from a forced one, so the app must
    // refuse to rank rather than fall back to the old generic role tags.
    if (!positionsRes.ok) throw new Error(`Failed to load position data (${positionsRes.status}).`);
    if (!itemsRes.ok) throw new Error(`Failed to load item metadata (${itemsRes.status}).`);
    if (!itemStatsRes.ok) throw new Error(`Failed to load item statistics (${itemStatsRes.status}).`);
    if (!metaRes.ok) throw new Error(`Failed to load dataset metadata (${metaRes.status}).`);
    const raw = (await heroesRes.json()) as Array<Omit<Hero, 'key' | 'nameRu'>>;
    const heroes: Hero[] = raw.map((h) => ({
      ...h,
      key: `npc_dota_hero_${h.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      nameRu: RU_NAMES[h.name] ?? '',
    }));
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

    // Item layers are keyed by hero, so a partial catalogue or a mismatched
    // statistics file would silently mislabel builds later. Coerce the numeric
    // keys here and assert the roster lines up.
    const items: ItemCatalogue = {};
    for (const [id, entry] of Object.entries((await itemsRes.json()) as Record<string, ItemEntry>)) {
      items[Number(id)] = entry;
    }
    const itemStats: ItemStatsDataset = {};
    for (const [id, byPos] of Object.entries(
      (await itemStatsRes.json()) as Record<string, Record<string, Record<string, ItemStatEntry>>>,
    )) {
      const numId = Number(id);
      if (!heroById.has(numId)) continue;
      const positionsForHero: Record<string, Record<number, ItemStatEntry>> = {};
      for (const [pos, byItem] of Object.entries(byPos)) {
        const numericItems: Record<number, ItemStatEntry> = {};
        for (const [iid, cell] of Object.entries(byItem)) numericItems[Number(iid)] = cell;
        positionsForHero[pos] = numericItems;
      }
      itemStats[numId] = positionsForHero;
    }
    if (Object.keys(items).length === 0) {
      throw new Error('Item catalogue is empty — refusing to serve a dataset without item metadata.');
    }
    for (const byPos of Object.values(itemStats)) {
      for (const byItem of Object.values(byPos)) {
        for (const iid of Object.keys(byItem)) {
          if (!items[Number(iid)]) {
            throw new Error(`Item statistics reference item ${iid}, which is not in items.json.`);
          }
        }
      }
    }

    const ds: Dataset = { heroes, heroById, matchups, positions, items, itemStats, meta };
    cache = ds;
    return ds;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Freshness label for the UI (§17). */
export function freshnessLabel(meta: DatasetMeta): string {
  const h = (Date.now() - new Date(meta.generatedAt).getTime()) / 3600_000;
  if (!Number.isFinite(h) || h < 0) return 'Data updated: unknown';
  if (h < 1) return 'Data updated just now';
  if (h < 24) return `Data updated ${Math.floor(h)} hour${Math.floor(h) === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'Data updated yesterday';
  if (d <= 3) return `Data updated ${d} days ago`;
  return 'Data may be outdated';
}

export function searchHeroes(heroes: Hero[], q: string, limit?: number): Hero[] {
  return searchHeroesLocal(heroes, q, limit ?? Number(APP_CONFIG.ui.searchLimit));
}