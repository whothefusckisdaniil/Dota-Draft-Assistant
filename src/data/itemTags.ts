/**
 * What an item does for the team — for "your team lacks damage → more damage
 * items" in the ideal build (src/scoring/teamNeeds.ts).
 *
 * HAND-AUTHORED, like heroTags.ts. Only items whose role is clear are tagged;
 * an untagged item (e.g. a new one) is simply never boosted.
 *   damage   kills things: right-click / spell damage
 *   control  disables, slows, silences, catches
 *   save     keeps allies alive or helps the whole team (saves, heals, auras)
 */
export type ItemRole = 'damage' | 'control' | 'save';

const TAGS: Record<ItemRole, string[]> = {
  damage: [
    'armlet', 'bfury', 'bloodthorn', 'butterfly', 'greater_crit', 'lesser_crit', 'desolator', 'devastator',
    'diffusal_blade', 'dragon_lance', 'echo_sabre', 'ethereal_blade', 'falcon_blade', 'kaya_and_sange',
    'maelstrom', 'mjollnir', 'manta', 'mask_of_madness', 'monkey_king_bar', 'radiance', 'rapier',
    'revenants_brooch', 'sange_and_yasha', 'satanic', 'silver_edge', 'skadi', 'yasha', 'yasha_and_kaya',
    'witch_blade', 'dagon', 'dagon_2', 'dagon_3', 'dagon_4', 'dagon_5', 'phylactery', 'hydras_breath',
    'disperser', 'invis_sword', 'orb_of_corrosion', 'blight_stone', 'hand_of_midas',
  ],
  control: [
    'abyssal_blade', 'basher', 'sheepstick', 'gungir', 'rod_of_atos', 'orchid', 'bloodthorn', 'meteor_hammer',
    'nullifier', 'harpoon', 'cyclone', 'shivas_guard', 'veil_of_discord',
  ],
  save: [
    'glimmer_cape', 'force_staff', 'lotus_orb', 'solar_crest', 'holy_locket', 'mekansm', 'guardian_greaves',
    'pipe', 'crimson_guard', 'boots_of_bearing', 'vladmir', 'wind_waker', 'pavise', 'ancient_janggo',
    'assault', 'spirit_vessel', 'urn_of_shadows', 'arcane_boots', 'tranquil_boots',
  ],
};

export const ITEM_ROLES: Map<string, Set<ItemRole>> = (() => {
  const m = new Map<string, Set<ItemRole>>();
  for (const [role, keys] of Object.entries(TAGS) as [ItemRole, string[]][]) {
    for (const k of keys) {
      if (!m.has(k)) m.set(k, new Set());
      m.get(k)!.add(role);
    }
  }
  return m;
})();

export const itemHasRole = (key: string, role: ItemRole) => ITEM_ROLES.get(key)?.has(role) ?? false;
