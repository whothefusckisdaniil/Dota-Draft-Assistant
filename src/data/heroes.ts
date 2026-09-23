import type { Hero, HeroStatsEntry, OpenDotaHero } from '../types';
import { APP_CONFIG } from '../config';
import { RU_NAMES } from './ruNames';

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
        nameRu: RU_NAMES[h.localized_name] ?? '',
      } satisfies Hero;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function norm(s: string): string {
  return s.toLowerCase().trim();
}

/** EN + RU + partial match search. */
export function searchHeroes(heroes: Hero[], query: string, limit: number = APP_CONFIG.ui.searchLimit): Hero[] {
  const q = norm(query);
  if (!q) return [];
  const starts: Hero[] = [];
  const contains: Hero[] = [];
  for (const h of heroes) {
    const en = norm(h.name);
    const ru = norm(h.nameRu);
    const key = norm(h.key.replace('npc_dota_hero_', '').replace(/_/g, ' '));
    const fields = [en, ru, key];
    if (fields.some((f) => f.startsWith(q))) starts.push(h);
    else if (fields.some((f) => f.includes(q))) contains.push(h);
    if (starts.length + contains.length >= limit * 3) break;
  }
  return [...starts, ...contains].slice(0, limit);
}
