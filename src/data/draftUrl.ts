import type { PositionFilter } from '../config';

/**
 * Shareable draft state in the URL: `/?enemy=1,5,23&ally=8,14&ban=74&pos=3&rank=divine`.
 *
 * - `enemy` — enemy hero ids (OpenDota/Valve ids), comma-separated, in pick order
 * - `ally`  — your team (up to 4; you are the 5th)
 * - `ban`   — banned heroes
 * - `pos`   — 1..5; absent = all positions
 * - `rank`  — herald | crusader | legend | divine; absent = all ranks
 *
 * Parsing is forgiving (a hand-edited or stale link must never break the
 * page): unknown ids, duplicates, junk and anything past the 5th enemy are
 * dropped, an invalid pos/rank falls back to "all".
 */

export const RANK_SLUGS: Record<string, string> = {
  HERALD_GUARDIAN: 'herald',
  CRUSADER_ARCHON: 'crusader',
  LEGEND_ANCIENT: 'legend',
  DIVINE_IMMORTAL: 'divine',
};
const SLUG_TO_RANK = Object.fromEntries(Object.entries(RANK_SLUGS).map(([id, slug]) => [slug, id]));

const LANES = new Set(['1', '2', '3', '4', '5']);

export interface DraftUrlState {
  enemies: number[];
  allies: number[];
  bans: number[];
  position: PositionFilter;
  /** STRATZ bracket id, 'ALL', or null when the URL says nothing about the draft. */
  rank: string | null;
  /** True when the URL carries any draft parameter (a shared link). */
  hasDraft: boolean;
}

function parseIds(raw: string | null, max: number, taken: Set<number>): number[] {
  const out: number[] = [];
  for (const part of (raw ?? '').split(',')) {
    const t = part.trim();
    if (!/^\d{1,4}$/.test(t)) continue;
    const id = Number(t);
    // a hero can be in only one place: enemy, ally or ban (first one wins)
    if (id > 0 && !taken.has(id) && out.length < max) {
      out.push(id);
      taken.add(id);
    }
  }
  return out;
}

export function parseDraftUrl(search: string, maxEnemies = 5, maxAllies = 4, maxBans = 14): DraftUrlState {
  const params = new URLSearchParams(search);
  const taken = new Set<number>();
  const enemies = parseIds(params.get('enemy'), maxEnemies, taken);
  const allies = parseIds(params.get('ally'), maxAllies, taken);
  const bans = parseIds(params.get('ban'), maxBans, taken);
  const pos = params.get('pos') ?? '';
  const position: PositionFilter = LANES.has(pos) ? (pos as PositionFilter) : 'all';
  const rankParam = (params.get('rank') ?? '').toLowerCase();
  const hasDraft = params.has('enemy') || params.has('ally') || params.has('ban') || params.has('pos') || params.has('rank');
  const rank = SLUG_TO_RANK[rankParam] ?? (hasDraft ? 'ALL' : null);
  return { enemies, allies, bans, position, rank, hasDraft };
}

/**
 * Query string for the current draft. Unrelated parameters (e.g. utm_*) are
 * kept; draft parameters are written only when they differ from the default,
 * so an empty draft gives a clean `/`.
 */
export function buildDraftSearch(
  current: string,
  state: { enemies: number[]; allies?: number[]; bans?: number[]; position: PositionFilter; rank: string; lang?: 'en' | 'ru' },
): string {
  const params = new URLSearchParams(current);
  params.delete('enemy');
  params.delete('ally');
  params.delete('ban');
  params.delete('pos');
  params.delete('rank');
  params.delete('lang');
  if (state.enemies.length > 0) params.set('enemy', state.enemies.join(','));
  if (state.allies?.length) params.set('ally', state.allies.join(','));
  if (state.bans?.length) params.set('ban', state.bans.join(','));
  if (state.position !== 'all') params.set('pos', state.position);
  const slug = RANK_SLUGS[state.rank];
  if (slug) params.set('rank', slug);
  // Russian is kept in the link so a shared draft opens in Russian; English is the default.
  if (state.lang === 'ru') params.set('lang', 'ru');
  // URLSearchParams encodes ',' as %2C; keep the ids human-readable in shared links.
  const qs = params.toString().replace(/%2C/gi, ',');
  return qs ? `?${qs}` : '';
}

/** Page title for a draft — what a browser tab, bookmark or history entry shows. */
export function draftTitle(enemyNames: string[], base: string, draftTemplate = 'Counters to {names} — Dota Draft Assistant'): string {
  return enemyNames.length > 0 ? draftTemplate.replace('{names}', enemyNames.join(', ')) : base;
}

/** The link to share: the current URL without someone else's tracking tags. */
export function shareableUrl(href: string): string {
  const url = new URL(href);
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|yclid$)/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString().replace(/%2C/gi, ',');
}
