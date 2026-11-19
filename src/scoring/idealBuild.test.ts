import { describe, expect, it } from 'vitest';
import type { Build } from '../data/dataset';
import { idealBuild } from './idealBuild';
import type { ItemSuggestion } from './itemRules';

const ITEMS: Record<number, [string, string, string[]?]> = {
  29: ['boots', 'Boots of Speed'], 63: ['power_treads', 'Power Treads'],
  36: ['magic_wand', 'Magic Wand'],
  145: ['bfury', 'Battle Fury', ['pers', 'broadsword']], 69: ['pers', 'Perseverance'],
  170: ['yasha', 'Yasha'], 147: ['manta', 'Manta Style', ['yasha', 'diadem']],
  1: ['blink', 'Blink Dagger'], 139: ['butterfly', 'Butterfly'], 108: ['ultimate_scepter', "Aghanim's Scepter"],
  609: ['aghanims_shard', "Aghanim's Shard"], 135: ['monkey_king_bar', 'Monkey King Bar'], 143: ['basher', 'Skull Basher'],
  160: ['skadi', 'Eye of Skadi'], 158: ['mjollnir', 'Mjollnir', ['maelstrom', 'hyperstone']], 166: ['maelstrom', 'Maelstrom'],
};
const itemOf = (id: number) => ITEMS[id];

/** Anti-Mage-like build. */
const BUILD = {
  m: 10000, low: false, start: [], talents: [], skills: [],
  boots: [[63, 0.9, 9], [29, 0.3, 4]],
  items: [
    [36, 0.65, 3, 50], [69, 0.99, 11, 50], [145, 0.99, 15, 51], [170, 0.98, 18, 52], [147, 0.96, 22, 53],
    [1, 0.7, 25, 54], [139, 0.58, 30, 55], [108, 0.4, 33, 53], [609, 0.5, 28, 52], [143, 0.3, 31, 54],
    [135, 0.12, 35, 56], [160, 0.2, 33, 55], [166, 0.45, 14, 50], [158, 0.1, 28, 52],
  ],
} as unknown as Build;

describe('ideal build', () => {
  it('reports the shard from 10% of purchases (Tormentor shards are not purchases)', () => {
    const low = { ...BUILD, items: BUILD.items.map((x) => (x[0] === 609 ? [609, 0.13, 25, 52] : x)) } as unknown as Build;
    expect(idealBuild(low, itemOf).shard).toEqual({ id: 609, pct: 0.13, minute: 25 });
    const rare = { ...BUILD, items: BUILD.items.map((x) => (x[0] === 609 ? [609, 0.06, 25, 52] : x)) } as unknown as Build;
    expect(idealBuild(rare, itemOf).shard).toBeNull();
  });

  it('six slots in buying order, completed components replaced, shard and boots aside', () => {
    const ib = idealBuild(BUILD, itemOf);
    expect(ib.boots).toEqual({ id: 63, pct: 0.9, minute: 9 });
    expect(ib.shard?.id).toBe(609);
    const keys = ib.slots.map((s) => s.key);
    expect(keys).toHaveLength(6);
    expect(keys).not.toContain('yasha'); // → Manta
    expect(keys).not.toContain('pers'); // → Battle Fury (laning-minute items are not slots anyway)
    expect(keys).not.toContain('magic_wand');
    expect(keys).toContain('maelstrom'); // Mjollnir is rare: Maelstrom stays
    expect(keys).toEqual(['maelstrom', 'bfury', 'manta', 'blink', 'butterfly', 'ultimate_scepter']);
    expect(ib.slots.map((s) => s.minute)).toEqual([...ib.slots.map((s) => s.minute)].sort((a, b) => a - b));
  });

  it('puts draft items the hero buys into the slots with their reason', () => {
    const mkb = { key: 'monkey_king_bar', name: 'Monkey King Bar', score: 2, buildPct: 0.12, reasons: [] } as ItemSuggestion;
    const bkb = { key: 'black_king_bar', name: 'Black King Bar', score: 3, buildPct: 0, reasons: [] } as ItemSuggestion;
    const ib = idealBuild(BUILD, itemOf, [bkb, mkb]);
    const slot = ib.slots.find((s) => s.key === 'monkey_king_bar');
    expect(slot?.kind).toBe('draft');
    expect(slot?.suggestion).toBe(mkb);
    expect(ib.slots.map((s) => s.key)).not.toContain('black_king_bar'); // not in this hero's build
    expect(ib.slots).toHaveLength(6);
  });
});

describe('alternative upgrades of one intermediate item', () => {
  const ITEMS2: Record<number, [string, string, string[]?]> = {
    236: ['dragon_lance', 'Dragon Lance', ['blade_of_alacrity', 'belt_of_strength']],
    102: ['force_staff', 'Force Staff', ['staff_of_wizardry', 'fluffy_hat']],
    263: ['hurricane_pike', 'Hurricane Pike', ['force_staff', 'dragon_lance']],
    1806: ['hydras_breath', "Hydra's Breath", ['specialists_array', 'dragon_lance', 'orb_of_venom']],
    1800: ['specialists_array', "Specialist's Array", ['blade_of_alacrity', 'broadsword']],
    166: ['maelstrom', 'Maelstrom'], 158: ['mjollnir', 'Mjollnir', ['maelstrom', 'hyperstone']],
  };
  const SNIPER = {
    m: 1000, low: false, start: [], talents: [], skills: [], boots: [],
    items: [[166, 0.69, 15, 50], [236, 0.88, 17, 50], [102, 0.46, 24, 50], [263, 0.45, 25, 50], [158, 0.49, 26, 50],
      [1800, 0.31, 26, 50], [1806, 0.29, 28, 50]],
  } as unknown as Build;

  it("keeps one of Hurricane Pike / Hydra's Breath (both need Dragon Lance)", () => {
    const keys = idealBuild(SNIPER, (id) => ITEMS2[id]).slots.map((s) => s.key);
    expect(keys).toContain('hurricane_pike');
    expect(keys).not.toContain('hydras_breath');
    expect(keys).not.toContain('dragon_lance'); // completed into the Pike
    expect(keys).toContain('specialists_array'); // no longer a Hydra component here
  });
});

describe('farming items are alternatives', () => {
  const ITEMS3: Record<number, [string, string, string[]?]> = {
    166: ['maelstrom', 'Maelstrom'], 158: ['mjollnir', 'Mjollnir', ['maelstrom', 'hyperstone']],
    137: ['radiance', 'Radiance'], 116: ['black_king_bar', 'Black King Bar'], 145: ['basher', 'Skull Basher'],
    127: ['blade_mail', 'Blade Mail'], 154: ['sange_and_yasha', 'Sange and Yasha'], 208: ['abyssal_blade', 'Abyssal Blade', ['basher']],
    108: ['ultimate_scepter', "Aghanim's Scepter"],
  };
  // Bloodseeker mid, Crusader–Archon, patch 7.42
  const BS = {
    m: 1586, low: false, start: [], talents: [], skills: [], boots: [],
    items: [[127, 0.396, 15, 50], [166, 0.479, 16, 50], [137, 0.233, 19, 50], [158, 0.296, 26, 50], [154, 0.197, 27, 50],
      [116, 0.624, 28, 50], [145, 0.411, 31, 50], [108, 0.153, 34, 50], [208, 0.185, 39, 50]],
  } as unknown as Build;

  it('Bloodseeker: Mjollnir or Radiance, not both', () => {
    const keys = idealBuild(BS, (id) => ITEMS3[id]).slots.map((s) => s.key);
    expect(keys).toContain('mjollnir');
    expect(keys).not.toContain('radiance');
    // Skull Basher stays (Abyssal is rare): Abyssal is not a second slot
    expect(keys).toContain('basher');
    expect(keys).not.toContain('abyssal_blade');
    expect(keys).toHaveLength(6);
  });

  it('two core farming items both stay', () => {
    const both = { ...BS, items: BS.items.map((x) => (x[0] === 137 ? [137, 0.4, 19, 50] : x[0] === 158 ? [158, 0.36, 26, 50] : x)) } as unknown as Build;
    const keys = idealBuild(both, (id) => ITEMS3[id]).slots.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(['radiance', 'mjollnir']));
  });
});
