/**
 * STRATZ ability-graph evidence rules (ТЗ §30 §17).
 *
 * The measured outcome drives the interesting cases: the Hero -> Ability join
 * is 127/127 and upgrade provenance is fully typed, while all 16 control flags
 * are DECLARED on ModifierType and ZERO are populated. These tests pin the rule
 * that keeps that distinction intact.
 */
import { describe, expect, it } from 'vitest';
import {
  MODIFIER_CONTROL_FLAGS,
  STATE,
  normalizeAbility,
  normalizeHero,
  normalizeModifier,
  modifierFlagCoverage,
  resolveHeroAbilities,
  semanticFieldCoverage,
  upgradeProvenance,
} from './stratz-ability-lib.mjs';

describe('normalisers keep nulls distinct from false (§17)', () => {
  it('refuses a record with no id', () => {
    expect(normalizeHero({ name: 'x' })).toBeNull();
    expect(normalizeAbility({ name: 'x' })).toBeNull();
    expect(normalizeModifier({ name: 'x' })).toBeNull();
  });

  it('leaves an absent optional field null, not false', () => {
    expect(normalizeHero({ id: 26 }).gameVersionId).toBeNull();
    expect(normalizeAbility({ id: 1 }).isTalent).toBeNull();
  });

  it('keeps an explicit false', () => {
    expect(normalizeAbility({ id: 1, isTalent: false }).isTalent).toBe(false);
  });

  it('handles null and non-object input without throwing', () => {
    for (const bad of [null, undefined, 42, 'x', {}]) {
      expect(normalizeHero(bad)).toBeNull();
      expect(normalizeAbility(bad)).toBeNull();
    }
  });
});

describe('resolveHeroAbilities (§10)', () => {
  it('resolves a hero with 4 abilities', () => {
    const links = [1, 2, 3, 4].map((id) => ({ slot: id - 1, ability: { id, name: `a${id}` } }));
    const r = resolveHeroAbilities({ id: 26 }, links);
    expect(r.abilityCount).toBe(4);
    expect(r.abilities.map((a) => a.id)).toEqual([1, 2, 3, 4]);
  });

  it('handles a hero with an empty ability list', () => {
    expect(resolveHeroAbilities({ id: 26 }, []).abilityCount).toBe(0);
  });

  it('handles a hero with no ability list at all', () => {
    expect(resolveHeroAbilities({ id: 26 }, null).abilityCount).toBe(0);
  });

  it('drops a duplicate ability link but counts it', () => {
    const links = [{ slot: 0, ability: { id: 1 } }, { slot: 1, ability: { id: 1 } }];
    const r = resolveHeroAbilities({ id: 26 }, links);
    expect(r.abilityCount).toBe(1);
    expect(r.duplicateLinks).toBe(1);
  });

  it('drops a link whose ability has no id', () => {
    expect(resolveHeroAbilities({ id: 26 }, [{ ability: { name: 'x' } }]).abilityCount).toBe(0);
  });

  it('produces the same SET of abilities whatever order the links arrive in', () => {
    const links = [1, 2, 3].map((id) => ({ slot: id, ability: { id, name: `a${id}` } }));
    const fwd = resolveHeroAbilities({ id: 1 }, links);
    const rev = resolveHeroAbilities({ id: 1 }, [...links].reverse());
    // Slot is carried through, so a reversed input legitimately reports slots
    // in a different order. The ABILITY SET must be identical.
    expect(fwd.abilities.map((a) => a.id).sort()).toEqual(rev.abilities.map((a) => a.id).sort());
    expect(fwd.abilityCount).toBe(rev.abilityCount);
  });
});

describe('semanticFieldCoverage reports absence instead of crashing (§4/§17)', () => {
  it('marks a declared field PRESENT and an undeclared one ABSENT', () => {
    const c = semanticFieldCoverage(['id', 'name'], ['id', 'isStun']);
    expect(c).toEqual([
      { field: 'id', state: STATE.AVAILABLE },
      { field: 'isStun', state: STATE.NOT_AVAILABLE },
    ]);
  });

  it('handles a missing schema and a missing wanted list', () => {
    expect(semanticFieldCoverage(undefined, undefined)).toEqual([]);
    expect(semanticFieldCoverage(['a'], null)).toEqual([]);
  });
});

describe('upgrade provenance comes from typed booleans only (§11)', () => {
  it('records shard and scepter when the boolean is true', () => {
    expect(upgradeProvenance({ id: 1, stat: { hasShardUpgrade: true, hasScepterUpgrade: true } }))
      .toEqual(['scepter', 'shard']);
  });

  it('records the NEGATIVE explicitly rather than omitting it', () => {
    expect(upgradeProvenance({ id: 1, stat: { hasShardUpgrade: false, hasScepterUpgrade: false } }))
      .toEqual(['no_scepter', 'no_shard']);
  });

  it('marks talent and innate', () => {
    expect(upgradeProvenance({ id: 1, stat: { isTalent: true, isInnate: true } })).toEqual(['innate', 'talent']);
  });

  it('never invents provenance from a missing stat', () => {
    expect(upgradeProvenance({ id: 1 })).toEqual([]);
    expect(upgradeProvenance(null)).toEqual([]);
  });
});

describe('control flags: declared is not populated (§5/§6)', () => {
  it('reports unknown when declared but never true — the measured case', () => {
    const mods = [normalizeModifier({ id: 1, name: 'x' })];
    const c = modifierFlagCoverage(mods, MODIFIER_CONTROL_FLAGS);
    expect(c.every((x) => x.state === STATE.UNKNOWN)).toBe(true);
    expect(c.every((x) => x.trueCount === 0)).toBe(true);
  });

  it('reports available once a flag is actually true', () => {
    const mods = [normalizeModifier({ id: 1, name: 'x', isStun: true })];
    const c = modifierFlagCoverage(mods, MODIFIER_CONTROL_FLAGS);
    expect(c.find((x) => x.field === 'isStun').state).toBe(STATE.AVAILABLE);
    expect(c.find((x) => x.field === 'isStun').trueCount).toBe(1);
    expect(c.find((x) => x.field === 'isRoot').state).toBe(STATE.UNKNOWN);
  });

  it('reports not_present when the schema does not declare the field', () => {
    expect(modifierFlagCoverage([], [])[0].state).toBe(STATE.NOT_AVAILABLE);
  });

  it('unknown and not_present are different states', () => {
    expect(STATE.UNKNOWN).not.toBe(STATE.NOT_AVAILABLE);
  });
});

describe('no name or description matching (§12)', () => {
  it('produces no evidence for a modifier whose NAME says stun', () => {
    // A name like "modifier_lion_impale_stun" is NOT evidence. Only a typed
    // boolean is, and the shape has no way to carry one here.
    const m = normalizeModifier({ id: 1, name: 'modifier_lion_impale_stun' });
    expect(m.flags.isStun).toBeNull();
  });
});
