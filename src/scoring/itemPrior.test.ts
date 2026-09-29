/**
 * ItemPrior engine tests (ТЗ №14 §18-§20).
 *
 * The synthetic fixtures are the important half: they pin the FORMULA against
 * numbers where the right answer is known by hand, so a future retune cannot
 * quietly change the contract. The production checks at the bottom are a
 * smoke test on the real snapshot, not a golden output.
 */
import { describe, expect, it } from 'vitest';
import heroesRaw from '../../public/data/heroes.json';
import itemsRaw from '../../public/data/items.json';
import itemStatsRaw from '../../public/data/item-stats.json';
import type { Hero, ItemCatalogue, ItemStatsDataset } from '../types';
import type { Dataset } from '../data/dataset';
import { getItemPrior, ITEM_PRIOR_PARAMS } from './itemPrior';

const BF = 145; // Battle Fury

function hero(id: number, name: string): Hero {
  return {
    id, key: `npc_dota_hero_${name.toLowerCase()}`, name,
    primaryAttr: 'STR', attackType: 'Melee', roles: [],
    img: '', icon: '', proPick: 0, proWin: 0, pubPick: 0, pubWin: 0, nameRu: '',
  };
}

function item(id: number, name: string) {
  return {
    id, name, dname: `item_${name.toLowerCase().replace(/\W+/g, '')}`, shortName: name,
    cost: 1000, isPurchasable: true, isStackable: false, isSideShop: false,
    stockMax: 0, isSupportFullItem: false, image: '', components: [],
  };
}

function cell(purchases: number, heroGames: number, extra: Record<string, unknown> = {}) {
  return { purchases, wins: Math.floor(purchases / 2), heroGames, byMinute: { 10: purchases }, instances: { 0: purchases }, ...extra };
}

/** A dataset with an explicit, hand-checkable population. */
function fixture(heroStats: ItemStatsDataset, catalogue: ItemCatalogue): Dataset {
  return {
    heroes: [], heroById: new Map(), matchups: new Map(), positions: {},
    items: catalogue, itemStats: heroStats,
    meta: { source: 'STRATZ', generatedAt: '', latestPatch: '', heroCount: 0 },
  } as unknown as Dataset;
}

describe('getItemPrior — golden fixtures (§19)', () => {
  // Hero A pos1: X is bought 5x more often than Y and is also 10x the
  // population rate. Both terms must point the same way.
  const ds = fixture(
    {
      1: { 1: { 10: cell(500, 1000), 11: cell(100, 1000) } },
      2: { 1: { 10: cell(40, 1000), 11: cell(4, 1000) } },
      3: { 1: { 10: cell(40, 1000), 11: cell(4, 1000) } },
    },
    { 10: item(10, 'ItemX'), 11: item(11, 'ItemY') },
  );
  const priors = getItemPrior(ds, 1, '1');

  it('ranks the more intense, more hero-specific item first', () => {
    expect(priors[0].itemId).toBe(10);
    expect(priors[0].score).toBeGreaterThan(priors[1].score);
  });

  it('reproduces the §4 formula exactly for the winning cell', () => {
    const p = priors[0];
    // Population: item 10 = (500 + 40 + 40) / 3000 = 0.1933
    const base = (500 + 40 + 40) / 3000;
    const smoothed = (500 + ITEM_PRIOR_PARAMS.alpha * base) / (1000 + ITEM_PRIOR_PARAMS.alpha);
    const lift = (smoothed + 0.01) / (base + 0.01);
    const evPerGame = 500 / 1000;
    const share = 500 / (500 + 100);
    const expected =
      0.6 * Math.log1p(evPerGame) + 0.2 * Math.log1p(share) + 0.2 * Math.log2(lift);
    expect(p.purchaseEventsPerGame).toBeCloseTo(evPerGame, 12);
    expect(p.eventShare).toBeCloseTo(share, 12);
    expect(p.baselineIntensity).toBeCloseTo(base, 12);
    expect(p.smoothedIntensity).toBeCloseTo(smoothed, 12);
    expect(p.lift).toBeCloseTo(lift, 12);
    expect(p.score).toBeCloseTo(expected, 12);
  });

  it('uses a POPULATION baseline, not the hero’s own average (§5)', () => {
    // Item Y is bought by hero A at 100/1000 = 0.1, but the lane average is
    // 108/3000 = 0.036, so hero A is nearly 3x the population on Y — lift > 2
    // even though the item is rare in absolute terms.
    const y = getItemPrior(ds, 1, '1').find((p) => p.itemId === 11)!;
    expect(y.purchaseEventsPerGame).toBeCloseTo(0.1, 12);
    expect(y.lift).toBeGreaterThan(2);
  });

  it('is deterministic: identical ordering across repeated calls (§14)', () => {
    const a = getItemPrior(ds, 1, '1').map((p) => p.itemId);
    const b = getItemPrior(ds, 1, '1').map((p) => p.itemId);
    const c = getItemPrior(ds, 1, '1').map((p) => p.itemId);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('breaks score ties by purchases desc, then itemId asc (§14)', () => {
    const tie = fixture(
      { 1: { 1: { 20: cell(100, 1000), 21: cell(100, 1000), 22: cell(50, 1000) } } },
      { 20: item(20, 'A'), 21: item(21, 'B'), 22: item(22, 'C') },
    );
    const ids = getItemPrior(tie, 1, '1').map((p) => p.itemId);
    // 20 and 21 tie completely -> ascending id; 22 has fewer purchases -> last.
    expect(ids).toEqual([20, 21, 22]);
  });

  it('returns every valid item — no top-N inside the engine (§15)', () => {
    const many: ItemStatsDataset = { 1: { 1: {} } };
    const cat: ItemCatalogue = {};
    for (let i = 1; i <= 40; i += 1) {
      many[1]['1'][i] = cell(1000 - i, 5000);
      cat[i] = item(i, `I${i}`);
    }
    expect(getItemPrior(fixture(many, cat), 1, '1')).toHaveLength(40);
  });
});


describe('getItemPrior — edge cases (§18 F-J)', () => {
  const cat: ItemCatalogue = { 10: item(10, 'ItemX'), 11: item(11, 'ItemY') };

  it('returns [] for an unknown hero (§18 G)', () => {
    const ds = fixture({ 1: { 1: { 10: cell(100, 1000) } } }, cat);
    expect(getItemPrior(ds, 999, '1')).toEqual([]);
  });

  it('returns [] for a position the hero has no data on (§18 F)', () => {
    // Explicitly NOT a fallback to pos1: the lane genuinely differs.
    const ds = fixture({ 1: { 1: { 10: cell(100, 1000) } } }, cat);
    expect(getItemPrior(ds, 1, '4')).toEqual([]);
  });

  it('never borrows another lane’s data (§8)', () => {
    const ds = fixture({
      1: { 4: { 10: cell(300, 1000) }, 5: { 11: cell(700, 1000) } },
    }, cat);
    expect(getItemPrior(ds, 1, '4').map((p) => p.itemId)).toEqual([10]);
    expect(getItemPrior(ds, 1, '5').map((p) => p.itemId)).toEqual([11]);
  });

  it('throws when statistics reference an item missing from the catalogue (§9)', () => {
    const ds = fixture({ 1: { 1: { 77: cell(100, 1000) } } }, cat);
    expect(() => getItemPrior(ds, 1, '1')).toThrow(/no entry in items\.json/);
  });

  it('drops a cell whose heroGames is 0 rather than dividing by zero (§7, §18 I)', () => {
    const ds = fixture({ 1: { 1: { 10: cell(100, 0), 11: cell(50, 1000) } } }, cat);
    const priors = getItemPrior(ds, 1, '1');
    expect(priors.map((p) => p.itemId)).toEqual([11]);
    for (const p of priors) {
      expect(Number.isFinite(p.purchaseEventsPerGame)).toBe(true);
      expect(Number.isFinite(p.score)).toBe(true);
    }
  });

  it('never emits NaN or Infinity, even from corrupt cells (§7, §18 J)', () => {
    const ds = fixture(
      { 1: { 1: { 10: cell(0, 0), 11: cell(Number.NaN, 1000) } },
        2: { 1: { 10: cell(100, 1000), 11: cell(50, 1000) } } },
      cat,
    );
    for (const p of getItemPrior(ds, 1, '1')) {
      for (const [k, v] of Object.entries(p)) {
        if (typeof v === 'number') expect(Number.isFinite(v), `${k}=${v}`).toBe(true);
      }
    }
  });

  it('keeps neutral items without penalising them (§11)', () => {
    const withNeutral: ItemCatalogue = { ...cat, 4205: item(4205, 'Greater Healing Lotus') };
    const ds = fixture({ 1: { 1: { 10: cell(100, 1000), 4205: cell(50, 1000) } } }, withNeutral);
    const priors = getItemPrior(ds, 1, '1');
    expect(priors.map((p) => p.itemId)).toContain(4205);
    expect(priors.find((p) => p.itemId === 4205)!.score).toBeGreaterThan(0);
  });

  it('exposes shard/scepter as ordinary priors with no slot metadata (§12)', () => {
    const withAghs: ItemCatalogue = { 10: item(10, 'ItemX'), 108: item(108, "Aghanim's Shard") };
    const ds = fixture({ 1: { 1: { 10: cell(100, 1000), 108: cell(20, 1000) } } }, withAghs);
    const shard = getItemPrior(ds, 1, '1').find((p) => p.itemId === 108)!;
    expect(shard.itemName).toBe("Aghanim's Shard");
    for (const forbidden of ['occupiesSlot', 'isCore', 'isSituational', 'isCounter']) {
      expect(Object.keys(shard)).not.toContain(forbidden);
    }
  });
});


// ---------------------------------------------------------------- §20/§25
// Runs against the SHIPPED snapshot. No network, no generator, no fixture
// fakery — this is the same JSON the app loads.
describe('getItemPrior — shipped production dataset (§20)', () => {
  const heroes = heroesRaw as unknown as Hero[];
  const items = itemsRaw as unknown as ItemCatalogue;
  const stats = itemStatsRaw as unknown as ItemStatsDataset;
  const ds = fixture(stats, items);
  const idOf = (name: string) => heroes.find((h) => h.name === name)!.id;

  it('A. Anti-Mage pos1 ranks Battle Fury in the top 3', () => {
    const priors = getItemPrior(ds, idOf('Anti-Mage'), '1');
    expect(priors.length).toBeGreaterThan(0);
    const rank = priors.findIndex((p) => p.itemId === BF) + 1;
    expect(rank).toBeGreaterThan(0);
    expect(rank).toBeLessThanOrEqual(3);
  });

  it('B. Sniper pos1 does not contain Battle Fury at all', () => {
    expect(getItemPrior(ds, idOf('Sniper'), '1').map((p) => p.itemId)).not.toContain(BF);
  });

  it('C. Bane pos4 yields a support-flavoured profile, not an empty one', () => {
    const priors = getItemPrior(ds, idOf('Bane'), '4');
    expect(priors.length).toBeGreaterThan(0);
    expect(priors[0].itemName.length).toBeGreaterThan(0);
    for (const p of priors) expect(Number.isFinite(p.score)).toBe(true);
  });

  it('E. Bane pos4 and pos5 come from their own lane data (§18 E)', () => {
    const p4 = getItemPrior(ds, idOf('Bane'), '4');
    const p5 = getItemPrior(ds, idOf('Bane'), '5');
    expect(p4.length).toBeGreaterThan(0);
    expect(p5.length).toBeGreaterThan(0);
    // The lanes are genuinely different datasets, not copies: different volumes,
    // and the same item scores differently on each. (The TOP item happens to be
    // the same on both lanes for Bane — measured in ТЗ №12 — so asserting a
    // different top entry would encode a coincidence, not the contract.)
    expect(p4[0].heroGames).not.toBe(p5[0].heroGames);
    const shared = p4.filter((a) => p5.some((b) => b.itemId === a.itemId));
    expect(shared.length).toBeGreaterThan(0);
    const differs = shared.some((a) => {
      const b = p5.find((x) => x.itemId === a.itemId)!;
      return Math.abs(a.score - b.score) > 1e-9;
    });
    expect(differs).toBe(true);
  });

  it('D. Puck pos2 and Wraith King pos1 both produce non-empty profiles', () => {
    expect(getItemPrior(ds, idOf('Puck'), '2').length).toBeGreaterThan(0);
    expect(getItemPrior(ds, idOf('Wraith King'), '1').length).toBeGreaterThan(0);
  });

  it('§21 stays cheap: the population baseline is built once per dataset', () => {
    const t0 = performance.now();
    for (let i = 0; i < 200; i += 1) getItemPrior(ds, idOf('Puck'), '2');
    const perCall = (performance.now() - t0) / 200;
    // Rebuilding the 127x5 aggregate on every call would be milliseconds each.
    expect(perCall).toBeLessThan(1);
  });

  it('exposes raw statistics on every prior (§3, raw counts preserved)', () => {
    const [p] = getItemPrior(ds, idOf('Anti-Mage'), '1');
    expect(p.purchases).toBeGreaterThan(0);
    expect(p.heroGames).toBeGreaterThan(0);
    expect(p.medianPurchaseMinute).toBeGreaterThan(0);
    expect(Object.keys(p.byMinute).length).toBeGreaterThan(0);
    expect(Object.keys(p.instances).length).toBeGreaterThan(0);
  });
});
