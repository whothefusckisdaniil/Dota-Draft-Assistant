import type { Hero } from '../types';
import type { Build } from '../data/dataset';
import { tagsFor, type HeroTags, type TagFlag } from '../data/heroTags';

/**
 * Enemy-draft item suggestions — RULES, not statistics.
 *
 * The data cannot answer "which item wins against Axe" (ТЗ §36–§38 found no
 * robust item-vs-enemy signal), so the statistical build stays as it is and
 * these rules add a short, explained list on top: "3 hard disables (Lion,
 * Axe, Bane) → BKB". Each rule: a condition on the enemy profile, items per
 * position, and the enemies that triggered it (shown as "vs Lion, Axe").
 */

export interface EnemyProfile {
  count: number;
  /** Share of enemies dealing mostly magic damage (mixed counts half). */
  magicShare: number;
  disables: number;
  /** Heroes per flag. */
  flags: Record<TagFlag, Hero[]>;
  /** Right-click carries dealing physical damage. */
  physCarries: Hero[];
  magicHeroes: Hero[];
  disablers: Hero[];
  /** Enemies with no tags yet (a just-released hero). */
  untagged: Hero[];
}

export function enemyProfile(enemies: Hero[]): EnemyProfile {
  const flags = { inv: [], heal: [], ill: [], sum: [], eva: [], sil: [], mob: [], carry: [] } as Record<TagFlag, Hero[]>;
  let magic = 0;
  let disables = 0;
  const physCarries: Hero[] = [];
  const magicHeroes: Hero[] = [];
  const disablers: Hero[] = [];
  const untagged: Hero[] = [];
  for (const h of enemies) {
    const t: HeroTags | undefined = tagsFor(h.key);
    if (!t) { untagged.push(h); continue; }
    magic += t.damage === 'magic' ? 1 : t.damage === 'mixed' ? 0.5 : 0;
    if (t.damage === 'magic') magicHeroes.push(h);
    disables += t.disables;
    if (t.disables > 0) disablers.push(h);
    for (const f of t.flags) flags[f].push(h);
    if (t.flags.has('carry') && t.damage !== 'magic') physCarries.push(h);
  }
  const tagged = enemies.length - untagged.length;
  return { count: enemies.length, magicShare: tagged ? magic / tagged : 0, disables, flags, physCarries, magicHeroes, disablers, untagged };
}

export type RuleId = 'disables' | 'magic' | 'invis' | 'heal' | 'evasion' | 'physical' | 'illusions' | 'mobile' | 'silence';
type Pos = 1 | 2 | 3 | 4 | 5;

interface Rule {
  id: RuleId;
  /** null = not triggered; otherwise how strongly (≥ 1) and who triggered it. */
  test: (p: EnemyProfile) => { strength: number; heroes: Hero[]; n: number } | null;
  items: { key: string; pos: Pos[]; melee?: boolean; attr?: string[] }[];
}

const CORES: Pos[] = [1, 2, 3];
const SUPPORTS: Pos[] = [4, 5];

export const RULES: Rule[] = [
  {
    id: 'disables',
    test: (p) => (p.disables >= 4 ? { strength: p.disables / 4, heroes: p.disablers, n: p.disables } : null),
    items: [
      { key: 'black_king_bar', pos: CORES },
      { key: 'lotus_orb', pos: [3, 4] },
      { key: 'glimmer_cape', pos: SUPPORTS },
      { key: 'aeon_disk', pos: [1, 2] },
    ],
  },
  {
    id: 'magic',
    test: (p) => (p.count >= 2 && p.magicShare >= 0.6 ? { strength: p.magicShare / 0.6, heroes: p.magicHeroes, n: Math.round(p.magicShare * 100) } : null),
    items: [
      { key: 'black_king_bar', pos: CORES },
      { key: 'pipe', pos: [3, 4] },
      { key: 'mage_slayer', pos: [1, 2] },
      { key: 'glimmer_cape', pos: SUPPORTS },
    ],
  },
  {
    id: 'invis',
    test: (p) => (p.flags.inv.length ? { strength: 1 + 0.5 * (p.flags.inv.length - 1), heroes: p.flags.inv, n: p.flags.inv.length } : null),
    items: [
      { key: 'dust', pos: [3, 4, 5] },
      { key: 'ward_sentry', pos: SUPPORTS },
      { key: 'gem', pos: [3, 4, 5] },
    ],
  },
  {
    id: 'heal',
    test: (p) => (p.flags.heal.length >= 2 ? { strength: p.flags.heal.length / 2, heroes: p.flags.heal, n: p.flags.heal.length } : null),
    items: [
      { key: 'spirit_vessel', pos: [3, 4, 5] },
      { key: 'skadi', pos: [1, 2] },
      { key: 'shivas_guard', pos: [2, 3] },
    ],
  },
  {
    id: 'evasion',
    test: (p) => (p.flags.eva.length ? { strength: 1, heroes: p.flags.eva, n: p.flags.eva.length } : null),
    items: [
      { key: 'monkey_king_bar', pos: [1, 2] },
      { key: 'bloodthorn', pos: [1, 2] },
    ],
  },
  {
    id: 'physical',
    test: (p) => (p.physCarries.length >= 2 ? { strength: p.physCarries.length / 2, heroes: p.physCarries, n: p.physCarries.length } : null),
    items: [
      { key: 'ghost', pos: SUPPORTS },
      { key: 'force_staff', pos: SUPPORTS },
      { key: 'crimson_guard', pos: [3] },
      { key: 'heavens_halberd', pos: [3] },
      { key: 'blade_mail', pos: [2, 3] },
      { key: 'shivas_guard', pos: [2, 3] },
    ],
  },
  {
    id: 'illusions',
    test: (p) => {
      const heroes = [...new Set([...p.flags.ill, ...p.flags.sum])];
      return heroes.length >= 2 ? { strength: heroes.length / 2, heroes, n: heroes.length } : null;
    },
    items: [
      { key: 'mjollnir', pos: [1, 2] },
      { key: 'bfury', pos: [1], melee: true },
      { key: 'shivas_guard', pos: [2, 3] },
      { key: 'crimson_guard', pos: [3] },
    ],
  },
  {
    id: 'mobile',
    test: (p) => (p.flags.mob.length >= 2 ? { strength: p.flags.mob.length / 2, heroes: p.flags.mob, n: p.flags.mob.length } : null),
    items: [
      { key: 'orchid', pos: [1, 2] },
      { key: 'abyssal_blade', pos: [1], melee: true },
      { key: 'rod_of_atos', pos: [2, 4, 5] },
      { key: 'gungir', pos: [1, 2] },
      { key: 'sheepstick', pos: [2, 4, 5] },
    ],
  },
  {
    id: 'silence',
    test: (p) => (p.flags.sil.length >= 2 ? { strength: p.flags.sil.length / 2, heroes: p.flags.sil, n: p.flags.sil.length } : null),
    items: [
      { key: 'manta', pos: [1, 2], attr: ['agi', 'all'] },
      { key: 'lotus_orb', pos: [3, 4] },
      { key: 'cyclone', pos: [2, 4, 5] },
    ],
  },
];

/** English names for rule items (item keys = Valve/OpenDota keys, also the image names). */
export const RULE_ITEM_NAMES: Record<string, string> = {
  black_king_bar: 'Black King Bar', lotus_orb: 'Lotus Orb', glimmer_cape: 'Glimmer Cape', aeon_disk: 'Aeon Disk',
  pipe: 'Pipe of Insight', mage_slayer: 'Mage Slayer', dust: 'Dust of Appearance',
  ward_sentry: 'Sentry Ward', gem: 'Gem of True Sight', spirit_vessel: 'Spirit Vessel', skadi: 'Eye of Skadi',
  shivas_guard: "Shiva's Guard", monkey_king_bar: 'Monkey King Bar', bloodthorn: 'Bloodthorn', ghost: 'Ghost Scepter',
  force_staff: 'Force Staff', crimson_guard: 'Crimson Guard', heavens_halberd: "Heaven's Halberd", blade_mail: 'Blade Mail',
  mjollnir: 'Mjollnir', bfury: 'Battle Fury', orchid: 'Orchid Malevolence', abyssal_blade: 'Abyssal Blade',
  rod_of_atos: 'Rod of Atos', gungir: 'Gleipnir', sheepstick: 'Scythe of Vyse', manta: 'Manta Style',
  cyclone: "Eul's Scepter of Divinity",
};

export interface ItemSuggestion {
  key: string;
  name: string;
  score: number;
  /** Share of games this hero/position buys it in the statistical build (0 when it does not appear). */
  buildPct: number;
  reasons: { rule: RuleId; heroes: Hero[]; n: number }[];
}

export const MAX_SUGGESTIONS = 4;

/** Consumables never show up in the builds (they are filtered out there), so
 *  they cannot be checked against them; they are always purchasable. */
const ALWAYS_AVAILABLE = new Set(['dust', 'gem', 'ward_sentry']);

/**
 * Suggestions for your hero at a position against the enemies, from the items
 * this hero actually buys there (consumables excepted). Items it already buys
 * in ≥ 60% of games (the core) are not repeated; the more often it buys an
 * item, the higher it ranks. One item collects every rule that asks for it.
 */
export function suggestItems({ hero, position, enemies, build, itemKeyOf, available }: {
  hero: Hero;
  /** Item keys bought by any hero this patch (the builds index). An item no one
   *  buys is not suggested — it may have been removed from the game. */
  available?: Set<string>;
  position: Pos;
  enemies: Hero[];
  build: Build | null;
  /** itemId → item key, to match the statistical build. */
  itemKeyOf: (id: number) => string | undefined;
}): ItemSuggestion[] {
  if (!enemies.length) return [];
  const profile = enemyProfile(enemies);
  const buildPct = new Map<string, number>();
  for (const [id, p] of [...(build?.items ?? []), ...(build?.boots ?? [])]) {
    const k = itemKeyOf(id);
    if (k) buildPct.set(k, Math.max(buildPct.get(k) ?? 0, p));
  }
  const melee = hero.attackType === 'Melee';
  const byKey = new Map<string, ItemSuggestion>();
  for (const rule of RULES) {
    const hit = rule.test(profile);
    if (!hit) continue;
    for (const it of rule.items) {
      if (!it.pos.includes(position)) continue;
      if (it.melee && !melee) continue;
      if (it.attr && !it.attr.includes(hero.primaryAttr)) continue;
      if (available && !available.has(it.key) && !ALWAYS_AVAILABLE.has(it.key)) continue;
      const pct = buildPct.get(it.key) ?? 0;
      if (pct >= 0.6) continue; // already core for this hero: nothing to add
      // Only items this hero really buys at this position (the build lists
      // items bought in >= 5% of games): a top item nobody builds on this hero
      // (BKB on Juggernaut, who has Blade Fury) is not recommended at all.
      if (build && pct === 0 && !ALWAYS_AVAILABLE.has(it.key)) continue;
      const s = byKey.get(it.key) ?? { key: it.key, name: RULE_ITEM_NAMES[it.key] ?? it.key, score: 0, buildPct: pct, reasons: [] };
      // stronger trigger → higher; items this hero buys more often fit better
      s.score += hit.strength * (1 + Math.min(pct, 0.5) * 2);
      s.reasons.push({ rule: rule.id, heroes: hit.heroes, n: hit.n });
      byKey.set(it.key, s);
    }
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, MAX_SUGGESTIONS);
}
