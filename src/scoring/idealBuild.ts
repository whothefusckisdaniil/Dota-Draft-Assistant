import type { Build } from '../data/dataset';
import type { ItemSuggestion } from './itemRules';
import type { TeamNeed } from './teamNeeds';
import { itemHasRole } from '../data/itemTags';

/**
 * "Ideal build" for your hero: boots + 6 slots in buying order.
 *
 *  1. Core — what this hero buys in ≥ 35% of games at this position/rank.
 *  2. Draft — up to 2 items for the enemy draft, only from what this hero
 *     buys (itemRules already filters that), with the reason.
 *  3. Team — up to 2 of the remaining slots for what your team lacks
 *     (teamNeeds.ts: damage / control / saves), from what this hero buys.
 *  4. Situational — the hero's next most popular items fill the rest, the
 *     ones the team needs first.
 *
 * Components most players complete are replaced by the finished item (Yasha
 * → Manta, Perseverance → Battle Fury, Crystalys → Daedalus): a component
 * leaves the list when its upgrade is bought in at least half as many games.
 * Aghanim's Shard / Blessing and boots do not take a slot; the shard is
 * reported separately (shown after the slots as "no slot"). Order = typical purchase minute.
 */
export type SlotKind = 'core' | 'draft' | 'team' | 'situational';

export interface IdealSlot {
  id: number;
  key: string;
  pct: number;
  minute: number;
  kind: SlotKind;
  suggestion?: ItemSuggestion;
  /** For kind 'team': the team need it answers. */
  need?: TeamNeed;
}

export interface IdealBuild {
  boots: { id: number; pct: number; minute: number } | null;
  slots: IdealSlot[];
  shard: { id: number; pct: number; minute: number } | null;
}

export const IDEAL = { slots: 6, corePct: 0.35, laningMinute: 12, draftSlots: 2, teamSlots: 2, teamMinPct: 0.05, upgradeRatio: 0.5, shardMinPct: 0.1 } as const;

const NO_SLOT = new Set(['aghanims_shard', 'ultimate_scepter_2']);

export function idealBuild(
  build: Build,
  /** itemId → [key, name, components?] (builds index). */
  itemOf: (id: number) => [string, string, string[]?] | undefined,
  suggestions: ItemSuggestion[] = [],
  /** What your team lacks (teamNeeds.ts): up to 2 slots go to items for it. */
  needs: TeamNeed[] = [],
): IdealBuild {
  const key = (id: number) => itemOf(id)?.[0] ?? '';
  const later = build.items.filter((x) => x[2] >= IDEAL.laningMinute && !NO_SLOT.has(key(x[0])));
  const pctByKey = new Map(later.map((x) => [key(x[0]), x[1]]));

  // drop a component when its upgrade is bought by at least half as many
  const isCompleted = (k: string, pct: number) => later.some((y) => {
    const comps = itemOf(y[0])?.[2] ?? [];
    return comps.includes(k) && y[1] >= pct * IDEAL.upgradeRatio;
  });
  const pool = later.filter((x) => !isCompleted(key(x[0]), x[1]));

  const chosen = new Map<number, IdealSlot>();
  const add = (x: (typeof pool)[number], kind: SlotKind, suggestion?: ItemSuggestion, need?: TeamNeed) => {
    if (chosen.size >= IDEAL.slots || chosen.has(x[0])) return;
    chosen.set(x[0], { id: x[0], key: key(x[0]), pct: x[1], minute: x[2], kind, suggestion, need });
  };
  const needOf = (x: (typeof pool)[number]) => needs.find((n) => itemHasRole(key(x[0]), n.role));

  const byPct = [...pool].sort((a, b) => b[1] - a[1]);
  const core = byPct.filter((x) => x[1] >= IDEAL.corePct);
  // keep room for the draft picks
  const draft = suggestions
    .map((s) => ({ s, x: pool.find((p) => key(p[0]) === s.key) }))
    .filter((d): d is { s: ItemSuggestion; x: (typeof pool)[number] } => !!d.x)
    .slice(0, IDEAL.draftSlots);
  core.slice(0, IDEAL.slots - draft.length).forEach((x) => add(x, 'core'));
  draft.forEach(({ s, x }) => add(x, 'draft', s));
  // Team slots: the slots left after core and draft (core is never displaced)
  // go first to items this hero buys (≥ 5%) that answer what the team lacks.
  byPct
    .filter((x) => x[1] < IDEAL.corePct && x[1] >= IDEAL.teamMinPct && needOf(x))
    .slice(0, IDEAL.teamSlots)
    .forEach((x) => add(x, 'team', undefined, needOf(x)));
  // the rest: popular items, the ones the team needs first
  [...byPct].sort((a, b) => (needOf(b) ? 1.5 : 1) * b[1] - (needOf(a) ? 1.5 : 1) * a[1]).forEach((x) => add(x, 'situational'));

  const upgraded = build.boots.filter(([id]) => key(id) !== 'boots');
  const b = (upgraded.length ? upgraded : build.boots)[0];
  const shardRow = build.items.find((x) => key(x[0]) === 'aghanims_shard');

  return {
    boots: b ? { id: b[0], pct: b[1], minute: b[2] } : null,
    slots: [...chosen.values()].sort((a, b) => a.minute - b.minute),
    // Purchases only: a shard from a Tormentor is free and invisible here, so
    // the real share is higher — a low bar, and the UI says so.
    shard: shardRow && shardRow[1] >= IDEAL.shardMinPct ? { id: shardRow[0], pct: shardRow[1], minute: shardRow[2] } : null,
  };
}
