import { describe, expect, it } from 'vitest';
import heroesRaw from '../../public/data/heroes.json';
import type { Hero } from '../types';
import { HERO_TAGS, parseTags } from '../data/heroTags';
import { enemyProfile, suggestItems } from './itemRules';
import type { Build } from '../data/dataset';

const heroes = heroesRaw as unknown as Hero[];
const byKey = (k: string) => heroes.find((h) => h.key === `npc_dota_hero_${k}`)!;
const team = (...keys: string[]) => keys.map(byKey);

describe('hero tags', () => {
  it('tag every hero in the snapshot (a just-released hero may lag)', () => {
    const missing = heroes.filter((h) => !HERO_TAGS[h.key.replace('npc_dota_hero_', '')]);
    expect(missing.map((h) => h.name).length, missing.map((h) => h.name).join(', ')).toBeLessThanOrEqual(3);
    const keys = new Set(heroes.map((h) => h.key.replace('npc_dota_hero_', '')));
    for (const k of Object.keys(HERO_TAGS)) expect(keys.has(k), `stale tag ${k}`).toBe(true);
  });

  it('rejects malformed lines', () => {
    expect(() => parseTags('q 1')).toThrow();
    expect(() => parseTags('m 5')).toThrow();
    expect(() => parseTags('m 1 flying')).toThrow();
    expect(parseTags('x 2 inv heal').flags.has('inv')).toBe(true);
  });
});

describe('enemy-draft item rules', () => {
  it('profiles the enemy team', () => {
    const p = enemyProfile(team('lion', 'bane', 'earthshaker', 'riki', 'phantom_assassin'));
    expect(p.disables).toBe(7);
    expect(p.flags.inv.map((h) => h.name)).toEqual(['Riki']);
    expect(p.physCarries.map((h) => h.name)).toEqual(['Riki', 'Phantom Assassin']);
  });

  it('suggests BKB to a core against a chain of disables, with who caused it', () => {
    const s = suggestItems({ hero: byKey('juggernaut'), position: 1, enemies: team('lion', 'bane', 'earthshaker'), build: null, itemKeyOf: () => undefined });
    expect(s[0].key).toBe('black_king_bar');
    const r = s[0].reasons.find((x) => x.rule === 'disables')!;
    expect(r.n).toBe(7);
    expect(r.heroes.map((h) => h.name)).toEqual(['Lion', 'Bane', 'Earthshaker']);
  });

  it('gives supports support items and detection against invisible heroes', () => {
    const s = suggestItems({ hero: byKey('lion'), position: 5, enemies: team('riki', 'clinkz', 'lion'), build: null, itemKeyOf: () => undefined });
    const keys = s.map((x) => x.key);
    expect(keys).toContain('dust');
    expect(keys).toContain('ward_sentry');
    expect(keys).not.toContain('black_king_bar');
  });

  it('respects attack type and attribute limits', () => {
    const illusions = team('phantom_lancer', 'naga_siren', 'terrorblade');
    const ranged = suggestItems({ hero: byKey('drow_ranger'), position: 1, enemies: illusions, build: null, itemKeyOf: () => undefined });
    expect(ranged.map((x) => x.key)).not.toContain('bfury');
    const melee = suggestItems({ hero: byKey('antimage'), position: 1, enemies: illusions, build: null, itemKeyOf: () => undefined });
    expect(melee.map((x) => x.key)).toContain('bfury');
  });

  it('does not repeat an item the hero already builds as core, ranks its own items higher', () => {
    const build = { items: [[116, 0.8, 20, 50], [1, 0.3, 25, 52]], boots: [] } as unknown as Build;
    const keyOf = (id: number) => ({ 116: 'black_king_bar', 1: 'monkey_king_bar' })[id];
    const s = suggestItems({ hero: byKey('juggernaut'), position: 1, enemies: team('lion', 'bane', 'earthshaker', 'phantom_assassin'), build, itemKeyOf: keyOf });
    expect(s.map((x) => x.key)).not.toContain('black_king_bar');
    const mkb = s.find((x) => x.key === 'monkey_king_bar')!;
    expect(mkb.buildPct).toBe(0.3);
    expect(mkb.reasons[0].heroes.map((h) => h.name)).toEqual(['Phantom Assassin']);
  });

  it('lowers items this hero never buys (rules do not know the hero, the build does)', () => {
    const enemies = team('crystal_maiden', 'bane', 'earthshaker', 'phantom_assassin');
    const none = { items: [], boots: [] } as unknown as Build;
    const known = suggestItems({ hero: byKey('juggernaut'), position: 1, enemies, build: none, itemKeyOf: () => undefined });
    const unknown = suggestItems({ hero: byKey('juggernaut'), position: 1, enemies, build: null, itemKeyOf: () => undefined });
    const bkb = (list: typeof known) => list.find((x) => x.key === 'black_king_bar')!.score;
    expect(bkb(known)).toBeLessThan(bkb(unknown));
  });

  it('returns nothing without enemies or without a trigger', () => {
    expect(suggestItems({ hero: byKey('lion'), position: 5, enemies: [], build: null, itemKeyOf: () => undefined })).toEqual([]);
    expect(suggestItems({ hero: byKey('lion'), position: 5, enemies: team('axe'), build: null, itemKeyOf: () => undefined })).toEqual([]);
  });
});
