import type { MatchupRow, OpenDotaHero, PatchEntry, HeroStatsEntry } from '../types';
import { APP_CONFIG } from '../config';

async function fetchJson<T>(url: string, timeoutMs = 20000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      if (res.status === 429) throw new Error('Rate limited by OpenDota (429). Please wait a minute and retry.');
      throw new Error(`OpenDota request failed (${res.status}) for ${url}`);
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error(`Request timed out for ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ---------- localStorage cache with TTL ----------

function cacheKey(kind: string, id?: string | number): string {
  return `dda:${kind}${id !== undefined ? `:${id}` : ''}`;
}

function readCache<T>(kind: string, ttlHours: number, id?: string | number): { data: T; ts: number } | null {
  try {
    const raw = localStorage.getItem(cacheKey(kind, id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data: T; ts: number };
    if (!parsed || typeof parsed.ts !== 'number') return null;
    const ageMs = Date.now() - parsed.ts;
    if (ageMs > ttlHours * 3600 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache<T>(kind: string, data: T, id?: string | number): void {
  try {
    localStorage.setItem(cacheKey(kind, id), JSON.stringify({ data, ts: Date.now() }));
  } catch {
    // quota exceeded etc — non-fatal
  }
}

export async function getHeroes(force = false): Promise<OpenDotaHero[]> {
  if (!force) {
    const c = readCache<OpenDotaHero[]>('heroes', APP_CONFIG.cacheTtlHours.heroes);
    if (c) return c.data;
  }
  const data = await fetchJson<OpenDotaHero[]>(`${APP_CONFIG.apiBase}/heroes`);
  writeCache('heroes', data);
  return data;
}

export async function getHeroStats(force = false): Promise<HeroStatsEntry[]> {
  if (!force) {
    const c = readCache<HeroStatsEntry[]>('heroStats', APP_CONFIG.cacheTtlHours.heroStats);
    if (c) return c.data;
  }
  const data = await fetchJson<HeroStatsEntry[]>(`${APP_CONFIG.apiBase}/heroStats`);
  writeCache('heroStats', data);
  return data;
}

/** Matchups for ONE enemy hero id: wins = enemy wins vs opponent. */
export async function getMatchups(enemyId: number, force = false): Promise<MatchupRow[]> {
  if (!force) {
    const c = readCache<MatchupRow[]>('matchups', APP_CONFIG.cacheTtlHours.matchups, enemyId);
    if (c) return c.data;
  }
  const data = await fetchJson<MatchupRow[]>(`${APP_CONFIG.apiBase}/heroes/${enemyId}/matchups`);
  writeCache('matchups', data, enemyId);
  return data;
}

export async function getPatches(force = false): Promise<PatchEntry[]> {
  if (!force) {
    const c = readCache<PatchEntry[]>('patch', APP_CONFIG.cacheTtlHours.patch);
    if (c) return c.data;
  }
  const data = await fetchJson<PatchEntry[]>(`${APP_CONFIG.apiBase}/constants/patch`);
  writeCache('patch', data);
  return data;
}

/** Fetch matchups for several enemies with limited concurrency; never throws for a single hero. */
export async function getMatchupsMany(
  enemyIds: number[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<number, MatchupRow[] | { __error: string }>> {
  const out = new Map<number, MatchupRow[] | { __error: string }>();
  const queue = [...enemyIds];
  let done = 0;
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length > 0) {
      const id = queue.shift()!;
      try {
        out.set(id, await getMatchups(id));
      } catch (e) {
        out.set(id, { __error: e instanceof Error ? e.message : String(e) });
      }
      done += 1;
      onProgress?.(done, enemyIds.length);
    }
  });
  await Promise.all(workers);
  return out;
}

export function isMatchupError(v: MatchupRow[] | { __error: string }): v is { __error: string } {
  return !Array.isArray(v);
}
