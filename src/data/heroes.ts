import type { Hero, HeroStatsEntry, OpenDotaHero } from '../types';
import { APP_CONFIG } from '../config';
import { HERO_NAMES_RU } from '../i18n/heroNamesRu';

/** Russian name + slang for a hero key (`npc_dota_hero_*` or bare). */
export function ruNamesFor(key: string): { ru: string; aliases: string[] } {
  return HERO_NAMES_RU[key.replace('npc_dota_hero_', '')] ?? { ru: '', aliases: [] };
}

export function mergeHeroes(list: OpenDotaHero[], stats: HeroStatsEntry[]): Hero[] {
  const statsById = new Map(stats.map((s) => [s.id, s]));
  return list
    .map((h) => {
      const s = statsById.get(h.id);
      const img = s?.img ?? '';
      const icon = s?.icon ?? '';
      return {
        id: h.id,
        key: h.name,
        name: h.localized_name,
        primaryAttr: h.primary_attr,
        attackType: h.attack_type,
        roles: h.roles ?? [],
        img: img ? `${APP_CONFIG.cdnBase}${img}`.replace(/\?$/, '') : '',
        icon: icon ? `${APP_CONFIG.cdnBase}${icon}`.replace(/\?$/, '') : '',
        proPick: s?.pro_pick ?? 0,
        proWin: s?.pro_win ?? 0,
        pubPick: s?.pub_pick ?? 0,
        pubWin: s?.pub_win ?? 0,
        nameRu: ruNamesFor(h.name).ru,
      } satisfies Hero;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Normalise for search: case, ё→е, and drop punctuation/spaces differences. */
function normSearch(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/['’`]/g, '').replace(/[\s.-]+/g, ' ').trim();
}

/** EN + full RU name + RU slang/abbreviations, prefix before substring matches. */
export function searchHeroes(heroes: Hero[], query: string, limit: number = APP_CONFIG.ui.searchLimit): Hero[] {
  const q = normSearch(query);
  if (!q) return [];
  const exact: Hero[] = [];
  const starts: Hero[] = [];
  const contains: Hero[] = [];
  for (const h of heroes) {
    const ruNames = ruNamesFor(h.key);
    const fields = [
      h.name,
      h.nameRu || ruNames.ru,
      h.key.replace('npc_dota_hero_', '').replace(/_/g, ' '),
      ...ruNames.aliases,
    ].map(normSearch).filter(Boolean);
    // Exact alias/abbreviation hits ("сф", "вд", "ам") go first.
    if (fields.some((f) => f === q)) exact.push(h);
    else if (fields.some((f) => f.startsWith(q))) starts.push(h);
    else if (fields.some((f) => f.includes(q))) contains.push(h);
  }
  return [...exact, ...starts, ...contains].slice(0, limit);
}
