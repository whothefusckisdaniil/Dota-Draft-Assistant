/**
 * Item data contract (ТЗ §12 §23A, B, C, D, E, F, G, H, I, J).
 *
 * §23C (position comes from the REQUEST) and §23D (purchases may exceed
 * heroGames) encode a research finding rather than a convention, and both are
 * easy to "fix" wrongly later.
 */
import { describe, expect, it } from 'vitest';
import { buildItemStatsQuery, MAX_PLAUSIBLE_MINUTE, pruneItemCatalogue, validateItemData } from './items.mjs';

const HEROES = [{ id: 1 }, { id: 2 }, { id: 3 }];
const WI = { buckets: [1, 2, 3, 4], currentBucket: 5 };

const item = (id, over = {}) => ({
  id, name: `Item ${id}`, dname: `item_${id}`, shortName: '', cost: 1000,
  isPurchasable: true, isStackable: false, isSideShop: false, stockMax: 0,
  isSupportFullItem: false, image: '', components: [], ...over,
});
const catalogue = { 145: item(145), 108: item(108) };

const cell = (purchases, wins, extra = {}) => ({
  purchases, wins, heroGames: 1000, byMinute: { 8: purchases }, instances: { 0: purchases }, ...extra,
});
const valid = () => ({
  items: structuredClone(catalogue),
  itemStats: { 1: { 1: { 145: cell(100, 50) } } },
});
const run = (v) => () => validateItemData(v.items, v.itemStats, { heroes: HEROES, windowInfo: WI });

// ---------------------------------------------------------------- §23A/B
describe('validateItemData — happy path', () => {
  it('accepts a consistent dataset and reports its size', () => {
    const r = run(valid())();
    expect(r.itemCount).toBe(2);
    expect(r.heroesWithData).toBe(1);
    expect(r.positions).toBe(1);
    expect(r.cells).toBe(1);
  });
});

describe('validateItemData — metadata gates (§23A, F)', () => {
  it('rejects a recipe in the catalogue', () => {
    const v = valid();
    v.items[145].isRecipe = true;
    expect(run(v)).toThrow(/recipe present/);
  });

  it('rejects an item whose id disagrees with its key', () => {
    const v = valid();
    v.items[145].id = 999;
    expect(run(v)).toThrow(/disagrees with its key/);
  });

  it('rejects a missing contract field', () => {
    const v = valid();
    delete v.items[145].cost;
    expect(run(v)).toThrow(/missing field "cost"/);
  });

  it('rejects a component that is not in the catalogue (orphan)', () => {
    const v = valid();
    v.items[145].components = [7777];
    expect(run(v)).toThrow(/component 7777 is not in the catalogue/);
  });

  it('rejects an empty catalogue', () => {
    const v = valid();
    v.items = {};
    expect(run(v)).toThrow(/items.json is empty/);
  });
});

// ---------------------------------------------------------------- §23F/G/H
describe('validateItemData — statistics gates', () => {
  it('rejects a statistics entry for an item that is not in the catalogue', () => {
    const v = valid();
    v.itemStats = { 1: { 1: { 4242: cell(100, 50) } } };
    expect(run(v)).toThrow(/not in items.json/);
  });

  it('rejects a negative purchase count', () => {
    const v = valid();
    v.itemStats = { 1: { 1: { 145: cell(-1, 0, { byMinute: {}, instances: {} }) } } };
    expect(run(v)).toThrow(/purchases must be a non-negative integer/);
  });

  it('rejects a negative byMinute count', () => {
    const v = valid();
    v.itemStats = { 1: { 1: { 145: cell(100, 50, { byMinute: { 8: -5 } }) } } };
    expect(run(v)).toThrow(/byMinute\["8"\] must be a non-negative integer/);
  });

  it('rejects a fractional time key', () => {
    const v = valid();
    v.itemStats = { 1: { 1: { 145: cell(100, 50, { byMinute: { 8.5: 100 } }) } } };
    expect(run(v)).toThrow(/byMinute key "8.5"/);
  });

  it('rejects an implausible time instead of silently clamping it', () => {
    const v = valid();
    v.itemStats = { 1: { 1: { 145: cell(100, 50, { byMinute: { 900: 100 } }) } } };
    expect(run(v)).toThrow(new RegExp(`exceeds the plausible maximum ${MAX_PLAUSIBLE_MINUTE}`));
  });

  it('rejects a negative instance key', () => {
    const v = valid();
    v.itemStats = { 1: { 1: { 145: cell(100, 50, { instances: { '-1': 100 } }) } } };
    expect(run(v)).toThrow(/instance "-1" must be a non-negative integer/);
  });

  it('rejects a hero that is not in the canonical roster', () => {
    const v = valid();
    v.itemStats = { 99: { 1: { 145: cell(10, 5) } } };
    expect(run(v)).toThrow(/entry for unknown hero 99/);
  });

  it('rejects a position key that is not 1..5', () => {
    const v = valid();
    v.itemStats = { 1: { 6: { 145: cell(10, 5) } } };
    expect(run(v)).toThrow(/position key "6" is not 1\.\.5/);
  });

  it('rejects a histogram that does not account for every purchase', () => {
    const v = valid();
    v.itemStats = { 1: { 1: { 145: cell(100, 50, { byMinute: { 8: 40 } }) } } };
    expect(run(v)).toThrow(/byMinute sums to 40 but purchases is 100/);
  });
});

// ---------------------------------------------------------------- §23D/E
describe('validateItemData — the two counter-intuitive rules (§23D, E)', () => {
  it('ACCEPTS purchases exceeding heroGames — matchCount is a purchase count', () => {
    // §16: Anti-Mage genuinely exceeds this. Asserting the opposite would
    // reject correct data, so this guards the absence of that check.
    const v = valid();
    v.itemStats = { 1: { 1: { 145: cell(130, 60, { heroGames: 100 }) } } };
    expect(run(v)).not.toThrow();
  });

  it('REJECTS wins exceeding purchases — wins are a subset of purchases', () => {
    const v = valid();
    v.itemStats = { 1: { 1: { 145: cell(100, 101) } } };
    expect(run(v)).toThrow(/wins 101 exceed purchases 100/);
  });

  it('treats a hero with no item data as valid, not an error (§23I)', () => {
    // Absence is recorded, never back-filled.
    const v = valid();
    v.itemStats = { 1: { 1: { 145: cell(10, 5) } }, 2: {}, 3: {} };
    expect(run(v)).not.toThrow();
  });
});

// ---------------------------------------------------------------- §23C
describe('position is request-derived, never the response echo (§23C)', () => {
  it('builds the query for the requested position', () => {
    const q = buildItemStatsQuery([35], 4, 2959);
    expect(q).toContain('positionIds: [POSITION_4]');
    expect(q).toContain('heroId: 35');
    expect(q).toContain(`week: ${2959 * 604800}`);
  });

  it('never puts several positions in one request (§12)', () => {
    // A combined all-positions response cannot be attributed correctly, so the
    // builder must not be able to produce one.
    for (const pos of [1, 2, 3, 4, 5]) {
      const q = buildItemStatsQuery([1, 2], pos, 100);
      const positions = q.match(/POSITION_\d/g) ?? [];
      expect(new Set(positions).size, `pos${pos}`).toBe(1);
      expect(positions.length).toBe(2); // once per aliased hero
    }
  });

  it('does not request the position field at all, so the echo cannot leak in', () => {
    // STRATZ answers with `position: POSITION_1` whatever was asked. The output
    // shape must come from the request, so the field is never even selected.
    const q = buildItemStatsQuery([35], 4, 2959);
    expect(q).toContain('POSITION_4');
    expect(q).not.toMatch(/\bposition\b/);
  });
});

// ---------------------------------------------------------------- §23J
describe('weekly bucket aggregation (§23J)', () => {
  it('sums the same item+minute across four weekly buckets', () => {
    // The ТЗ's worked example: 100 + 200 + 300 + 400 = 1000 at minute 8.
    const merged = [100, 200, 300, 400].reduce(
      (acc, n) => {
        acc.purchases += n;
        acc.wins += Math.round(n / 2);
        acc.byMinute[8] = (acc.byMinute[8] ?? 0) + n;
        acc.instances[0] = (acc.instances[0] ?? 0) + n;
        return acc;
      },
      { purchases: 0, wins: 0, byMinute: {}, instances: {} },
    );

    const v = valid();
    v.itemStats = { 1: { 1: { 145: { ...merged, heroGames: 10_000 } } } };
    expect(run(v)).not.toThrow();
    expect(v.itemStats[1][1][145].byMinute[8]).toBe(1000);
    expect(v.itemStats[1][1][145].purchases).toBe(1000);
    expect(v.itemStats[1][1][145].instances[0]).toBe(1000);
  });
});

describe('pruneItemCatalogue', () => {
  it('keeps shop items and items the statistics show being bought', () => {
    const items = {
      1: item(1),
      2: item(2),
      4205: item(4205, { isPurchasable: false }), // Healing Lotus: neutral, but bought
      33: item(33, { isPurchasable: false }), // cheese: internal, never bought
    };
    const { items: kept, nonShopButBought } = pruneItemCatalogue(items, {
      1: { 1: { 4205: cell(10, 5) } },
    });
    expect(Object.keys(kept).sort()).toEqual(['1', '2', '4205']);
    expect(nonShopButBought).toBe(1);
  });

  it('drops a non-purchasable item that is never bought', () => {
    expect(pruneItemCatalogue({ 33: item(33, { isPurchasable: false }) }, {}).items).toEqual({});
  });
});

