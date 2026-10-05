import { describe, it, expect } from 'vitest';
import {
  CONFIDENCE, SEMANTICALLY_OPAQUE,
  normalizeAbilityProperties, valueCoverage, categoricalDistribution,
  numericDistribution, shareWithDenominator, heroFeatureProfile,
  profileSignature, featureOverlap, fieldConfidence,
} from './stratz-ability-properties-lib.mjs';

/** The real GraphQL shape: properties live under `stat`, not at the top level. */
const ab = (id, stat) => ({ id, name: `a${id}`, stat });

describe('normalizeAbilityProperties', () => {
  it('reads properties from ability.stat, not the top level', () => {
    const n = normalizeAbilityProperties(ab(1, { unitDamageType: 2, dispellable: 'YES' }));
    expect(n.unitDamageType).toBe(2);
    expect(n.dispellable).toBe('YES');
  });

  it('a top-level property must NOT be picked up (regression)', () => {
    const n = normalizeAbilityProperties({ id: 1, name: 'a', unitDamageType: 2, stat: {} });
    expect(n.unitDamageType).toBeNull();
  });

  it('rejects entries without an id and preserves arrays', () => {
    expect(normalizeAbilityProperties({ stat: {} })).toBeNull();
    expect(normalizeAbilityProperties(null)).toBeNull();
    expect(normalizeAbilityProperties(ab(1, { damage: [0, 10] })).damage).toEqual([0, 10]);
  });
});

describe('valueCoverage', () => {
  it('separates null from false and from zero', () => {
    const rows = [ab(1, { isInnate: false }), ab(2, { isInnate: true }), ab(3, {})];
    const c = valueCoverage(normalizeAll(rows), 'isInnate');
    expect(c.nonNull).toBe(2);
    expect(c.null).toBe(1);
    expect(c.values).toEqual(['false', 'true']);
  });

  it('damage = 0 is present, not absent', () => {
    const rows = [ab(1, { damage: [0] }), ab(2, {})];
    const c = valueCoverage(normalizeAll(rows), 'damage');
    expect(c.nonNull).toBe(1);
    expect(c.null).toBe(1);
    expect(c.values).toEqual(['[0]']);
  });

  it('counts [0,0,0,0] and [0] as distinct values', () => {
    const c = valueCoverage(normalizeAll([ab(1, { damage: [0, 0, 0, 0] }), ab(2, { damage: [0] })]), 'damage');
    expect(c.distinct).toBe(2);
  });
});

describe('categoricalDistribution', () => {
  it('orders by frequency then value, and keeps unknown out of the denominator', () => {
    const d = categoricalDistribution(normalizeAll([ab(1, { dispellable: 'YES' }), ab(2, { dispellable: 'NO' }), ab(3, { dispellable: 'NO' }), ab(4, {})]), 'dispellable');
    expect(d.entries.map((e) => e.value)).toEqual(['NO', 'YES']);
    expect(d.entries[0].count).toBe(2);
    expect(d.known).toBe(3);
    expect(d.unknown).toBe(1);
    expect(d.entries[0].share).toBeCloseTo(2 / 3);
  });
});

describe('numericDistribution', () => {
  it('sorts before percentiling and ignores non-numeric values', () => {
    const rows = normalizeAll([ab(1, { castRange: [900] }), ab(2, { castRange: [100] }), ab(3, { castRange: [500] }), ab(4, {})]);
    const d = numericDistribution(rows.flatMap((r) => (Array.isArray(r.castRange) ? r.castRange.map((v) => ({ castRange: v })) : [])), 'castRange');
    expect(d.min).toBe(100);
    expect(d.max).toBe(900);
    expect(d.n).toBe(3);
    expect(d.percentiles.p50).toBeGreaterThanOrEqual(100);
  });

  it('returns an empty shape instead of dividing by zero', () => {
    const d = numericDistribution([], 'castRange');
    expect(d.n).toBe(0);
    expect(d.percentiles).toEqual({});
  });
});

describe('shareWithDenominator', () => {
  it('divides by known only, and never by zero', () => {
    expect(shareWithDenominator(5, 8).share).toBeCloseTo(0.625);
    expect(shareWithDenominator(0, 0).share).toBeNull();
  });
});

describe('heroFeatureProfile', () => {
  const FEATURES = {
    HAS_DISPELLABLE: { known: (r) => r.dispellable !== null, select: (r) => r.dispellable === 'YES' },
    HAS_PHYSICAL: { opaque: true, known: (r) => r.unitDamageType !== null, select: () => false },
  };

  it('unknown never becomes false: unknown is excluded from the denominator', () => {
    const p = heroFeatureProfile('X', [ab(1, { dispellable: 'YES' }), ab(2, { dispellable: 'NO' }), ab(3, {})], FEATURES);
    expect(p.features.HAS_DISPELLABLE.denominator).toBe(2);
    expect(p.features.HAS_DISPELLABLE.unknown).toBe(1);
    expect(p.features.HAS_DISPELLABLE.share).toBeCloseTo(0.5);
  });

  it('an opaque feature is SCHEMA_ONLY even when values are present', () => {
    const p = heroFeatureProfile('X', [ab(1, { unitDamageType: 1 })], FEATURES);
    expect(p.features.HAS_PHYSICAL.state).toBe(CONFIDENCE.SCHEMA_ONLY);
  });

  it('is order-independent: the same abilities in any order give an identical profile', () => {
    const abs = [ab(1, { dispellable: 'YES' }), ab(2, { dispellable: 'NO' }), ab(3, { dispellable: 'YES' }), ab(4, {})];
    const a = heroFeatureProfile('X', abs, FEATURES);
    const b = heroFeatureProfile('X', [...abs].reverse(), FEATURES);
    expect(profileSignature(a)).toBe(profileSignature(b));
    expect(a.features.HAS_DISPELLABLE).toEqual(b.features.HAS_DISPELLABLE);
  });
});

describe('featureOverlap', () => {
  it('counts both/only/neither and returns a null jaccard when empty', () => {
    const mk = (x, y) => ({ features: { X: { numerator: x }, Y: { numerator: y } } });
    const o = featureOverlap([mk(1, 1), mk(1, 0), mk(0, 1), mk(0, 0)], 'X', 'Y');
    expect([o.both, o.onlyA, o.onlyB, o.neither]).toEqual([1, 1, 1, 1]);
    expect(o.jaccard).toBeCloseTo(1 / 3);
    expect(featureOverlap([], 'X', 'Y').jaccard).toBeNull();
  });
});

describe('opaque set', () => {
  it('covers only integer-encoded fields with no published mapping', () => {
    // spellImmunity is included: it is an integer enum too, and it is fetched
    // for reference only, never as a candidate feature.
    expect([...SEMANTICALLY_OPAQUE].sort()).toEqual(['spellImmunity', 'unitDamageType', 'unitTargetFlags', 'unitTargetTeam']);
  });
});

describe('fieldConfidence', () => {
  const cov = (over = {}) => ({ field: 'f', total: 100, nonNull: 100, null: 0, nullPct: 0, distinct: 34, ...over });

  it('duration known for every hero is UNINFORMATIVE, never FULLY_POPULATED', () => {
    // The exact §31.1 regression: 34 distinct values, but the derived feature is
    // true for every hero, so it separates nobody.
    const c = fieldConfidence(cov(), { heroesWith: 127, heroesWithout: 0 }, false);
    expect(c).toBe(CONFIDENCE.UNINFORMATIVE);
    expect(c).not.toBe(CONFIDENCE.FULLY_POPULATED);
  });

  it('a populated feature that does separate heroes is FULLY_POPULATED', () => {
    expect(fieldConfidence(cov(), { heroesWith: 120, heroesWithout: 7 }, false)).toBe(CONFIDENCE.FULLY_POPULATED);
  });

  it('substantial unknowns downgrade to PARTIALLY_POPULATED', () => {
    const c = fieldConfidence(cov({ nullPct: 96.8, nonNull: 28, null: 72 }), { heroesWith: 15, heroesWithout: 112 }, false);
    expect(c).toBe(CONFIDENCE.PARTIALLY_POPULATED);
  });

  it('an opaque field never reaches FULLY_POPULATED even when it separates heroes', () => {
    const c = fieldConfidence(cov(), { heroesWith: 100, heroesWithout: 27 }, true);
    expect(c).toBe(CONFIDENCE.PARTIALLY_POPULATED);
  });

  it('no data at all is SCHEMA_ONLY', () => {
    expect(fieldConfidence(cov({ nonNull: 0, nullPct: 100 }), null, false)).toBe(CONFIDENCE.SCHEMA_ONLY);
    expect(fieldConfidence(null, null, false)).toBe(CONFIDENCE.SCHEMA_ONLY);
  });

  it('absence of evidence is not evidence: missing discrimination -> UNINFORMATIVE', () => {
    expect(fieldConfidence(cov(), null, false)).toBe(CONFIDENCE.UNINFORMATIVE);
  });
});

function normalizeAll(rows) {
  return rows.map(normalizeAbilityProperties).filter(Boolean);
}