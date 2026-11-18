import type { Hero } from '../types';
import { tagsFor } from '../data/heroTags';
import type { ItemRole } from '../data/itemTags';

/**
 * What your team lacks, from your allies' traits (heroTags.ts) and your
 * position — RULES, like the enemy-draft rules. Absence needs at least two
 * allies (one hero says little about a team).
 *   damage  no right-click carry among the allies and you play 2–3
 *           (on 1 you ARE the carry: nothing is missing)
 *   control allies bring at most one hard disable in total
 *   save    you play 3–5 and no ally heals / saves, or the allies already
 *           have two carries (damage is covered — keep them alive)
 */
export type NeedId = 'damage' | 'control' | 'save' | 'enoughDamage';

export interface TeamNeed {
  id: NeedId;
  role: ItemRole;
  /** Allies the rule is about (the carries for "enoughDamage"). */
  heroes: Hero[];
}

export function teamNeeds(allies: Hero[], myPos: 1 | 2 | 3 | 4 | 5): TeamNeed[] {
  const tagged = allies.map((h) => ({ h, t: tagsFor(h.key) })).filter((x) => x.t);
  if (tagged.length < 2) return [];
  const carries = tagged.filter((x) => x.t!.flags.has('carry')).map((x) => x.h);
  const disables = tagged.reduce((s, x) => s + x.t!.disables, 0);
  const healers = tagged.filter((x) => x.t!.flags.has('heal'));
  const out: TeamNeed[] = [];
  if (carries.length === 0 && (myPos === 2 || myPos === 3)) out.push({ id: 'damage', role: 'damage', heroes: tagged.map((x) => x.h) });
  if (disables <= 1) out.push({ id: 'control', role: 'control', heroes: tagged.map((x) => x.h) });
  if (myPos >= 3 && carries.length >= 2) out.push({ id: 'enoughDamage', role: 'save', heroes: carries });
  else if (myPos >= 3 && healers.length === 0) out.push({ id: 'save', role: 'save', heroes: tagged.map((x) => x.h) });
  return out;
}
