/**
 * Build Candidate Engine tests (ТЗ §20 §10). Synthetic only — no network, no
 * production data.
 *
 * The recurring theme: a candidate must appear whenever STRATZ observed the
 * item, REGARDLESS of what Valve has to say, and a Valve-only item must never
 * be promoted. Cases D and E pin that asymmetry; F pins its other half.
 */
import { describe, expect, it } from 'vitest';
import type { ItemCatalogue, ItemStatsDataset } from '../types';
import { getBuildCandidates, type BuildCandidateInput } from './buildCandidates';
import { getItemPrior } from './itemPrior';
import type { ValveBuildData } from './buildPhasePrior';

const HERO = 1;
const HERO_UNKNOWN_TO_VALVE = 2;
const BF = 145;
const WAND = 36;

const catalogue = Object.fromEntries(
  [
    { id: BF, dname: 'item_bfury', name: 'Battle Fury', cost: 3900 },
    { id: WAND, dname: 'item_magic_wand', name: 'Magic Wand', cost: 450 },
  ].map((x) => [x.id, { ...x, shortName: '', isPurchasable: true, isStackable: false, isSideShop: false, stockMax: 0, isSupportFullItem: false, image: '', components: [] }]),
) as unknown as ItemCatalogue;

const cell = (purchases: number, games: number, minutes: number[]) => ({
  purchases, wins: Math.floor(purchases / 2), heroGames: games,
  byMinute: Object.fromEntries(minutes.map((m) => [m, purchases / minutes.length])),
  instances: { 0: purchases },
});

/** BF is clearly stronger: more events, and it wins the lift against the lane. */
function stats(heroId = HERO): ItemStatsDataset {
  return {
    [heroId]: { 1: { [BF]: cell(10000, 1000, [14]), [WAND]: cell(5000, 1000, [4]) } },
  } as unknown as ItemStatsDataset;
}

function input(over: Partial<BuildCandidateInput> = {}): BuildCandidateInput {
  return {
    heroId: HERO, position: '1',
    heroes: [
      { id: HERO, key: 'npc_dota_hero_known' },
      { id: HERO_UNKNOWN_TO_VALVE, key: 'npc_dota_hero_absent_from_valve' },
    ],
    catalogue,
    itemStats: stats(),
    valve: {
      heroes: {
        npc_dota_hero_known: {
          buildFile: 'default_known.txt',
          phases: { Late_Items: ['item_bfury'], Early_Game: ['item_bfury'] },
        },
      },
    } as ValveBuildData,
    ...over,
  };
}

describe('A. one candidate per ItemPrior, fields aligned (§10 A)', () => {
  const out = getBuildCandidates(input());
  const priors = getItemPrior({ items: catalogue, itemStats: stats() }, HERO, '1');

  it('produces exactly as many candidates as priors', () => {
    expect(out).toHaveLength(priors.length);
    expect(out.length).toBe(2);
  });

  it('keeps item, hero and position identical across prior and evidence', () => {
    for (const c of out) {
      expect(c.itemPrior.itemId).toBe(c.evidence.itemId);
      expect(c.heroId).toBe(c.evidence.heroId);
      expect(c.position).toBe(String(c.evidence.position));
    }
  });

  it('passes the prior through unmodified (§5)', () => {
    // Object identity is not observable here: getItemPrior() builds a fresh
    // array per call, so two calls never share objects. What this pins is that
    // the candidate carries the prior VERBATIM — every raw count, score and
    // share matches an independent evaluation, i.e. nothing was recomputed,
    // rescored or renormalised on the way in.
    const independent = getItemPrior({ items: catalogue, itemStats: stats() }, HERO, '1');
    for (const c of out) {
      expect(c.itemPrior).toStrictEqual(independent.find((p) => p.itemId === c.itemId));
    }
  });
});

describe('B. rank is the inherited ItemPrior order, from 1 (§10 B)', () => {
  const out = getBuildCandidates(input());

  it('numbers candidates 1..N in ItemPrior order', () => {
    expect(out.map((c) => c.rank)).toEqual([1, 2]);
  });

  it('rank 1 is the highest-scoring prior, with no re-sorting', () => {
    expect(out[0].itemPrior.score).toBeGreaterThanOrEqual(out[1].itemPrior.score);
  });
});

describe('C. all five evidence signals travel with the candidate (§10 C)', () => {
  const c = getBuildCandidates(input())[0];

  it('carries prior, timing, valveHero, valveItem and phase', () => {
    for (const s of [c.evidence.itemPrior, c.evidence.timing, c.evidence.valveHero, c.evidence.valveItem, c.evidence.phase]) {
      expect(s.status).toBe('available');
    }
  });

  it('keeps every phase Valve authored rather than picking one (§6)', () => {
    if (c.evidence.phase.status !== 'available') throw new Error('x');
    expect(c.evidence.phase.value.phases).toEqual(['Early_Game', 'Late_Items']);
    expect(c.evidence.phase.value.phaseExclusive).toBe(false);
  });
});

describe('D. Valve knows nothing about the hero -> candidate still exists (§10 D)', () => {
  const s = stats(HERO_UNKNOWN_TO_VALVE);
  const out = getBuildCandidates(input({ heroId: HERO_UNKNOWN_TO_VALVE, itemStats: s }));

  it('returns both candidates', () => {
    expect(out).toHaveLength(2);
  });

  it('has STRATZ evidence available and Valve evidence unavailable', () => {
    const c = out[0];
    expect(c.evidence.itemPrior.status).toBe('available');
    expect(c.evidence.timing.status).toBe('available');
    expect(c.evidence.valveHero.status).toBe('unavailable');
    expect(c.evidence.valveItem.status).toBe('unavailable');
    expect(c.evidence.phase.status).toBe('unavailable');
  });

  it('does not demote the item for want of Valve evidence', () => {
    expect(out[0].rank).toBe(1);
  });
});

describe('E. Valve knows the hero but the item is absent -> candidate still exists (§10 E)', () => {
  const out = getBuildCandidates(input());
  const wand = out.find((c) => c.itemId === WAND);

  it('reports a real negative, not a gap', () => {
    if (!wand || wand.evidence.valveItem.status !== 'available') throw new Error('x');
    expect(wand.evidence.valveItem.value.present).toBe(false);
    expect(wand.evidence.valveItem.value.phases).toEqual([]);
  });

  it('reports phase as unavailable with no_phase', () => {
    if (!wand || wand.evidence.phase.status !== 'unavailable') throw new Error('x');
    expect(wand.evidence.phase.reason).toBe('no_phase');
  });

  it('still lists the item, because STRATZ observed it', () => {
    expect(wand).toBeDefined();
    expect(wand?.rank).toBe(2);
  });
});

describe('F. no STRATZ cell -> no candidates, and no Valve fallback (§10 F)', () => {
  it('returns [] when the hero has no priors for that lane', () => {
    expect(getBuildCandidates(input({ itemStats: {} as unknown as ItemStatsDataset }))).toEqual([]);
  });

  it('returns [] for an unknown lane, never borrowing another lane (§4)', () => {
    expect(getBuildCandidates(input({ position: '4' }))).toEqual([]);
  });

  it('never promotes a Valve-only item', () => {
    // A third item exists in the catalogue and Valve lists it for the hero, but
    // STRATZ never observed it. Clone a real entry so the fixture stays a valid
    // ItemEntry, then give it a distinct id/dname.
    const clone = (catalogue as unknown as Record<number, Record<string, unknown>>)[WAND];
    const withTango = { ...catalogue, 50: { ...clone, id: 50, dname: 'item_tango', name: 'Tango' } };
    const withTangoBuild: ValveBuildData = {
      heroes: {
        npc_dota_hero_known: {
          buildFile: 'default_known.txt',
          phases: { Starting_Items: ['item_tango'] },
        },
      },
    };
    const out = getBuildCandidates(input({
      catalogue: withTango as unknown as ItemCatalogue,
      valve: withTangoBuild,
    }));
    expect(out.find((c) => c.itemId === 50)).toBeUndefined();
  });
});

describe('G. limit is consumer-side only (§7)', () => {
  it('returns everything when limit is undefined', () => {
    expect(getBuildCandidates(input())).toHaveLength(2);
  });

  it('caps at the requested number', () => {
    expect(getBuildCandidates(input({ limit: 15 }))).toHaveLength(2);
    expect(getBuildCandidates(input({ limit: 1 }))).toHaveLength(1);
  });

  it('limit 0 returns an empty list', () => {
    expect(getBuildCandidates(input({ limit: 0 }))).toEqual([]);
  });

  it('a negative limit throws rather than being reinterpreted', () => {
    expect(() => getBuildCandidates(input({ limit: -1 }))).toThrow(RangeError);
  });

  it('a non-integer limit throws too', () => {
    expect(() => getBuildCandidates(input({ limit: 1.5 }))).toThrow(RangeError);
  });
});

describe('H. no combined score, no enemy / slot / order input (§3, §9, §10 H)', () => {
  it('exposes only the documented candidate fields', () => {
    expect(Object.keys(getBuildCandidates(input())[0]).sort())
      .toEqual(['evidence', 'heroId', 'itemId', 'itemPrior', 'position', 'rank']);
  });

  it('accepts no enemy, slot or current-build input', () => {
    expect(Object.keys(input()).sort())
      .toEqual(['catalogue', 'heroId', 'heroes', 'itemStats', 'position', 'valve']);
  });

  it('is deterministic for the same input (§8)', () => {
    expect(JSON.stringify(getBuildCandidates(input())))
      .toBe(JSON.stringify(getBuildCandidates(input())));
  });
});
