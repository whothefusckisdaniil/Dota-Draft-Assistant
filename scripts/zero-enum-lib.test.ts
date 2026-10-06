import { describe, it, expect } from 'vitest';
import {
  STATES, COMPAT, VERDICTS,
  semanticState, classifyZeroCompatibility,
  damageEvidenceSummary, targetEvidenceSummary,
  deterministicSample, heroConcentration,
  zeroVerdict, summarizeClassifications,
} from './zero-enum-lib.mjs';

describe('semanticState — enum lookup, no data (§14)', () => {
  it('raw zero on both dimensions is ENUM_NONE', () => {
    expect(semanticState('unitDamageType', 0)).toEqual({ state: STATES.ENUM_NONE, enumName: 'NONE' });
    expect(semanticState('unitTargetTeam', 0)).toEqual({ state: STATES.ENUM_NONE, enumName: 'NONE' });
  });

  it('enum NONE != missing: they are different states', () => {
    const missing = semanticState('unitDamageType', null);
    const none = semanticState('unitDamageType', 0);
    expect(missing.state).toBe(STATES.FIELD_MISSING);
    expect(none.state).toBe(STATES.ENUM_NONE);
    expect(missing.state).not.toBe(none.state);
  });

  it('missing field != raw zero: undefined behaves like null', () => {
    expect(semanticState('unitTargetTeam', undefined).state).toBe(STATES.FIELD_MISSING);
    expect(semanticState('unitTargetTeam', null).state).not.toBe(STATES.ENUM_NONE);
  });

  it('raw 4 target team -> CUSTOM candidate', () => {
    const s = semanticState('unitTargetTeam', 4);
    expect(s.state).toBe(STATES.ENUM_NAMED);
    expect(s.enumName).toBe('CUSTOM');
  });

  it('non-zero named values resolve through the enum', () => {
    expect(semanticState('unitDamageType', 1).enumName).toBe('PHYSICAL');
    expect(semanticState('unitDamageType', 2).enumName).toBe('MAGICAL');
    expect(semanticState('unitDamageType', 4).enumName).toBe('PURE');
    expect(semanticState('unitTargetTeam', 1).enumName).toBe('FRIENDLY');
    expect(semanticState('unitTargetTeam', 2).enumName).toBe('ENEMY');
    expect(semanticState('unitTargetTeam', 3).enumName).toBe('BOTH');
  });

  it('raw unknown -> UNKNOWN', () => {
    expect(semanticState('unitDamageType', 3).state).toBe(STATES.SEMANTIC_UNKNOWN);
    expect(semanticState('unitTargetTeam', 5).state).toBe(STATES.SEMANTIC_UNKNOWN);
    expect(semanticState('unitTargetTeam', 99).state).toBe(STATES.SEMANTIC_UNKNOWN);
  });
});

describe('classifyZeroCompatibility — §13B row checks', () => {
  it('zero + no damage -> compatible candidate', () => {
    expect(classifyZeroCompatibility({ dimension: 'unitDamageType', raw: 0, damage: [0, 0, 0, 0] }))
      .toBe(COMPAT.COMPATIBLE);
    expect(classifyZeroCompatibility({ dimension: 'unitDamageType', raw: 0, damage: null }))
      .toBe(COMPAT.COMPATIBLE);
  });

  it('zero + positive damage -> conflict', () => {
    expect(classifyZeroCompatibility({ dimension: 'unitDamageType', raw: 0, damage: [100, 200, 300, 400] }))
      .toBe(COMPAT.CONFLICT);
    expect(classifyZeroCompatibility({ dimension: 'unitDamageType', raw: 0, damage: 50 }))
      .toBe(COMPAT.CONFLICT);
  });

  it('zero + unit target -> conflict', () => {
    expect(classifyZeroCompatibility({
      dimension: 'unitTargetTeam', raw: 0,
      behavior: ['Unit Target'], targetType: 'Hero,Basic',
    })).toBe(COMPAT.CONFLICT);
  });

  it('zero + no target -> compatible candidate', () => {
    expect(classifyZeroCompatibility({
      dimension: 'unitTargetTeam', raw: 0,
      behavior: 'No Target', targetType: null,
    })).toBe(COMPAT.COMPATIBLE);
    expect(classifyZeroCompatibility({
      dimension: 'unitTargetTeam', raw: 0,
      behavior: ['Passive'], targetType: '',
    })).toBe(COMPAT.COMPATIBLE);
  });

  it('an external label on a raw-zero row is a conflict, both dimensions', () => {
    expect(classifyZeroCompatibility({ dimension: 'unitDamageType', raw: 0, damage: null, externalLabel: 'Magical' }))
      .toBe(COMPAT.CONFLICT);
    expect(classifyZeroCompatibility({ dimension: 'unitTargetTeam', raw: 0, behavior: 'No Target', externalLabel: 'Enemy' }))
      .toBe(COMPAT.CONFLICT);
    expect(classifyZeroCompatibility({ dimension: 'unitDamageType', raw: 0, externalLabel: [] }))
      .toBe(COMPAT.COMPATIBLE);
  });

  it('unit target with no behaviour available is inconclusive, not compatible', () => {
    expect(classifyZeroCompatibility({ dimension: 'unitTargetTeam', raw: 0, behavior: null, targetType: null }))
      .toBe(COMPAT.INCONCLUSIVE);
  });

  it('unit target aimed only at trees is inconclusive, not a conflict', () => {
    expect(classifyZeroCompatibility({
      dimension: 'unitTargetTeam', raw: 0,
      behavior: ['Unit Target', 'Hidden', 'AOE'], targetType: 'Tree',
    })).toBe(COMPAT.INCONCLUSIVE);
  });

  it('a missing raw value is FIELD_MISSING, never a zero classification', () => {
    expect(classifyZeroCompatibility({ dimension: 'unitDamageType', raw: null, damage: null }))
      .toBe(COMPAT.FIELD_MISSING);
    expect(classifyZeroCompatibility({ dimension: 'unitTargetTeam', raw: undefined, behavior: null }))
      .toBe(COMPAT.FIELD_MISSING);
  });

  it('non-zero rows are out of scope for the zero check', () => {
    expect(classifyZeroCompatibility({ dimension: 'unitDamageType', raw: 2, damage: [100] }))
      .toBe(COMPAT.NOT_APPLICABLE);
    expect(classifyZeroCompatibility({ dimension: 'unitTargetTeam', raw: 4, behavior: ['Unit Target'] }))
      .toBe(COMPAT.NOT_APPLICABLE);
  });
});

describe('summaries — explicit denominators (§3, §7)', () => {
  it('damageEvidenceSummary splits positive / zero / unknown with one denominator', () => {
    const s = damageEvidenceSummary([
      { damage: [100, 200] },
      { damage: [0, 0] },
      { damage: null },
      { damage: 0 },
    ]);
    expect(s.total).toBe(4);
    expect(s.damage_known_positive).toEqual({ count: 1, denominator: 4, pct: 25 });
    expect(s.damage_known_zero).toEqual({ count: 2, denominator: 4, pct: 50 });
    expect(s.damage_unknown).toEqual({ count: 1, denominator: 4, pct: 25 });
  });

  it('targetEvidenceSummary buckets rows by the §13B check', () => {
    const s = targetEvidenceSummary([
      { behavior: 'No Target', targetType: null },
      { behavior: ['Unit Target'], targetType: 'Hero' },
      { behavior: null, targetType: null },
    ]);
    expect(s.total).toBe(3);
    expect(s.non_unit_target.count).toBe(1);
    expect(s.unit_target_conflict.count).toBe(1);
    expect(s.inconclusive.count).toBe(1);
  });

  it('identical output for shuffled row order', () => {
    const rows = [
      { damage: [100] }, { damage: null }, { damage: [0, 0] }, { damage: [0, 5] },
    ];
    const a = damageEvidenceSummary(rows);
    const b = damageEvidenceSummary([...rows].reverse());
    expect(b).toEqual(a);
  });

  it('empty input reports zero shares instead of NaN', () => {
    const s = damageEvidenceSummary([]);
    expect(s.total).toBe(0);
    expect(s.damage_known_positive.pct).toBeNull();
  });
});

describe('deterministicSample (§9)', () => {
  const rows = [
    { abilityKey: 'zzz' }, { abilityKey: 'aaa' }, { abilityKey: 'mmm' }, { abilityKey: 'bbb' },
  ];

  it('takes the first N after sorting by abilityKey', () => {
    const s = deterministicSample(rows, 3);
    expect(s.map((r) => r.abilityKey)).toEqual(['aaa', 'bbb', 'mmm']);
  });

  it('is independent of input order', () => {
    expect(deterministicSample([...rows].reverse(), 2).map((r) => r.abilityKey))
      .toEqual(deterministicSample(rows, 2).map((r) => r.abilityKey));
  });

  it('does not mutate the input and clamps n', () => {
    const before = rows.map((r) => r.abilityKey).join(',');
    deterministicSample(rows, 99);
    expect(rows.map((r) => r.abilityKey).join(',')).toBe(before);
    expect(deterministicSample([], 5)).toEqual([]);
  });
});

describe('heroConcentration (§6)', () => {
  it('counts rows per hero and orders by count, then heroId', () => {
    const c = heroConcentration([
      { heroId: 2, displayName: 'B' }, { heroId: 1, displayName: 'A' },
      { heroId: 1, displayName: 'A' }, { heroId: 2, displayName: 'B' },
    ]);
    expect(c.heroesAffected).toBe(2);
    expect(c.top).toEqual([
      { heroId: 1, displayName: 'A', count: 2 },
      { heroId: 2, displayName: 'B', count: 2 },
    ]);
  });
});

describe('zeroVerdict (§20)', () => {
  const pass = { conflicts: 0, compatible: 10, inconclusive: 2, total: 12 };
  const evaluable = { conflicts: 0, compatible: 5, inconclusive: 7, total: 12 };
  const dead = { conflicts: 0, compatible: 0, inconclusive: 12, total: 12 };

  it('all three checks compatible -> ZERO_SEMANTICS_CONFIRMED', () => {
    expect(zeroVerdict({ damageZero: pass, targetZero: evaluable, targetFour: pass }))
      .toBe(VERDICTS.ZERO_SEMANTICS_CONFIRMED);
  });

  it('one conflict anywhere -> ZERO_SEMANTICS_CONFLICT', () => {
    expect(zeroVerdict({ damageZero: { ...pass, conflicts: 1 }, targetZero: pass, targetFour: pass }))
      .toBe(VERDICTS.ZERO_SEMANTICS_CONFLICT);
  });

  it('mixed pass and not-evaluable -> ZERO_SEMANTICS_PARTIAL', () => {
    expect(zeroVerdict({ damageZero: pass, targetZero: dead, targetFour: dead }))
      .toBe(VERDICTS.ZERO_SEMANTICS_PARTIAL);
  });

  it('nothing evaluable -> ZERO_SEMANTICS_UNKNOWN', () => {
    expect(zeroVerdict({ damageZero: dead, targetZero: dead, targetFour: dead }))
      .toBe(VERDICTS.ZERO_SEMANTICS_UNKNOWN);
  });

  it('summarizeClassifications feeds the verdict shape', () => {
    const s = summarizeClassifications([COMPAT.COMPATIBLE, COMPAT.CONFLICT, COMPAT.INCONCLUSIVE, COMPAT.FIELD_MISSING]);
    expect(s).toEqual({ conflicts: 1, compatible: 1, inconclusive: 2, total: 4 });
  });
});

