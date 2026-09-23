import { APP_CONFIG } from '../config';
import { RU_NAMES } from './ruNames';
import { searchHeroes as searchHeroesLocal } from './heroes';
import type { Hero, MatchupRow } from '../types';

/** Static snapshot produced by scripts/update-data.mjs (see meta.json for freshness).
 *  No runtime OpenDota calls in production — the app runs fully on this dataset. */
interface DatasetMeta {
  source: string;
  generatedAt: string;
  latestPatch: string;
  heroCount: number;
}

export interface Dataset {
  heroes: Hero[];
  heroById: Map<number, Hero>;
  matchups: Map<number, MatchupRow[]>;
  meta: DatasetMeta;
}

let cache: Dataset | null = null;
let inflight: Promise<Dataset> | null = null;

export async function loadDataset(): Promise<Dataset> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const [heroesRes, matchupsRes, metaRes] = await Promise.all([
      fetch(`${import.meta.env.BASE_URL}data/heroes.json`),
      fetch(`${import.meta.env.BASE_URL}data/matchups.json`),
      fetch(`${import.meta.env.BASE_URL}data/meta.json`),
    ]);
    if (!heroesRes.ok) throw new Error(`Failed to load hero data (${heroesRes.status}).`);
    if (!matchupsRes.ok) throw new Error(`Failed to load matchup data (${matchupsRes.status}).`);
    if (!metaRes.ok) throw new Error(`Failed to load dataset metadata (${metaRes.status}).`);
    const raw = (await heroesRes.json()) as Array<Omit<Hero, 'key' | 'nameRu'>>;
    const heroes: Hero[] = raw.map((h) => ({
      ...h,
      key: `npc_dota_hero_${h.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      nameRu: RU_NAMES[h.name] ?? '',
    }));
    const matchupsRaw = (await matchupsRes.json()) as Record<string, MatchupRow[]>;
    const meta = (await metaRes.json()) as DatasetMeta;
    const heroById = new Map(heroes.map((h) => [h.id, h]));
    const matchups = new Map<number, MatchupRow[]>();
    for (const [id, rows] of Object.entries(matchupsRaw)) {
      const numId = Number(id);
      if (heroById.has(numId) && Array.isArray(rows)) matchups.set(numId, rows);
    }
    const ds: Dataset = { heroes, heroById, matchups, meta };
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