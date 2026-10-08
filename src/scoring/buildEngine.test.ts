import { describe, expect, it } from 'vitest';
import type { Dataset } from '../data/dataset';
import type { HeroPositionEntry, ItemCatalogue, ItemStatsDataset } from '../types';
import { createBuildEngine } from './buildEngine';

const HERO_ID = 1;
const ITEM_A = 10;
const ITEM_B = 11;

const items: ItemCatalogue = {
  [ITEM_A]: {
    id: ITEM_A, name: 'Observed A', dname: 'item_observed_a', shortName: 'a',
    cost: 1000, isPurchasable: true, isStackable: false, isSideShop: false,
    stockMax: 0, isSupportFullItem: false, image: '', components: [],
  },
  [ITEM_B]: {
    id: ITEM_B, name: 'Observed B', dname: 'item_observed_b', shortName: 'b',
    cost: 500, isPurchasable: true, isStackable: false, isSideShop: false,
    stockMax: 0, isSupportFullItem: false, image: '', components: [],
  },
};

function itemCell(purchases: number) {
  return {
    purchases,
    wins: Math.floor(purchases / 2),
    heroGames: 1000,
    byMinute: { 10: purchases },
    instances: { 0: purchases },
  };
}

function dataset(overrides: Partial<Dataset> = {}): Dataset {
  const hero = {
    id: HERO_ID,
    key: 'npc_dota_hero_test',
    name: 'Test Hero',
    primaryAttr: 'agi',
    attackType: 'Ranged',
    roles: [],
    img: '',
    icon: '',
    proPick: 0,
    proWin: 0,
    pubPick: 0,
    pubWin: 0,
    nameRu: '',
  };
  const positions: HeroPositionEntry = {
    totalGames: 1000,
    positions: {
      1: { games: 800, share: 0.8 },
      2: { games: 600, share: 0.6 },
      3: { games: 50, share: 0.05 },
      4: { games: 25, share: 0.025 },
      5: { games: 25, share: 0.025 },
    },
  };
  return {
    heroes: [hero],
    heroById: new Map([[HERO_ID, hero]]),
    matchups: new Map(),
    positions: { [HERO_ID]: positions },
    items,
    itemStats: {
      [HERO_ID]: {
        1: {
          [ITEM_A]: itemCell(800),
          [ITEM_B]: itemCell(400),
        },
        2: {
          [ITEM_B]: itemCell(100),
        },
      },
    } as unknown as ItemStatsDataset,
    meta: {
      source: 'test',
      generatedAt: '2026-01-01T00:00:00Z',
      latestPatch: 'test',
      heroCount: 1,
    },
    ...overrides,
  };
}

describe('production build engine', () => {
  it('returns exact Hero + Position priors without importing enemy or win-based scoring', () => {
    const build = createBuildEngine(dataset()).getBuild(HERO_ID, '1');
    expect(build.status).toBe('ready');
    expect(build.heroId).toBe(HERO_ID);
    expect(build.position).toBe('1');
    expect(build.items.map((item) => item.itemId)).toEqual([ITEM_A, ITEM_B]);
    expect(build.items.map((item) => item.rank)).toEqual([1, 2]);
    expect(build.items[0].itemPriorScore).toBeGreaterThan(build.items[1].itemPriorScore);
    expect(build.items.every((item) => item.phase === 'general')).toBe(true);
    expect(build.items[0].evidence.itemPrior.status).toBe('available');
    expect(build.items[0].evidence.phase.status).toBe('unavailable');
  });

  it('does not convert General into a Valve phase or discard its evidence', () => {
    const build = createBuildEngine(dataset()).getBuild(HERO_ID, '1');
    expect(build.items[0].phase).toBe('general');
    expect(build.items[0].evidence.phase).toMatchObject({
      status: 'unavailable',
      reason: 'hero_data_unavailable',
    });
    expect(build.caveats).toContain(
      'Items in General have no mappable Valve phase; General is not a source phase.',
    );
  });

  it('uses Valve category labels when exact hero/item phase evidence exists', () => {
    const base = dataset();
    const antiMage = { ...base.heroes[0], key: 'npc_dota_hero_antimage' };
    const battleFury = {
      ...items[ITEM_A],
      id: 145,
      name: 'Battle Fury',
      dname: 'item_bfury',
    };
    const build = createBuildEngine({
      ...base,
      heroes: [antiMage],
      items: { 145: battleFury },
      itemStats: {
        [HERO_ID]: { 1: { 145: itemCell(800) } },
      } as unknown as ItemStatsDataset,
    }).getBuild(HERO_ID, '1');
    expect(build.items).toHaveLength(1);
    expect(build.items[0]).toMatchObject({
      itemId: 145,
      phase: 'mid',
      evidence: {
        phase: {
          status: 'available',
          value: { phases: ['Mid_Items'] },
        },
      },
    });
  });

  it('does not fall back to another lane or include an ineligible lane', () => {
    const engine = createBuildEngine(dataset());
    expect(engine.getBuild(HERO_ID, '3')).toMatchObject({
      status: 'ineligible-position',
      heroId: HERO_ID,
      position: '3',
      items: [],
    });
    expect(engine.getBuild(HERO_ID, '2').items.map((item) => item.itemId)).toEqual([ITEM_B]);
  });

  it('fails closed for unknown heroes and missing ItemPrior cells', () => {
    const engine = createBuildEngine(dataset());
    expect(engine.getBuild(999, '1')).toMatchObject({
      status: 'no-build-data',
      heroId: 999,
      items: [],
    });
    expect(createBuildEngine(dataset({ itemStats: {} })).getBuild(HERO_ID, '1'))
      .toMatchObject({ status: 'no-build-data', items: [] });
  });

  it('does not invent a numeric confidence score', () => {
    const build = createBuildEngine(dataset()).getBuild(HERO_ID, '1');
    expect(build.confidence).toEqual({
      status: 'not-calibrated',
      reason: 'No calibrated build-confidence model exists; no confidence score is inferred.',
    });
  });

  it('rejects invalid hero and position inputs explicitly', () => {
    const engine = createBuildEngine(dataset());
    expect(() => engine.getBuild(0, '1')).toThrow(RangeError);
    expect(() => engine.getBuild(HERO_ID, 'all' as '1')).toThrow(RangeError);
  });
});
