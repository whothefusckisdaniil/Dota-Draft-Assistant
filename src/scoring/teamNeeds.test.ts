import { describe, expect, it } from 'vitest';
import heroesRaw from '../../public/data/heroes.json';
import type { Hero } from '../types';
import type { Build } from '../data/dataset';
import { teamNeeds } from './teamNeeds';
import { idealBuild } from './idealBuild';
import { ITEM_ROLES } from '../data/itemTags';

const heroes = heroesRaw as unknown as Hero[];
const team = (...keys: string[]) => keys.map((k) => heroes.find((h) => h.key === `npc_dota_hero_${k}`)!);

describe('team needs from your allies', () => {
  it('a carry with only supports around needs damage', () => {
    const n = teamNeeds(team('undying', 'shadow_shaman'), 1).map((x) => x.id);
    expect(n).toContain('damage');
    expect(n).not.toContain('control'); // Shadow Shaman alone brings 2 disables
  });

  it('a support next to two carries keeps them alive', () => {
    const n = teamNeeds(team('juggernaut', 'phantom_assassin', 'lion'), 5);
    expect(n.find((x) => x.id === 'enoughDamage')?.heroes.map((h) => h.name)).toEqual(['Juggernaut', 'Phantom Assassin']);
    expect(n.map((x) => x.id)).not.toContain('damage');
  });

  it('little control and no heals', () => {
    const n = teamNeeds(team('antimage', 'sniper'), 4).map((x) => x.id);
    expect(n).toEqual(expect.arrayContaining(['control', 'enoughDamage']));
  });

  it('needs two allies to judge a team', () => {
    expect(teamNeeds(team('undying'), 1)).toEqual([]);
  });

  it('item roles are known keys', () => {
    for (const k of ITEM_ROLES.keys()) expect(k).toMatch(/^[a-z0-9_]+$/);
  });
});

describe('ideal build with team needs', () => {
  const ITEMS: Record<number, [string, string]> = {
    63: ['power_treads', 'Power Treads'], 145: ['bfury', 'Battle Fury'], 147: ['manta', 'Manta Style'],
    1: ['blink', 'Blink Dagger'], 139: ['butterfly', 'Butterfly'], 116: ['black_king_bar', 'Black King Bar'],
    141: ['greater_crit', 'Daedalus'], 102: ['force_staff', 'Force Staff'], 208: ['abyssal_blade', 'Abyssal Blade'],
    254: ['glimmer_cape', 'Glimmer Cape'], 156: ['satanic', 'Satanic'],
  };
  const itemOf = (id: number) => ITEMS[id];
  const build = {
    m: 1000, low: false, start: [], talents: [], skills: [], boots: [[63, 0.9, 9]],
    items: [[145, 0.9, 15, 50], [147, 0.8, 22, 50], [1, 0.6, 25, 50], [139, 0.5, 30, 50], [116, 0.4, 28, 50],
      [102, 0.25, 26, 50], [254, 0.2, 24, 50], [141, 0.12, 34, 52], [156, 0.1, 36, 52], [208, 0.08, 35, 52]],
  } as unknown as Build;

  it('without needs: the next most popular item (Force Staff) fills the slot', () => {
    expect(idealBuild(build, itemOf).slots.map((s) => s.key)).toContain('force_staff');
  });

  it('a team without damage turns the flexible slots into damage items', () => {
    const needs = teamNeeds(team('undying', 'shadow_shaman'), 1);
    const ib = idealBuild(build, itemOf, [], needs);
    const teamSlots = ib.slots.filter((s) => s.kind === 'team').map((s) => s.key);
    // core (5 items ≥ 35%, BKB included) is never displaced: one slot is left
    expect(ib.slots.filter((s) => s.kind === 'core').map((s) => s.key)).toEqual(['bfury', 'manta', 'blink', 'black_king_bar', 'butterfly']);
    expect(teamSlots).toEqual(['greater_crit']);
    expect(ib.slots.map((s) => s.key)).not.toContain('force_staff');
  });
});
