/**
 * Hero threat profile for the enemy-draft item rules (src/scoring/itemRules.ts).
 *
 * HAND-AUTHORED, a draft to be reviewed by a strong player — the rules are only
 * as good as these tags. One line per hero (internal key without
 * `npc_dota_hero_`):
 *
 *   "<damage> <disables> [flags…]"
 *
 *   damage    m = mostly magical (incl. pure spells), p = mostly physical,
 *             x = mixed
 *   disables  number of hard disables (stun, hex, sleep, root, taunt, fear,
 *             cyclone…) the hero brings, 0–3
 *   flags     inv  goes invisible            heal  strong healing / regen / lifesteal
 *             ill  illusions or clones       sum   summons / controllable units
 *             eva  evasion / miss chance     sil   silence / mute
 *             mob  slippery: blink, escape, high mobility
 *             carry  right-click damage dealer late
 *
 * A hero missing here simply adds nothing to the profile (a just-released hero
 * until it is tagged).
 */
const RAW: Record<string, string> = {
  abaddon: 'm 0 heal',
  abyssal_underlord: 'm 1',
  alchemist: 'p 1 heal carry',
  ancient_apparition: 'm 1',
  antimage: 'p 0 mob carry',
  arc_warden: 'x 0 ill carry',
  axe: 'x 1',
  bane: 'm 2',
  batrider: 'm 1 mob',
  beastmaster: 'p 1 sum',
  bloodseeker: 'x 0 heal sil carry',
  bounty_hunter: 'p 0 inv',
  brewmaster: 'x 1 sum eva',
  bristleback: 'p 0',
  broodmother: 'p 0 sum inv',
  centaur: 'm 1',
  chaos_knight: 'p 1 ill carry',
  chen: 'm 0 sum heal',
  clinkz: 'p 0 inv carry',
  crystal_maiden: 'm 1',
  dark_seer: 'm 1 ill',
  dark_willow: 'm 2',
  dawnbreaker: 'x 1 heal',
  dazzle: 'm 0 heal',
  death_prophet: 'm 0 sil heal',
  disruptor: 'm 1 sil',
  doom_bringer: 'm 1 sil',
  dragon_knight: 'p 1 heal carry',
  drow_ranger: 'p 0 sil carry',
  earth_spirit: 'm 2 sil mob',
  earthshaker: 'm 3',
  elder_titan: 'm 1',
  ember_spirit: 'x 1 mob',
  enchantress: 'x 0 sum heal',
  enigma: 'm 2 sum',
  faceless_void: 'p 1 mob carry',
  furion: 'x 1 sum mob',
  grimstroke: 'm 1 sil',
  gyrocopter: 'p 1 carry',
  hoodwink: 'm 1 eva mob',
  huskar: 'm 0 heal carry',
  invoker: 'm 2 mob',
  jakiro: 'm 1',
  juggernaut: 'p 0 heal carry',
  keeper_of_the_light: 'm 0',
  kez: 'p 1 mob carry',
  kunkka: 'x 2',
  largo: 'm 1 heal',
  legion_commander: 'p 1',
  leshrac: 'm 1',
  lich: 'm 1',
  life_stealer: 'p 0 heal carry',
  lina: 'm 1',
  lion: 'm 2',
  lone_druid: 'p 1 sum carry',
  luna: 'x 1 carry',
  lycan: 'p 0 sum carry',
  magnataur: 'x 2',
  marci: 'p 1 mob',
  mars: 'x 2',
  medusa: 'p 1 carry',
  meepo: 'p 1 ill carry',
  mirana: 'm 1 inv mob',
  monkey_king: 'p 1 carry',
  morphling: 'x 1 mob carry',
  muerta: 'x 1 carry',
  naga_siren: 'p 1 ill carry',
  necrolyte: 'm 1 heal',
  nevermore: 'x 1 carry',
  night_stalker: 'p 0 sil carry',
  nyx_assassin: 'm 1 inv',
  obsidian_destroyer: 'm 1 carry',
  ogre_magi: 'm 1',
  omniknight: 'm 0 heal',
  oracle: 'm 0 heal',
  pangolier: 'x 1 mob',
  phantom_assassin: 'p 0 eva carry',
  phantom_lancer: 'p 0 ill mob carry',
  phoenix: 'm 1 heal',
  primal_beast: 'x 2',
  puck: 'm 2 sil mob',
  pudge: 'm 2',
  pugna: 'm 0 heal',
  queenofpain: 'm 0 mob',
  rattletrap: 'm 1',
  razor: 'x 0 carry',
  riki: 'p 0 inv sil carry',
  ringmaster: 'm 2',
  rubick: 'm 1',
  sand_king: 'm 2 inv',
  shadow_demon: 'm 1 ill',
  shadow_shaman: 'm 2 sum',
  shredder: 'm 0 mob',
  silencer: 'm 0 sil',
  skeleton_king: 'p 1 heal carry',
  skywrath_mage: 'm 0 sil',
  slardar: 'p 1 carry',
  slark: 'p 0 heal mob carry',
  snapfire: 'm 1',
  sniper: 'p 0 carry',
  spectre: 'x 0 ill carry',
  spirit_breaker: 'p 2',
  storm_spirit: 'm 2 mob',
  sven: 'p 1 carry',
  techies: 'm 1',
  templar_assassin: 'p 0 inv carry',
  terrorblade: 'p 0 ill carry',
  tidehunter: 'm 1',
  tinker: 'm 0 mob',
  tiny: 'x 2',
  treant: 'm 2 inv heal',
  troll_warlord: 'p 0 carry',
  tusk: 'm 1',
  undying: 'm 0 sum heal',
  ursa: 'p 0 carry',
  vengefulspirit: 'x 1',
  venomancer: 'm 0 sum',
  viper: 'x 0 carry',
  visage: 'm 1 sum',
  void_spirit: 'm 1 mob',
  warlock: 'm 1 sum heal',
  weaver: 'p 0 inv mob carry',
  windrunner: 'x 1 eva mob',
  winter_wyvern: 'm 2 heal',
  wisp: 'm 0 heal',
  witch_doctor: 'm 1 heal',
  zuus: 'm 0',
};

export type DamageType = 'magic' | 'phys' | 'mixed';
export type TagFlag = 'inv' | 'heal' | 'ill' | 'sum' | 'eva' | 'sil' | 'mob' | 'carry';
export interface HeroTags {
  damage: DamageType;
  disables: number;
  flags: Set<TagFlag>;
}

const FLAGS = new Set<TagFlag>(['inv', 'heal', 'ill', 'sum', 'eva', 'sil', 'mob', 'carry']);
const DAMAGE: Record<string, DamageType> = { m: 'magic', p: 'phys', x: 'mixed' };

export function parseTags(line: string): HeroTags {
  const [d, n, ...rest] = line.trim().split(/\s+/);
  const damage = DAMAGE[d];
  const disables = Number(n);
  if (!damage || !Number.isInteger(disables) || disables < 0 || disables > 3) throw new Error(`bad tags "${line}"`);
  const flags = new Set<TagFlag>();
  for (const f of rest) {
    if (!FLAGS.has(f as TagFlag)) throw new Error(`unknown flag "${f}" in "${line}"`);
    flags.add(f as TagFlag);
  }
  return { damage, disables, flags };
}

export const HERO_TAGS: Record<string, HeroTags> = Object.fromEntries(
  Object.entries(RAW).map(([k, v]) => [k, parseTags(v)]),
);

export function tagsFor(heroKey: string): HeroTags | undefined {
  return HERO_TAGS[heroKey.replace('npc_dota_hero_', '')];
}
