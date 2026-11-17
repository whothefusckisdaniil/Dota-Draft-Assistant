import { describe, expect, it } from 'vitest';
import { accumulateHero, addAllRanks, buildHeroQuery, summarizeBuild, validateBuilds } from './builds.mjs';
import { abilityDisplayName, rebuildReason } from '../update-builds-stratz.mjs';

const B = ['HERALD_GUARDIAN', 'DIVINE_IMMORTAL'];
const items = new Map<number, { qual: string; cost: number }>([
  [44, { qual: 'consumable', cost: 90 }],
  [36, { qual: 'common', cost: 460 }],
  [1, { qual: 'component', cost: 2250 }],
  [254, { qual: 'rare', cost: 2150 }],
  [214, { qual: 'rare', cost: 900 }],
]);
const ctx = {
  abilityIds: [10, 11, 12, 13],
  talents: [{ id: 90, level: 1 }, { id: 91, level: 1 }],
  items,
};

/** One bracket/position response: 1 000 matches (every ability first taken 1 000×). */
function response(bracket: string, pos: number, scale = 1) {
  const k = `${bracket}_${pos}`;
  const g = (n: number) => n * scale;
  return {
    data: {
      heroStats: {
        [`s_${k}`]: [
          { itemId: 44, instance: 0, wasGiven: false, matchCount: g(900), winCount: g(450) },
          { itemId: 44, instance: 1, wasGiven: false, matchCount: g(600), winCount: g(300) },
          { itemId: 44, instance: 0, wasGiven: true, matchCount: g(500), winCount: g(250) },
          { itemId: 36, instance: 0, wasGiven: false, matchCount: g(100), winCount: g(50) },
        ],
        [`b_${k}`]: [{ itemId: 214, timeAverage: 420, matchCount: g(950), winCount: g(480) }],
        [`f_${k}`]: [
          { itemId: 36, instance: 0, time: 5, matchCount: g(600), winCount: g(300) },
          { itemId: 1, instance: 0, time: 15, matchCount: g(400), winCount: g(220) },
          { itemId: 1, instance: 0, time: 20, matchCount: g(500), winCount: g(260) },
          { itemId: 1, instance: 1, time: 40, matchCount: g(50), winCount: g(20) },
          { itemId: 254, instance: 0, time: 25, matchCount: g(200), winCount: g(110) },
          { itemId: 214, instance: 0, time: 7, matchCount: g(950), winCount: g(480) },
          { itemId: 44, instance: 0, time: 1, matchCount: g(300), winCount: g(150) },
        ],
        [`t_${k}`]: [
          { abilityId: 90, matchCount: g(700), winCount: g(400) },
          { abilityId: 91, matchCount: g(300), winCount: g(140) },
        ],
        [`x_${k}`]: [
          { abilityId: 10, level: 7, matchCount: g(800) },
          { abilityId: 11, level: 12, matchCount: g(700) },
          { abilityId: 12, level: 9, matchCount: g(750) },
        ],
        [`n_${k}`]: [10, 11, 12, 13].map((abilityId) => ({ abilityId, matchCount: g(1000) })),
      },
    },
  };
}

describe('hero builds from STRATZ purchase statistics', () => {
  it('asks for every rank × position in one request', () => {
    const q = buildHeroQuery(26, 1000, [4, 5], B);
    expect(q).toContain('s_DIVINE_IMMORTAL_5: itemStartingPurchase(heroId: 26, week: 1000, bracketBasicIds: [DIVINE_IMMORTAL], positionIds: [POSITION_5])');
    expect(q.match(/itemFullPurchase/g)).toHaveLength(4);
    expect(q).toContain('matchLimit: 10');
  });

  it('summarises shares against the ability-based match count', () => {
    const raw = accumulateHero({}, response('DIVINE_IMMORTAL', 5), [5], ['DIVINE_IMMORTAL']);
    const b = summarizeBuild(raw[5].DIVINE_IMMORTAL, ctx)!;
    expect(b.m).toBe(1000);
    // gifted tangos do not count; 60% buy a second one → ×2
    expect(b.start).toEqual([[44, 0.9, 2]]);
    expect(b.boots).toEqual([[214, 0.95, 7]]);
    // consumables and boots are not items; first copies only; sorted by minute
    expect(b.items.map((x) => x[0])).toEqual([36, 1, 254]);
    expect(b.items[1]).toEqual([1, 0.9, 20, 53.3]);
    expect(b.talents).toEqual([[10, [90, 0.7, 57.1], [91, 0.3, 46.7]]]);
    expect(b.skills.map((s) => s[0])).toEqual([10, 12, 11]);
    expect(b.low).toBe(false);
  });

  it('adds all ranks as the sum of the brackets', () => {
    const raw = {};
    accumulateHero(raw, response('HERALD_GUARDIAN', 5), [5], B);
    accumulateHero(raw, response('DIVINE_IMMORTAL', 5, 3), [5], B, 0.5);
    addAllRanks(raw, B);
    const all = summarizeBuild((raw as Record<number, Record<string, never>>)[5].ALL, ctx)!;
    expect(all.m).toBe(2500);
    expect(all.start[0][1]).toBe(0.9);
  });

  it('rejects a broken build set', () => {
    expect(() => validateBuilds({}, { minHeroes: 1 })).toThrow(/only 0 heroes/);
    const raw = accumulateHero({}, response('DIVINE_IMMORTAL', 5), [5], ['DIVINE_IMMORTAL']);
    const good = summarizeBuild(raw[5].DIVINE_IMMORTAL, ctx)!;
    expect(() => validateBuilds({ 26: { heroId: 26, positions: { 5: { ALL: good } } } }, { minHeroes: 1 })).not.toThrow();
    const bad = { ...good, items: [[1, 1.7, 20, 50]] };
    expect(() => validateBuilds({ 26: { heroId: 26, positions: { 5: { ALL: bad } } } }, { minHeroes: 1 })).toThrow(/share 1.7/);
  });

  it('rebuilds weekly, on a new patch or a roster change, otherwise not', () => {
    const now = new Date('2026-11-17T05:00:00Z');
    const meta = { latestPatch: '7.40' };
    const index = { patch: '7.40', generatedAt: '2026-11-14T05:00:00Z', heroes: [1, 2] };
    expect(rebuildReason({ index, meta, heroIds: [1, 2], now })).toBeNull();
    expect(rebuildReason({ index: null, meta, heroIds: [1, 2], now })).toBe('NO_BUILDS');
    expect(rebuildReason({ index, meta: { latestPatch: '7.41' }, heroIds: [1, 2], now })).toBe('NEW_PATCH');
    expect(rebuildReason({ index: { ...index, generatedAt: '2026-11-10T05:00:00Z' }, meta, heroIds: [1, 2], now })).toBe('WEEKLY');
    expect(rebuildReason({ index, meta, heroIds: [1, 2, 3], now })).toBe('ROSTER_CHANGED');
    expect(rebuildReason({ index, meta, heroIds: [1, 2], now, force: true })).toBe('FORCE');
  });
});

describe('ability / talent display names', () => {
  it('never shows a raw special_bonus key', () => {
    expect(abilityDisplayName({ key: 'special_bonus_unique_lion_5', stratz: '-2.0s Hex Cooldown', openDota: 'x' })).toBe('-2.0s Hex Cooldown');
    expect(abilityDisplayName({ key: 'special_bonus_unique_lion_5', stratz: 'special_bonus_unique_lion_5', openDota: '-{s:bonus_AbilityCooldown}s Hex Cooldown' })).toBe('Hex Cooldown');
    expect(abilityDisplayName({ key: 'special_bonus_unique_dazzle_nothl_projection_duration', stratz: null, openDota: undefined })).toBe('Dazzle nothl projection duration');
  });
});
