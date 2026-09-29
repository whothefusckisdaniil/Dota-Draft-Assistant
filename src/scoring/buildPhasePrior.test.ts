/**
 * BuildPhasePrior evidence tests (ТЗ §27).
 *
 * Synthetic throughout. The point is the EVIDENCE SEMANTICS — especially §26
 * Case A vs Case B, the distinction the whole type exists for:
 *
 *   A  Valve does not know the hero   -> valveItem UNAVAILABLE
 *   B  Valve knows the hero, no item  -> valveItem AVAILABLE, present: false
 *
 * Conflating those two is the bug this model is designed to prevent.
 */
import { describe, expect, it } from 'vitest';
import type { ItemCatalogue, ItemStatsDataset } from '../types';
import { getBuildPhasePrior, buildValveItemMap, mapHeroItems, type BuildPhasePriorInput } from './buildPhasePrior';
import { AGREEMENT_BOUNDARIES, getPhaseAgreement } from './buildPhaseAgreement';

const HERO_A = 1;
const HERO_UNKNOWN = 2;
const BF = 145;   // item_bfury
const WAND = 36;  // item_magic_wand

const catalogue = Object.fromEntries(
  [
    { id: BF, dname: 'item_bfury', name: 'Battle Fury' },
    { id: WAND, dname: 'item_magic_wand', name: 'Magic Wand' },
  ].map((x) => [x.id, { ...x, shortName: '', cost: 1000, isPurchasable: true, isStackable: false, isSideShop: false, stockMax: 0, isSupportFullItem: false, image: '', components: [] }]),
) as unknown as ItemCatalogue;

const cell = (purchases: number, minutes: number[]) => ({
  purchases, wins: Math.floor(purchases / 2), heroGames: 1000,
  byMinute: Object.fromEntries(minutes.map((m) => [m, purchases / minutes.length])),
  instances: { 0: purchases },
});

function input(over: Partial<BuildPhasePriorInput> = {}): BuildPhasePriorInput {
  return {
    heroId: HERO_A, position: 1, itemId: BF,
    heroes: [
      { id: HERO_A, key: 'npc_dota_hero_known' },
      { id: HERO_UNKNOWN, key: 'npc_dota_hero_absent_from_valve' },
    ],
    catalogue,
    itemStats: {
      1: { 1: { [BF]: cell(10000, [10, 12, 14]) } },
      // The second hero has full STRATZ data too: that is the point of §26 A —
      // a Valve gap must not remove the STRATZ signal.
      2: { 1: { [BF]: cell(10000, [10, 12, 14]) } },
    } as unknown as ItemStatsDataset,
    valve: { heroes: { npc_dota_hero_known: { buildFile: 'default_known.txt', phases: { Late_Items: ['item_bfury'] } } } },
    ...over,
  };
}

/** Narrowing helper: fails the test loudly instead of silently. */
function avail<T>(e: { status: string }): { value: T } {
  if (e.status !== 'available') throw new Error(`expected available, got ${e.status}`);
  return e as unknown as { value: T };
}

describe('A. full evidence chain available (§27 A, §26 C)', () => {
  const r = getBuildPhasePrior(input());

  it('has every signal available', () => {
    for (const s of [r.itemPrior, r.timing, r.valveHero, r.valveItem, r.phase]) {
      expect(s.status).toBe('available');
    }
  });

  it('reuses getItemPrior rather than recomputing the score', () => {
    const p = avail<{ purchases: number; score: number }>(r.itemPrior);
    expect(p.value.purchases).toBe(10000);
    expect(Number.isFinite(p.value.score)).toBe(true);
  });

  it('derives timing from the existing histogram', () => {
    const t = avail<{ medianMinute: number; totalEvents: number }>(r.timing);
    expect(t.value.medianMinute).toBeGreaterThan(0);
    expect(t.value.totalEvents).toBeGreaterThan(0);
  });

  it('carries no combined score (§9)', () => {
    for (const banned of ['finalScore', 'combinedScore', 'confidenceScore']) {
      expect(Object.keys(r)).not.toContain(banned);
    }
  });
});

describe('B. hero unavailable is never a negative signal (§26 A, §27 B)', () => {
  const r = getBuildPhasePrior(input({ heroId: HERO_UNKNOWN }));

  it('marks only the Valve side unavailable, leaving STRATZ intact', () => {
    expect(r.itemPrior.status).toBe('available');
    expect(r.timing.status).toBe('available');
    expect(r.valveHero.status).toBe('unavailable');
    expect(r.valveItem.status).toBe('unavailable');
    expect(r.phase.status).toBe('unavailable');
  });

  it('uses deterministic reason codes, not prose (§22)', () => {
    if (r.valveHero.status !== 'unavailable' || r.valveItem.status !== 'unavailable') throw new Error('x');
    expect(r.valveHero.reason).toBe('no_build_file');
    expect(r.valveItem.reason).toBe('hero_data_unavailable');
  });

  it('does NOT lower the STRATZ prior because Valve is silent', () => {
    expect(avail<{ purchases: number }>(r.itemPrior).value.purchases).toBeGreaterThan(0);
  });
});


describe('C. item absent from a KNOWN hero build (§26 B, §27 C)', () => {
  const r = getBuildPhasePrior(input({ itemId: WAND }));

  it('reports item evidence as AVAILABLE with present: false', () => {
    const v = avail<{ present: boolean; phases: unknown[] }>(r.valveItem);
    expect(r.valveHero.status).toBe('available');
    expect(v.value.present).toBe(false);
    expect(v.value.phases).toEqual([]);
  });

  it('is distinguishable from "Valve does not know the hero"', () => {
    const unknown = getBuildPhasePrior(input({ heroId: HERO_UNKNOWN, itemId: WAND }));
    expect(r.valveItem.status).toBe('available');
    expect(unknown.valveItem.status).toBe('unavailable');
  });

  it('reports phase unavailable with no_phase, not hero_data_unavailable', () => {
    if (r.phase.status !== 'unavailable') throw new Error('x');
    expect(r.phase.reason).toBe('no_phase');
  });
});

describe('D. item mapping unresolved (§27 D)', () => {
  it('reports item_not_in_catalogue for an id the catalogue lacks', () => {
    const r = getBuildPhasePrior(input({ itemId: 99999 }));
    if (r.valveItem.status !== 'unavailable') throw new Error('x');
    expect(r.valveItem.reason).toBe('item_not_in_catalogue');
  });
});

describe('E. timing unavailable (§27 E)', () => {
  const zeroStats = { 1: { 1: { [BF]: cell(0, [10]) } }, 2: { 1: { [BF]: cell(0, [10]) } } } as unknown as ItemStatsDataset;

  it('reports zero_purchases without inventing timing', () => {
    const r = getBuildPhasePrior(input({ itemStats: zeroStats }));
    if (r.timing.status !== 'unavailable') throw new Error('x');
    expect(r.timing.reason).toBe('zero_purchases');
  });

  it('reports no_stratz_cell when the lane has no data', () => {
    const r = getBuildPhasePrior(input({ itemStats: {} as unknown as ItemStatsDataset }));
    if (r.timing.status !== 'unavailable') throw new Error('x');
    expect(r.timing.reason).toBe('no_stratz_cell');
  });

  it('agreement goes unavailable when timing is missing', () => {
    const r = getBuildPhasePrior(input({ itemStats: zeroStats }));
    expect(avail<{ agreement: { decision: string } }>(r.phase).value.agreement.decision)
      .toBe('unavailable');
  });
});

describe('F/G. multiple and duplicate phases (§27 F, G, §16-17)', () => {
  const multi = input({
    valve: {
      heroes: {
        npc_dota_hero_known: {
          buildFile: 'b.txt',
          // The same item authored under three phases, one of them duplicated.
          phases: { Mid_Items: ['item_bfury', 'item_bfury'], Late_Items: ['item_bfury'], Other_Items: ['item_bfury'] },
        },
      },
    },
  });

  it('keeps every phase instead of picking one (§16)', () => {
    const v = avail<{ phases: string[]; present: boolean }>(getBuildPhasePrior(multi).valveItem);
    expect(v.value.phases).toEqual(['Mid_Items', 'Late_Items', 'Other_Items']);
    expect(v.value.present).toBe(true);
  });

  it('deduplicates repeated entries within a phase (§17)', () => {
    const v = avail<{ phases: string[] }>(getBuildPhasePrior(multi).valveItem);
    expect(v.value.phases.filter((p) => p === 'Mid_Items')).toHaveLength(1);
  });

  it('marks a multi-phase item as not phase-exclusive', () => {
    expect(avail<{ phaseExclusive: boolean }>(getBuildPhasePrior(multi).phase).value.phaseExclusive)
      .toBe(false);
  });
});

describe('H/I/J. phase vs timing decision (§27 H, I, J, §19-21)', () => {
  const at = (median: number) => ({ status: 'available' as const, value: { medianMinute: median } });

  it('supported when both sources agree', () => {
    expect(getPhaseAgreement(['Early_Game'], at(4)).decision).toBe('supported');
    expect(getPhaseAgreement(['Late_Items'], at(40)).decision).toBe('supported');
  });

  it('undecided in the middle band — not forced either way', () => {
    expect(getPhaseAgreement(['Mid_Items'], at(20)).decision).toBe('undecided');
    expect(getPhaseAgreement(['Other_Items'], at(24)).decision).toBe('undecided');
  });

  it('conflicting when the sources land on opposite ends', () => {
    expect(getPhaseAgreement(['Early_Game'], at(38)).decision).toBe('conflicting');
    expect(getPhaseAgreement(['Late_Items'], at(6)).decision).toBe('conflicting');
  });

  it('unavailable when either side has nothing to say', () => {
    expect(getPhaseAgreement([], at(10)).decision).toBe('unavailable');
    expect(getPhaseAgreement(['Late_Items'], { status: 'unavailable' }).decision).toBe('unavailable');
  });

  it('exposes the boundaries as explicit, documented constants (§19)', () => {
    expect(AGREEMENT_BOUNDARIES.earlyMedianBelow).toBe(15);
    expect(AGREEMENT_BOUNDARIES.lateMedianAtOrAbove).toBe(30);
  });

  it('returns a short deterministic detail, never prose (§22)', () => {
    const d = getPhaseAgreement(['Early_Game'], at(4)).detail;
    // Family-level, so a phase and its _Secondary sibling report the same way.
    expect(d).toBe('valve_early_timing_early');
    expect(d.length).toBeLessThan(60);
  });
});

describe('K/L. no enemy input, no slot input, no ordering (§27 K, L, §10-12)', () => {
  it('accepts exactly the documented input shape', () => {
    expect(Object.keys(input()).sort())
      .toEqual(['catalogue', 'heroId', 'heroes', 'itemId', 'itemStats', 'position', 'valve']);
  });

  it('emits no enemy, slot or ordering fields', () => {
    expect(Object.keys(getBuildPhasePrior(input())).sort())
      .toEqual(['heroId', 'itemId', 'itemPrior', 'phase', 'position', 'timing', 'valveHero', 'valveItem']);
  });

  it('is deterministic for the same input (§32)', () => {
    expect(JSON.stringify(getBuildPhasePrior(input()))).toBe(JSON.stringify(getBuildPhasePrior(input())));
  });
});

describe('D. the four evidence states preserve distinct causes (§19.1 §6, §7)', () => {
  /**
   * A corrupted catalogue where one id carries two different dnames. Exact
   * identity cannot be established, so the mapping is unresolved — which is a
   * different defect from the id being absent.
   */
  // The duplicate carries the SAME id as Battle Fury under a different dname,
  // so the id itself cannot be resolved to one Valve name.
  const ambiguousCatalogue = {
    ...catalogue,
    9999: { id: BF, dname: 'item_bfury_alt' },
  } as unknown as ItemCatalogue;

  it('A. hero unavailable -> phase keeps hero_data_unavailable', () => {
    const r = getBuildPhasePrior(input({ heroId: HERO_UNKNOWN }));
    if (r.valveItem.status !== 'unavailable' || r.phase.status !== 'unavailable') throw new Error('x');
    expect(r.valveItem.reason).toBe('hero_data_unavailable');
    expect(r.phase.reason).toBe('hero_data_unavailable');
  });

  it('B. hero known + item absent -> phase is no_phase, NOT hero_data_unavailable', () => {
    const r = getBuildPhasePrior(input({ itemId: WAND }));
    if (r.phase.status !== 'unavailable') throw new Error('x');
    expect(r.phase.reason).toBe('no_phase');
    expect(r.phase.reason).not.toBe('hero_data_unavailable');
  });

  it('C. item mapping unresolved -> the cause survives into phase', () => {
    const r = getBuildPhasePrior(input({ catalogue: ambiguousCatalogue }));
    if (r.valveHero.status !== 'available') throw new Error('hero must stay available');
    if (r.valveItem.status !== 'unavailable' || r.phase.status !== 'unavailable') throw new Error('x');
    expect(r.valveItem.reason).toBe('item_mapping_unresolved');
    // The whole point of §19.1 §5: a broken item identity must not be reported
    // as a missing hero.
    expect(r.phase.reason).toBe('item_mapping_unresolved');
    expect(r.phase.reason).not.toBe('hero_data_unavailable');
  });

  it('D. item not in catalogue -> the cause survives into phase', () => {
    const r = getBuildPhasePrior(input({ itemId: 99999 }));
    if (r.valveItem.status !== 'unavailable' || r.phase.status !== 'unavailable') throw new Error('x');
    expect(r.valveItem.reason).toBe('item_not_in_catalogue');
    expect(r.phase.reason).toBe('item_not_in_catalogue');
  });
});

describe('canonical Valve mapping helpers (§10, moved from the removed module)', () => {
  const cat = (id: number, dname: string) => ({ id, dname });
  const CAT = { 145: cat(145, 'item_bfury'), 75: cat(75, 'item_wraith_band') };

  it('resolves an exact dname match', () => {
    expect(buildValveItemMap(CAT).resolve('item_bfury')).toBe(145);
  });

  it('reports an unknown Valve name instead of dropping it silently', () => {
    const { report } = mapHeroItems({ phases: { Other_Items: ['item_not_real'] } }, buildValveItemMap(CAT));
    expect(report.unresolved).toEqual(['item_not_real']);
  });

  it('refuses to pick a side when two items share a dname', () => {
    const dup = { 1: cat(1, 'item_x'), 2: cat(2, 'item_x') };
    expect(buildValveItemMap(dup).resolve('item_x')).toBeNull();
  });

  it('keeps recipes out of the item namespace', () => {
    const { byItem, report } = mapHeroItems(
      { phases: { Early_Game: ['item_recipe_wraith_band', 'item_wraith_band'] } },
      buildValveItemMap(CAT),
    );
    expect(report.recipeLike).toEqual(['item_recipe_wraith_band']);
    expect([...byItem.keys()]).toEqual([75]);
  });

  it('merges an item Valve lists in several phases, in Valve order', () => {
    const { byItem } = mapHeroItems(
      { phases: { Mid_Items: ['item_bfury'], Other_Items: ['item_bfury'] } },
      buildValveItemMap(CAT),
    );
    expect(byItem.get(145)).toEqual(['Mid_Items', 'Other_Items']);
  });

  it('returns an empty map for an unknown hero instead of guessing', () => {
    const { byItem, report } = mapHeroItems(undefined, buildValveItemMap(CAT));
    expect(byItem.size).toBe(0);
    expect(report.resolved).toBe(0);
  });
});

describe('Valve evidence does not vary with position (§21)', () => {
  const valve = input({
    valve: { heroes: { npc_dota_hero_known: { buildFile: 'b.txt', phases: { Early_Game: ['item_bfury'] } } } },
  });
  const stats = { 1: { 1: { [BF]: cell(10000, [2]) }, 4: { [BF]: cell(10000, [2]) } } } as unknown as ItemStatsDataset;

  it('gives the same Valve answer on two different lanes', () => {
    const a = getBuildPhasePrior({ ...valve, position: 1, itemStats: stats });
    const b = getBuildPhasePrior({ ...valve, position: 4, itemStats: stats });
    const phases = (r: ReturnType<typeof getBuildPhasePrior>) =>
      r.phase.status === 'available' ? r.phase.value.phases : null;
    expect(phases(a)).toEqual(phases(b));
    expect(a.position).toBe(1);
    expect(b.position).toBe(4);
  });
});
