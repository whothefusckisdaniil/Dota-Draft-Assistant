import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  FEATURE,
  HEX_DERIVED,
  aggregateHeroFeatures,
  classifyAbilityEvidence,
  coverageSummary,
  mergeDerivedEffects,
  parseAbilityEvidence,
  upgradeKindOf,
  validateFeatureState,
} from './enemy-control-lib.mjs';

const abil = (heroId, abilityKey, ...keys) => parseAbilityEvidence({
  heroId, abilityKey, attrib: keys.map((key) => ({ key, value: '1' })),
});

describe('explicit evidence yields available (§5, §21)', () => {
  it('accepts an anchored application key', () => {
    expect(classifyAbilityEvidence('stun_duration').category).toBe('stun');
    expect(classifyAbilityEvidence('bolt_stun_duration').category).toBe('stun');
    expect(classifyAbilityEvidence('silence_duration').category).toBe('silence');
    expect(classifyAbilityEvidence('does_root').category).toBe('root');
    expect(classifyAbilityEvidence('disarm_duration').category).toBe('disarm');
  });

  it('cites the exact source field as evidence (§6)', () => {
    expect(classifyAbilityEvidence('stun_duration').evidence).toBe('attrib.key="stun_duration"');
  });

  it('marks a hero available for a feature it evidences', () => {
    const h = aggregateHeroFeatures(26, [abil(26, 'lion_impale', 'stun_duration')]);
    expect(h.features.stun.status).toBe(FEATURE.AVAILABLE);
    expect(h.features.stun.abilities).toEqual(['lion_impale']);
  });
});

describe('no evidence is unknown, never not_present (§7, §21)', () => {
  it('a hero with no markers is unknown', () => {
    const h = aggregateHeroFeatures(26, []);
    for (const c of CATEGORIES) expect(h.features[c].status).toBe(FEATURE.UNKNOWN);
  });

  it('a marker-less stun ability leaves the hero unknown', () => {
    // lion_impale really is a stun and really has no marker: this is measured.
    const h = aggregateHeroFeatures(26, [abil(26, 'lion_impale', 'damage', 'radius')]);
    expect(h.features.stun.status).toBe(FEATURE.UNKNOWN);
  });

  it('unknown and not_present are distinguishable states', () => {
    expect(FEATURE.UNKNOWN).not.toBe(FEATURE.NOT_PRESENT);
    expect(validateFeatureState(FEATURE.UNKNOWN)).toBe(true);
    expect(validateFeatureState(FEATURE.NOT_PRESENT)).toBe(true);
    expect(validateFeatureState('maybe')).toBe(false);
  });
});

describe('false positives are rejected (§13, §21)', () => {
  it('rejects resistance / immunity markers', () => {
    for (const k of ['slow_resistance', 'slow_resist', 'castable_while_stunned', 'stun_stack_count',
      'slow_resist_per_str', 'tombstone_stun_penalty', 'unslowable', 'min_slow', 'max_stun']) {
      expect(classifyAbilityEvidence(k), k).toBeNull();
    }
  });

  it('rejects a non-key input rather than guessing', () => {
    for (const k of ['', null, undefined, 42, {}]) expect(classifyAbilityEvidence(k)).toBeNull();
  });

  it('an ability named like control but with no key is not evidence', () => {
    const h = aggregateHeroFeatures(1, [abil(1, 'silencer_glaive', 'damage', 'dmg_type')]);
    expect(h.features.silence.status).toBe(FEATURE.UNKNOWN);
  });
});

describe('upgrade provenance is preserved (§8, §21)', () => {
  it('classifies each upgrade kind from the key', () => {
    expect(upgradeKindOf('lion_impale')).toBe('base');
    expect(upgradeKindOf('shard_bonus_stun')).toBe('shard');
    expect(upgradeKindOf('scepter_slow_duration')).toBe('scepter');
    expect(upgradeKindOf('special_bonus_attack_damage_25')).toBe('talent');
    expect(upgradeKindOf('facet_stun_ability')).toBe('facet');
    expect(upgradeKindOf('lion_impale_upgrade_2')).toBe('upgrade');
  });

  it('records the kind on the evidence rather than a bare boolean', () => {
    const h = aggregateHeroFeatures(9, [abil(9, 'shard_bonus_stun', 'stun_duration')]);
    expect(h.features.stun.status).toBe(FEATURE.AVAILABLE);
    expect(h.features.stun.evidence.join(' ')).toContain('[shard]');
  });

  it('does not accept a tooltip key as a mechanic', () => {
    // The real source key `shard_bonus_stun_duration_tooltip` exists and is a
    // TOOLTIP string, not a mechanic.
    expect(classifyAbilityEvidence('shard_bonus_stun_duration_tooltip')).toBeNull();
  });
});

describe('hex is composite, and its effects are DERIVED (§14, §21)', () => {
  const source = [{ category: 'hex', evidence: 'e', abilityKey: 'shadowshaman_hex', derived: false }];
  const merged = mergeDerivedEffects(source);

  it('adds silence, mute and disarm from a hex', () => {
    const cats = merged.map((e) => e.category);
    expect(cats).toContain('hex');
    for (const d of HEX_DERIVED) expect(cats).toContain(d);
  });

  it('marks the derived ones as derived, not independent proof (§14)', () => {
    for (const e of merged.filter((x) => x.category !== 'hex')) {
      expect(e.derived).toBe(true);
      expect(e.derivedFrom).toBe('hex');
    }
  });

  it('does not duplicate the hex evidence itself', () => {
    expect(merged.filter((e) => e.category === 'hex')).toHaveLength(1);
  });

  it('surfaces hex and its derived effects on the hero profile', () => {
    const h = aggregateHeroFeatures(5, [abil(5, 'shadowshaman_hex', 'hex_chance')]);
    expect(h.features.hex.status).toBe(FEATURE.AVAILABLE);
    expect(h.features.silence.status).toBe(FEATURE.AVAILABLE);
    expect(h.features.silence.derivedAbilities).toEqual(['shadowshaman_hex']);
    expect(h.features.silence.evidence.join(' ')).toContain('derived-from=hex');
  });
});

describe('merging and dedupe (§21)', () => {
  it('merges several abilities of one hero', () => {
    const h = aggregateHeroFeatures(1, [abil(1, 'a_stun', 'stun_duration'), abil(1, 'b_stun', 'stun_radius')]);
    expect(h.features.stun.abilities).toEqual(['a_stun', 'b_stun']);
  });

  it('dedupes identical evidence (§21)', () => {
    const h = aggregateHeroFeatures(1, [abil(1, 'a_stun', 'stun_duration', 'stun_duration')]);
    expect(h.features.stun.evidence).toHaveLength(1);
  });

  it('never double counts an ability', () => {
    const h = aggregateHeroFeatures(1, [abil(1, 'a_stun', 'stun_duration', 'stun_radius')]);
    expect(h.features.stun.abilities).toHaveLength(1);
  });
});

describe('determinism (§20, §21)', () => {
  const abilities = [
    abil(1, 'a_stun', 'stun_duration'),
    abil(1, 'b_silence', 'silence_duration'),
    abil(1, 'c_hex', 'hex_chance'),
  ];

  it('produces identical JSON for a reordered ability list', () => {
    const forward = aggregateHeroFeatures(1, abilities);
    const reversed = aggregateHeroFeatures(1, [...abilities].reverse());
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });

  it('contains no clock or randomness in the library source', async () => {
    const src = await readFile(new URL('./enemy-control-lib.mjs', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/Math\.random|Date\.now|new Date\(/);
  });
});

describe('coverage summary (§10)', () => {
  it('counts available and unknown per category without inventing not_present', () => {
    const heroes = [
      aggregateHeroFeatures(1, [abil(1, 'a_stun', 'stun_duration')]),
      aggregateHeroFeatures(2, []),
    ];
    const c = coverageSummary(heroes, { total: 10, classified: 2 });
    expect(c.heroesTotal).toBe(2);
    expect(c.perCategory.stun.heroesAvailable).toBe(1);
    expect(c.perCategory.stun.heroesUnknown).toBe(1);
    expect(c.heroesWithAnyFeature).toBe(1);
  });

  it('handles an empty pool', () => {
    expect(coverageSummary([], {}).heroesTotal).toBe(0);
  });
});