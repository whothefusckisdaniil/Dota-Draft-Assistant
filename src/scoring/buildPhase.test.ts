/**
 * Build-phase prior tests (ТЗ §26). All synthetic — no production data, no
 * Valve files, no network. The point is to pin the JOIN and the refusals, not
 * to re-measure the snapshot.
 */
import { describe, expect, it } from 'vitest';
import type { ItemPrior } from './itemPrior';
import {
  RESEARCH_AGREEMENT_BOUNDARIES,
  buildValveItemMap,
  classifyPhaseAgreement,
  getBuildPhasePrior,
  mapHeroItems,
  type CatalogEntry,
  type ValvePhaseData,
} from './buildPhase';

const cat = (id: number, dname: string, name = dname): CatalogEntry => ({ id, dname, name });
const CATALOGUE = {
  145: cat(145, 'item_bfury', 'Battle Fury'),
  75: cat(75, 'item_wraith_band', 'Wraith Band'),
  108: cat(108, 'item_ultimate_scepter', "Aghanim's Scepter"),
  44: cat(44, 'item_tango', 'Tango'),
};

/** Minimal ItemPrior: only the fields the build-phase module reads. */
function prior(id: number, name: string, median: number | null): ItemPrior {
  return {
    itemId: id, itemName: name, itemDname: '', itemImage: '', itemCost: 0,
    purchases: 1000, heroGames: 1000, wins: 500,
    purchaseEventsPerGame: 1, eventShare: 0.1,
    baselineIntensity: 0.1, smoothedIntensity: 0.1, lift: 1, score: 0.5,
    purchaseWinRate: 0.5,
    medianPurchaseMinute: median, p25PurchaseMinute: median, p75PurchaseMinute: median,
    earlyPurchaseShare: 0, midPurchaseShare: 0, latePurchaseShare: 0, veryLatePurchaseShare: 0,
    byMinute: median === null ? {} : { [median]: 1000 }, instances: { 0: 1000 },
  } as ItemPrior;
}

const valve = (heroes: ValvePhaseData['heroes']): ValvePhaseData => ({
  heroes,
  source: { repository: 'test/repo', sourceCommit: 'abcdef1234567890', isOfficialValveApi: false },
});

function run(priors: ItemPrior[], v: ValvePhaseData, key: string | null = 'npc_dota_hero_test') {
  return getBuildPhasePrior({
    heroId: 1, position: 1, priors, catalogue: CATALOGUE, valve: v, valveHeroKey: key,
  });
}

describe('Valve KV parsing and hero mapping (§26)', () => {
  it('maps hero + item -> phases, keeping Valve order', () => {
    const map = buildValveItemMap(CATALOGUE);
    const { byItem } = mapHeroItems(
      { phases: { Early_Game: ['item_wraith_band'], Late_Items: ['item_bfury'] } }, map);
    expect(byItem.get(75)).toEqual(['Early_Game']);
    expect(byItem.get(145)).toEqual(['Late_Items']);
  });

  it('merges an item that Valve lists in several phases', () => {
    const map = buildValveItemMap(CATALOGUE);
    const { byItem } = mapHeroItems(
      { phases: { Mid_Items: ['item_bfury'], Other_Items: ['item_bfury'] } }, map);
    expect(byItem.get(145)).toEqual(['Mid_Items', 'Other_Items']);
  });

  it('returns an empty map for an unknown hero instead of guessing', () => {
    const map = buildValveItemMap(CATALOGUE);
    const { byItem, report } = mapHeroItems(undefined, map);
    expect(byItem.size).toBe(0);
    expect(report.resolved).toBe(0);
  });
});

describe('item mapping and duplicates (§26)', () => {
  it('resolves an exact dname match', () => {
    expect(buildValveItemMap(CATALOGUE).resolve('item_bfury')).toBe(145);
  });

  it('reports an unknown Valve name instead of dropping it silently', () => {
    const map = buildValveItemMap(CATALOGUE);
    const { report } = mapHeroItems({ phases: { Other_Items: ['item_not_real'] } }, map);
    expect(report.unresolved).toEqual(['item_not_real']);
  });

  it('reports a duplicate catalogue dname as unresolvable rather than picking one', () => {
    const dup = { 1: cat(1, 'item_x', 'First'), 2: cat(2, 'item_x', 'Second') };
    expect(buildValveItemMap(dup).resolve('item_x')).toBeNull();
  });

  it('excludes recipes from the item namespace (§5)', () => {
    const map = buildValveItemMap(CATALOGUE);
    const { byItem, report } = mapHeroItems(
      { phases: { Early_Game: ['item_recipe_wraith_band', 'item_wraith_band'] } }, map);
    expect(report.recipeLike).toEqual(['item_recipe_wraith_band']);
    expect([...byItem.keys()]).toEqual([75]);
  });
});

describe('classifyPhaseAgreement — research only (§10)', () => {
  const { earlyMedianMax, lateMedianMin } = RESEARCH_AGREEMENT_BOUNDARIES;

  it('agrees when both sources say early', () => {
    expect(classifyPhaseAgreement(['Early_Game'], 2).type).toBe('agreement');
  });
  it('agrees when both sources say late', () => {
    expect(classifyPhaseAgreement(['Late_Items'], 35).type).toBe('agreement');
  });
  it('reports a conflict instead of correcting it', () => {
    expect(classifyPhaseAgreement(['Late_Items'], earlyMedianMax - 1).type).toBe('conflict');
    expect(classifyPhaseAgreement(['Early_Game'], lateMedianMin + 10).type).toBe('conflict');
  });
  it('is undecided in the middle band, not a guess', () => {
    expect(classifyPhaseAgreement(['Mid_Items'], 20).type).toBe('unknown');
  });
  it('is unknown when either side has nothing to say', () => {
    expect(classifyPhaseAgreement([], 10).type).toBe('unknown');
    expect(classifyPhaseAgreement(['Late_Items'], null).type).toBe('unknown');
  });

describe('getBuildPhasePrior — the permitted join (§7, §21)', () => {
  it('joins on hero and item only; position comes from STRATZ alone', () => {
    const v = valve({ npc_dota_hero_test: { phases: { Late_Items: ['item_bfury'] } } });
    const { rows } = run([prior(145, 'Battle Fury', 34)], v);
    expect(rows[0].valve?.phases).toEqual(['Late_Items']);
    expect(rows[0].position).toBe(1);
    expect(rows[0].valve?.source).toContain('test/repo');
  });

  it('gives the same Valve answer for two different positions', () => {
    const v = valve({ npc_dota_hero_test: { phases: { Early_Game: ['item_wraith_band'] } } });
    const a = run([prior(75, 'Wraith Band', 2)], v).rows[0];
    const b = getBuildPhasePrior({
      heroId: 1, position: 4, priors: [prior(75, 'Wraith Band', 2)],
      catalogue: CATALOGUE, valve: v, valveHeroKey: 'npc_dota_hero_test',
    }).rows[0];
    expect(a.valve?.phases).toEqual(b.valve?.phases);
    expect(a.position).toBe(1);
    expect(b.position).toBe(4);
  });

  it('leaves valve undefined when the hero has no build file', () => {
    const { rows } = run([prior(145, 'Battle Fury', 20)], valve({}));
    expect(rows[0].valve).toBeUndefined();
    expect(rows[0].phaseAgreement?.type).toBe('unknown');
  });

  it('does not invent an item Valve never mentions', () => {
    const v = valve({ npc_dota_hero_test: { phases: { Other_Items: ['item_tango'] } } });
    const rows = run([prior(145, 'Battle Fury', 20), prior(44, 'Tango', 1)], v).rows;
    expect(rows.find((r) => r.itemId === 44)?.valve).toBeDefined();
    expect(rows.find((r) => r.itemId === 145)?.valve).toBeUndefined();
  });

  it('survives a prior with no timing histogram (§26)', () => {
    const v = valve({ npc_dota_hero_test: { phases: { Late_Items: ['item_bfury'] } } });
    const { rows } = run([prior(145, 'Battle Fury', null)], v);
    expect(rows[0].timing.median).toBeNull();
    expect(rows[0].phaseAgreement?.type).toBe('unknown');
  });

  it('never branches on the item name (§27)', () => {
    const v = valve({ npc_dota_hero_test: { phases: { Early_Game: ['item_wraith_band'] } } });
    const a = run([prior(75, 'Wraith Band', 2)], v).rows[0];
    const b = run([prior(75, 'Completely Different Name', 2)], v).rows[0];
    expect(a.valve?.phases).toEqual(b.valve?.phases);
    expect(a.phaseAgreement?.type).toBe(b.phaseAgreement?.type);
  });
});

});
