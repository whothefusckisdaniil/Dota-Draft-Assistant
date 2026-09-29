/**
 * Tests for the pure maths behind ТЗ §24.
 *
 * Guard rails worth pinning: a value is only a position if it is an integer in
 * 1..5 (never a truthy 0 or a 6), agreement is a FIELD AGREEMENT and never
 * "accuracy", and a structurally broken match is flagged rather than averaged
 * into the result.
 */
import { describe, expect, it } from 'vitest';
import {
  confusionMatrix,
  describeValue,
  distributionDelta,
  fieldCoverage,
  heroAmbiguity,
  isValidPosition,
  teamStructure,
  valueDistribution,
} from './public-position-lib.mjs';

describe('isValidPosition — 1..5, integers only (§6)', () => {
  it('accepts 1..5', () => {
    for (const v of [1, 2, 3, 4, 5]) expect(isValidPosition(v), String(v)).toBe(true);
  });

  it('rejects 0, 6 and above — never normalised into a position', () => {
    for (const v of [0, 6, 7, -1, -3]) expect(isValidPosition(v), String(v)).toBe(false);
  });

  it('rejects null, undefined and non-numbers', () => {
    for (const v of [null, undefined, '2', 'x', NaN, {}]) expect(isValidPosition(v)).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(isValidPosition(2.5)).toBe(false);
    expect(isValidPosition(1.0000001)).toBe(false);
  });
});

describe('describeValue — classify, never silently repair (§6)', () => {
  it('labels each category distinctly', () => {
    expect(describeValue(3)).toBe('valid(3)');
    expect(describeValue(0)).toBe('out_of_range(0)');
    expect(describeValue(6)).toBe('out_of_range(6)');
    expect(describeValue(2.5)).toBe('non_integer(2.5)');
    expect(describeValue(null)).toBe('missing');
    expect(describeValue(undefined)).toBe('missing');
  });
});

describe('fieldCoverage — present vs VALID are different counts (§8)', () => {
  it('separates "field exists" from "field is a usable position"', () => {
    const c = fieldCoverage([{ lane_role: 1 }, { lane_role: 0 }, { lane_role: 6 }, { lane_role: null }], 'lane_role');
    expect(c.total).toBe(4);
    expect(c.present).toBe(3); // 1, 0 and 6 are all non-null
    expect(c.valid).toBe(1);   // only 1
  });

  it('handles an empty corpus', () => {
    expect(fieldCoverage([], 'lane_role')).toEqual({ total: 0, present: 0, valid: 0, ratio: 0 });
  });
});

describe('confusionMatrix — FIELD AGREEMENT, not accuracy (§5)', () => {
  it('counts agreement only over rows where both fields exist', () => {
    const c = confusionMatrix([
      { lane_role: 1, position_est: 1 },     // same
      { lane_role: 2, position_est: 2 },     // same
      { lane_role: 3, position_est: 4 },     // different
      { lane_role: 1, position_est: null },  // only lane_role
      { lane_role: null, position_est: 3 },  // only position_est
      { lane_role: null, position_est: null }, // neither
    ]);
    expect(c.both).toBe(3);
    expect(c.same).toBe(2);
    expect(c.onlyA).toBe(1);
    expect(c.onlyB).toBe(1);
    expect(c.neither).toBe(1);
    expect(c.agreement).toBeCloseTo(2 / 3, 10);
  });

  it('returns null agreement rather than a fake 0 or 1 when there is no overlap', () => {
    const c = confusionMatrix([{ lane_role: 1, position_est: null }]);
    expect(c.both).toBe(0);
    expect(c.agreement).toBeNull();
  });


describe('teamStructure — 5 per side or flagged (§10)', () => {
  const mk = (slots) => slots.map((s) => ({ player_slot: s }));

  it('flags a match with the wrong player count', () => {
    expect(teamStructure(mk([0, 1, 2, 3, 4, 128, 129, 130, 131])).sane).toBe(false);
  });

  it('recognises a correct 10-player, 5-per-side match', () => {
    const s = teamStructure(mk([0, 1, 2, 3, 4, 128, 129, 130, 131, 132]));
    expect(s).toEqual({ total: 10, radiant: 5, dire: 5, sane: true });
  });

  it('flags an unbalanced split', () => {
    expect(teamStructure(mk([0, 1, 2, 3, 4, 5, 6, 128, 129, 130])).sane).toBe(false);
  });
});

describe('valueDistribution — outliers bucketed, never dropped (§6)', () => {
  it('splits valid values from outliers and missing', () => {
    const d = valueDistribution(
      [{ lane_role: 1 }, { lane_role: 1 }, { lane_role: 5 }, { lane_role: 0 }, { lane_role: null }],
      'lane_role',
    );
    expect(d.valid).toEqual({ 1: 2, 5: 1 });
    expect(d.outliers).toEqual({ 'out_of_range(0)': 1 });
    expect(d.missing).toBe(1);
  });
});

describe('heroAmbiguity — flex heroes are visible (§13)', () => {
  it('marks a hero seen on several positions as ambiguous', () => {
    const out = heroAmbiguity([
      { hero_id: 1, lane_role: 1, position_est: 1 },
      { hero_id: 1, lane_role: 3, position_est: 3 },
      { hero_id: 2, lane_role: 2, position_est: 2 },
    ], [1, 2]);
    expect(out[0].heroId).toBe(1);
    expect(out[0].laneRoleAmbiguous).toBe(true);
    expect(out[0].laneRoleValues).toEqual([1, 3]);
    expect(out[1].laneRoleAmbiguous).toBe(false);
  });

  it('ignores invalid values when counting distinct positions', () => {
    const out = heroAmbiguity([{ hero_id: 1, lane_role: 0, position_est: 6 }], [1]);
    expect(out[0].laneRoleValues).toEqual([]);
    expect(out[0].laneRoleAmbiguous).toBe(false);
  });
});

describe('distributionDelta — temporal drift is measurable (§14)', () => {
  it('reports a share difference', () => {
    const d = distributionDelta({ 1: 50, 3: 50 }, { 1: 20, 3: 80 });
    const one = d.find((x) => x.value === 1);
    const three = d.find((x) => x.value === 3);
    expect(one.shareFirst).toBeCloseTo(0.5, 10);
    expect(one.delta).toBeCloseTo(0.3, 10);
    expect(three.delta).toBeCloseTo(-0.3, 10);
  });

  it('handles an empty half without producing NaN', () => {
    const d = distributionDelta({}, { 1: 10 });
    expect(d[0].shareFirst).toBeNull();
    expect(d[0].delta).toBeNull();
  });
});

  it('records off-diagonal cells so disagreement is visible, not just counted', () => {
    const c = confusionMatrix([
      { lane_role: 1, position_est: 1 },
      { lane_role: 2, position_est: 3 },
      { lane_role: 2, position_est: 3 },
    ]);
    expect(c.matrix['2|3']).toBe(2);
    expect(c.matrix['1|1']).toBe(1);
  });
});
