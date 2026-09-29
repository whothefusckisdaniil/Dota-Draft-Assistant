/**
 * Hero identity contract (ТЗ §18.1).
 *
 * Two levels:
 *  1. synthetic  — the display-name slug must never be used as identity;
 *  2. committed  — the shipped heroes.json really carries the authoritative
 *     OpenDota keys, and they are what the itembuild join uses.
 */
import { describe, expect, it } from 'vitest';
import heroesRaw from '../public/data/heroes.json';
import valveRaw from '../research/valve-itembuilds.json';
import type { Hero } from '../src/types';
import { normalizeHero } from './opendota/metadata.mjs';

const heroes = heroesRaw as unknown as Hero[];
const valve = valveRaw as unknown as { heroes: Record<string, unknown>; heroCount: number };
const keyOf = (name: string) => heroes.find((h) => h.name === name)?.key;

describe('normalizeHero — the key is copied, never derived (§1)', () => {
  it('takes the OpenDota internal name verbatim', () => {
    const h = normalizeHero(
      { id: 1, name: 'npc_dota_hero_antimage', localized_name: 'Anti-Mage' } as never,
      new Map(),
    );
    expect(h.key).toBe('npc_dota_hero_antimage');
  });

  it('does not lowercase, replace or slugify', () => {
    const raw = 'npc_dota_hero_Some_Mixed_Name';
    const h = normalizeHero({ id: 2, name: raw, localized_name: 'X' } as never, new Map());
    // Preserved exactly; a slugifier would have rewritten the casing.
    expect(h.key).toBe(raw);
  });

  it('does not fall back to a display-name slug when the key is absent', () => {
    // `name` IS the key source, so a payload without it must not be repaired.
    const h = normalizeHero({ id: 3, localized_name: 'Anti-Mage' } as never, new Map());
    expect(h.key).toBeUndefined();
  });
});

describe('the committed heroes.json carries authoritative keys (§6, §10)', () => {
  // Each entry: [display name, authoritative key, the WRONG slug that the
  // previous loader produced].
  const CASES: [string, string, string][] = [
    ['Anti-Mage', 'npc_dota_hero_antimage', 'npc_dota_hero_anti_mage'],
    ['Wraith King', 'npc_dota_hero_skeleton_king', 'npc_dota_hero_wraith_king'],
    ['Skywrath Mage', 'npc_dota_hero_skywrath_mage', 'npc_dota_hero_bird_samurai'],
    ['Lifestealer', 'npc_dota_hero_life_stealer', 'npc_dota_hero_lifestealer'],
    ['Zeus', 'npc_dota_hero_zuus', 'npc_dota_hero_zeus'],
  ];

  for (const [name, expected, forbidden] of CASES) {
    it(`${name} -> ${expected}`, () => {
      expect(keyOf(name)).toBe(expected);
      expect(keyOf(name)).not.toBe(forbidden);
    });
  }

  it('has 127 heroes with 127 unique ids and 127 unique keys', () => {
    expect(heroes).toHaveLength(127);
    expect(new Set(heroes.map((h) => h.id)).size).toBe(127);
    expect(new Set(heroes.map((h) => h.key)).size).toBe(127);
  });

  it('every key is a well-formed npc_dota_hero_* name', () => {
    for (const h of heroes) expect(h.key, h.name).toMatch(/^npc_dota_hero_[a-z0-9_]+$/);
  });
});

describe('itembuild join uses the stored key (§5, §7)', () => {
  it('joins 126/127, and both gaps are explained rather than aliased', () => {
    const projectKeys = new Set(heroes.map((h) => h.key));
    const valveKeys = Object.keys(valve.heroes);
    const matched = valveKeys.filter((k) => projectKeys.has(k));

    expect(matched.length).toBe(126);

    // Gap 1: Valve's itembuild file predates Skywrath Mage's rename and still
    // uses npc_dota_hero_bird_samurai. OpenDota's current authoritative name is
    // npc_dota_hero_skywrath_mage. Bridging this needs an alias, which §9
    // forbids — so the gap is recorded instead.
    expect(valveKeys.filter((k) => !projectKeys.has(k))).toEqual(['npc_dota_hero_bird_samurai']);

    // Gap 2: Kez has no itembuild file in the pinned Valve snapshot at all.
    const projectOnly = [...projectKeys].filter((k) => !valve.heroes[k]);
    expect(projectOnly).toEqual(['npc_dota_hero_kez']);
  });

  it('representative previously broken heroes now have Valve builds', () => {
    // These are heroes whose authoritative key differs from the old display-name
    // slug, so they were unmatched before this fix. Verified against the
    // committed snapshot and the pinned Valve source.
    for (const key of [
      'npc_dota_hero_antimage', 'npc_dota_hero_skeleton_king', 'npc_dota_hero_life_stealer',
      'npc_dota_hero_zuus', 'npc_dota_hero_queenofpain', 'npc_dota_hero_vengefulspirit',
      'npc_dota_hero_doom_bringer', 'npc_dota_hero_shredder', 'npc_dota_hero_magnataur',
      'npc_dota_hero_obsidian_destroyer', 'npc_dota_hero_abyssal_underlord',
    ]) {
      expect(valve.heroes[key], key).toBeDefined();
    }
  });
});
