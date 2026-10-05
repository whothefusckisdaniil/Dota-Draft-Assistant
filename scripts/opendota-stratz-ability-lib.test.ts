import { describe, it, expect } from 'vitest';
import {
  VALIDATION,
  normalizeOpenDotaAbility, exactAbilityJoin, buildValueCrossTable,
  classifyMapping, splitDeterministically, validateMapping,
} from './opendota-stratz-ability-lib.mjs';

/** STRATZ abilities arrive with properties nested under `stat`. */
const sb = (name, stat) => ({ name, stat });

describe('normalizeOpenDotaAbility', () => {
  it('treats "" and missing as the same "not stated", never as a distinct label', () => {
    expect(normalizeOpenDotaAbility('a', { dmg_type: '' }).dmg_type).toBeNull();
    expect(normalizeOpenDotaAbility('a', {}).dmg_type).toBeNull();
    expect(normalizeOpenDotaAbility('a', null).target_team).toBeNull();
  });

  it('keeps named values verbatim', () => {
    expect(normalizeOpenDotaAbility('a', { dmg_type: 'Physical' }).dmg_type).toBe('Physical');
  });
});

describe('exactAbilityJoin', () => {
  const oda = { alpha: { dmg_type: 'Physical' }, beta: { dmg_type: 'Magical' } };

  it('joins on the exact key only', () => {
    const r = exactAbilityJoin([sb('alpha', { unitDamageType: 1 })], oda);
    expect(r.matchedCount).toBe(1);
    expect(r.matched[0].opendota.dmg_type).toBe('Physical');
  });

  it('reports a missing OpenDota ability instead of fuzzy-matching it', () => {
    const r = exactAbilityJoin([sb('alpha_2', { unitDamageType: 1 })], oda);
    expect(r.matchedCount).toBe(0);
    expect(r.missingOpenDota).toEqual(['alpha_2']);
  });

  it('does NOT case-fold or substring-match (regression)', () => {
    expect(exactAbilityJoin([sb('ALPHA', {})], oda).matchedCount).toBe(0);
    expect(exactAbilityJoin([sb('alphax', {})], oda).matchedCount).toBe(0);
  });

  it('reads STRATZ properties from ability.stat, not the top level (regression)', () => {
    // The §31 bug shape again: a top-level read yields all-null pairs, which
    // looks identical to "no mapping exists".
    const r = exactAbilityJoin([{ name: 'alpha', unitDamageType: 1, stat: {} }], oda);
    expect(r.matched[0].stratz.unitDamageType).toBeNull();
    const ok = exactAbilityJoin([sb('alpha', { unitDamageType: 1 })], oda);
    expect(ok.matched[0].stratz.unitDamageType).toBe(1);
  });

  it('counts duplicate ability keys instead of double-joining them', () => {
    const r = exactAbilityJoin([sb('alpha', {}), sb('alpha', {})], oda);
    expect(r.matchedCount).toBe(1);
    expect(r.duplicates).toEqual(['alpha']);
  });
});

describe('buildValueCrossTable / classifyMapping', () => {
  const P = (key, raw, sem) => ({ key, stratz: { unitDamageType: raw }, opendota: { dmg_type: sem } });

  it('one raw -> one semantic is CONFIRMED', () => {
    const t = buildValueCrossTable([P('a', 1, 'Physical'), P('b', 1, 'Physical')], 'unitDamageType', 'dmg_type');
    const m = classifyMapping(t, 1);
    expect(m.validationStatus).toBe(VALIDATION.CONFIRMED);
    expect(m.semantic).toBe('Physical');
  });

  it('one raw -> two semantics is AMBIGUOUS, with no semantic chosen', () => {
    const t = buildValueCrossTable([P('a', 1, 'Physical'), P('b', 1, 'Magical')], 'unitDamageType', 'dmg_type');
    const m = classifyMapping(t, 1);
    expect(m.validationStatus).toBe(VALIDATION.AMBIGUOUS);
    expect(m.semantic).toBeNull();
  });

  it('two raws -> one semantic is NON_BIJECTIVE for both', () => {
    const t = buildValueCrossTable([P('a', 1, 'Physical'), P('b', 2, 'Physical')], 'unitDamageType', 'dmg_type');
    expect(classifyMapping(t, 1).validationStatus).toBe(VALIDATION.NON_BIJECTIVE);
    expect(classifyMapping(t, 2).validationStatus).toBe(VALIDATION.NON_BIJECTIVE);
    expect(classifyMapping(t, 1).semantic).toBeNull();
  });

describe('splitDeterministically', () => {
  const P = (key) => ({ key });

  it('splits by sorted key, so the halves are stable across runs', () => {
    const pairs = ['c', 'a', 'e', 'b', 'd'].map(P);
    const r1 = splitDeterministically(pairs);
    const r2 = splitDeterministically([...pairs].reverse());
    expect(r1.a.map((x) => x.key)).toEqual(['a', 'b']);
    expect(r1.b.map((x) => x.key)).toEqual(['c', 'd', 'e']);
    expect(r2.a.map((x) => x.key)).toEqual(r1.a.map((x) => x.key));
  });

  it('is not affected by input ordering', () => {
    const pairs = ['z', 'y', 'x', 'w'].map(P);
    expect(splitDeterministically(pairs).b.map((x) => x.key)).toEqual(['y', 'z']);
    expect(splitDeterministically([...pairs].reverse()).b.map((x) => x.key)).toEqual(['y', 'z']);
  });
});

describe('validateMapping', () => {
  const P = (key, raw, sem) => ({ key, stratz: { unitDamageType: raw }, opendota: { dmg_type: sem } });

  it('a mapping consistent in A and B is CONFIRMED and AGREES', () => {
    const v = validateMapping([P('a', 1, 'Physical')], [P('b', 1, 'Physical')], 'unitDamageType', 'dmg_type');
    expect(v.results[0].validationStatus).toBe(VALIDATION.CONFIRMED);
    expect(v.results[0].outOfSample).toBe('AGREES');
  });

  it('a mapping contradicted by B is a CONFLICT, not silently kept', () => {
    const v = validateMapping([P('a', 1, 'Physical')], [P('b', 1, 'Magical')], 'unitDamageType', 'dmg_type');
    expect(v.results[0].validationStatus).not.toBe(VALIDATION.CONFIRMED);
    expect(v.results[0].outOfSample).toBe('CONFLICT');
  });

  it('a raw value present only in B is reported as unmappable from A', () => {
    const v = validateMapping([P('a', 1, 'Physical')], [P('b', 5, 'Pure')], 'unitDamageType', 'dmg_type');
    expect(v.bOnlyValues).toEqual(['5']);
  });

  it('an unlabeled observation in B neither confirms nor contradicts', () => {
    // B sees raw 1 but carries no semantic for it, so there is nothing to
    // disagree with. It must not be recorded as a conflict, and it must not
    // turn the mapping into a negative either.
    const v = validateMapping([P('a', 1, 'Physical')], [P('b', 1, null)], 'unitDamageType', 'dmg_type');
    expect(v.results[0].outOfSample).toBe('NO_OBSERVATIONS');
    expect(v.results[0].validationStatus).toBe(VALIDATION.CONFIRMED);
    expect(v.results[0].semantic).toBe('Physical');
  });

  it('a different semantic in B is a genuine CONFLICT', () => {
    const v = validateMapping([P('a', 1, 'Physical')], [P('b', 1, 'Magical')], 'unitDamageType', 'dmg_type');
    expect(v.results[0].outOfSample).toBe('CONFLICT');
    expect(v.results[0].semantic).toBeNull();
  });
});
  it('a null semantic never competes with a named one', () => {
    const t = buildValueCrossTable([P('a', 3, 'Both'), P('b', 3, null)], 'unitDamageType', 'dmg_type');
    const m = classifyMapping(t, 3);
    expect(m.semantic).toBe('Both');
    expect(m.validationStatus).toBe(VALIDATION.CONFIRMED);
  });

  it('a raw value with no semantic at all is UNKNOWN, never false', () => {
    const t = buildValueCrossTable([P('a', 0, null), P('b', 0, null)], 'unitDamageType', 'dmg_type');
    const m = classifyMapping(t, 0);
    expect(m.validationStatus).toBe(VALIDATION.UNKNOWN);
    expect(m.semantic).toBeNull();
    expect(m.observations).toBe(2);
  });

  it('an unseen raw value is UNKNOWN', () => {
    const t = buildValueCrossTable([P('a', 1, 'Physical')], 'unitDamageType', 'dmg_type');
    expect(classifyMapping(t, 7).validationStatus).toBe(VALIDATION.UNKNOWN);
  });
});