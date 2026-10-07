import { describe, it, expect } from 'vitest';
import {
  TRI, CAPABILITIES, ZERO_SEMANTICS, EXPECTED_RAW_DOMAIN, VERDICTS,
  mergeConfirmedMappings, resolveTriStateV2, heroCapabilityProfileV2,
  capabilityDistributionV2, capabilitySignatureV2, capabilityRedundancyV2,
  domainAudit, heroDimensionCoverage, falseAvailability,
  pairUniqueness, signatureGroups, largestSignatureShare, topKSignatureShare,
  positionIntersection, capabilityVerdictV2,
} from './stratz-hero-capability-v2-lib.mjs';

const ab = (name, stat) => ({ ability: { name, stat } });

/** §32-shaped artifact fixture: three confirmed non-zero mappings per field. */
function artifactFixture() {
  return {
    fields: {
      unitDamageType: {
        mapping: [
          { rawValue: '1', semantic: 'Physical', validationStatus: 'CONFIRMED' },
          { rawValue: '2', semantic: 'Magical', validationStatus: 'CONFIRMED' },
          { rawValue: '4', semantic: 'Pure', validationStatus: 'CONFIRMED' },
        ],
      },
      unitTargetTeam: {
        mapping: [
          { rawValue: '1', semantic: 'Friendly', validationStatus: 'CONFIRMED' },
          { rawValue: '2', semantic: 'Enemy', validationStatus: 'CONFIRMED' },
          { rawValue: '3', semantic: 'Both', validationStatus: 'CONFIRMED' },
        ],
      },
    },
    unmapped: {
      unitDamageType: [{ rawValue: '0', validationStatus: 'UNKNOWN' }],
      unitTargetTeam: [
        { rawValue: '0', validationStatus: 'UNKNOWN' },
        { rawValue: '4', validationStatus: 'UNKNOWN' },
      ],
    },
  };
}

const merged = mergeConfirmedMappings(artifactFixture());
const maps33 = mergeConfirmedMappings(artifactFixture(), {});

describe('mergeConfirmedMappings', () => {
  it('adds the §34-confirmed zero semantics on top of §32 CONFIRMED entries', () => {
    expect(merged.unitDamageType.get('0')).toBe('None');
    expect(merged.unitDamageType.get('1')).toBe('Physical');
    expect(merged.unitTargetTeam.get('0')).toBe('None');
    expect(merged.unitTargetTeam.get('4')).toBe('Custom');
    // §2 — the external enum's 7/8 are NOT admitted: STRATZ never shows them.
    expect(merged.unitDamageType.has('7')).toBe(false);
    expect(merged.unitDamageType.has('8')).toBe(false);
  });

  it('with empty zero semantics it reproduces the §33 confirmed-only map', () => {
    expect(maps33.unitDamageType.has('0')).toBe(false);
    expect(maps33.unitTargetTeam.has('4')).toBe(false);
    expect(maps33.unitDamageType.size).toBe(3);
    expect(maps33.unitTargetTeam.size).toBe(3);
  });

  it('mapping cannot mutate the source artifact (§3, §25)', () => {
    const art = artifactFixture();
    const before = JSON.stringify(art);
    mergeConfirmedMappings(art);
    expect(JSON.stringify(art)).toBe(before);
    // The §32 artifact on disk is untouched — unmapped stays UNKNOWN.
    expect(art.unmapped.unitDamageType[0].validationStatus).toBe('UNKNOWN');
  });

  it('a §32-confirmed zero would win over the zero addition (add-only merge)', () => {
    const art = artifactFixture();
    art.fields.unitDamageType.mapping.push({ rawValue: '0', semantic: 'LegacyZero', validationStatus: 'CONFIRMED' });
    expect(mergeConfirmedMappings(art).unitDamageType.get('0')).toBe('LegacyZero');
  });
});

describe('resolveTriStateV2 — NONE as a known state (§6, §20–§22)', () => {
  it('NONE contributes to known: zero + zero damage → compatible FALSE (§20 regression)', () => {
    const rows = [ab('a', { unitDamageType: 0 }), ab('b', { unitDamageType: 0 })];
    const r = resolveTriStateV2(rows, merged.unitDamageType, 'Physical', 'unitDamageType');
    expect(r.state).toBe(TRI.FALSE);
    expect(r.known).toBe(2);
    expect(r.unknown).toBe(0);
  });

  it('§20 fully-known hero: NONE/MAGICAL/NONE/PHYSICAL/NONE/PURE damage + all-NONE target', () => {
    const damage = [0, 2, 0, 1, 0, 4].map((v, i) => ab(`d${i}`, { unitDamageType: v, unitTargetTeam: 0 }));
    const p = heroCapabilityProfileV2('X', damage, merged);
    expect(p.capabilities.HAS_PHYSICAL_DAMAGE.state).toBe(TRI.TRUE);
    expect(p.capabilities.HAS_MAGICAL_DAMAGE.state).toBe(TRI.TRUE);
    expect(p.capabilities.HAS_PURE_DAMAGE.state).toBe(TRI.TRUE);
    expect(p.capabilities.HAS_ENEMY_TARGETED.state).toBe(TRI.FALSE);
    expect(p.capabilities.HAS_FRIENDLY_TARGETED.state).toBe(TRI.FALSE);
    expect(p.capabilities.HAS_BOTH_TARGETED.state).toBe(TRI.FALSE);
  });

  it('§21 partial unknown: an unmapped raw keeps the non-hit dimensions UNKNOWN', () => {
    const rows = [0, 2, 0, 9, 0, 0].map((v, i) => ab(`d${i}`, { unitDamageType: v })); // 9 not in map
    const p = heroCapabilityProfileV2('X', rows, merged);
    expect(p.capabilities.HAS_MAGICAL_DAMAGE.state).toBe(TRI.TRUE);
    expect(p.capabilities.HAS_PHYSICAL_DAMAGE.state).toBe(TRI.UNKNOWN);
    expect(p.capabilities.HAS_PURE_DAMAGE.state).toBe(TRI.UNKNOWN);
  });

  it('§22 unknown cannot hide behind TRUE: TRUE keeps unknown>0', () => {
    const rows = [ab('a', { unitDamageType: 2 }), ab('b', { unitDamageType: 9 })];
    const r = resolveTriStateV2(rows, merged.unitDamageType, 'Magical', 'unitDamageType');
    expect(r.state).toBe(TRI.TRUE);
    expect(r.unknown).toBe(1);
  });

  it('§22 but Pure with an unknown row is UNKNOWN, not FALSE', () => {
    const rows = [ab('a', { unitDamageType: 2 }), ab('b', { unitDamageType: 9 })];
    expect(resolveTriStateV2(rows, merged.unitDamageType, 'Pure', 'unitDamageType').state).toBe(TRI.UNKNOWN);
  });

  it('§7 missing stat remains UNKNOWN — a missing field is not raw zero', () => {
    const rows = [ab('a', null), ab('b', { unitDamageType: 0 })];
    const r = resolveTriStateV2(rows, merged.unitDamageType, 'Physical', 'unitDamageType');
    expect(r.state).toBe(TRI.UNKNOWN);
    expect(r.known).toBe(1); // only the raw-zero row is known
  });

  it('§25 unknown raw remains UNKNOWN (raw outside any map)', () => {
    const rows = [ab('a', { unitTargetTeam: 42 })];
    expect(resolveTriStateV2(rows, merged.unitTargetTeam, 'Enemy', 'unitTargetTeam').state).toBe(TRI.UNKNOWN);
  });

  it('§25 damage dimension ≠ target dimension: capabilities read their own field', () => {
    const rows = [ab('a', { unitDamageType: 2, unitTargetTeam: 0 })];
    const p = heroCapabilityProfileV2('X', rows, merged);
    expect(p.capabilities.HAS_MAGICAL_DAMAGE.state).toBe(TRI.TRUE);
    expect(p.capabilities.HAS_ENEMY_TARGETED.state).toBe(TRI.FALSE); // NONE is known here
    expect(p.capabilities.HAS_FRIENDLY_TARGETED.state).toBe(TRI.FALSE);
  });

  it('regression: target capability must never read the damage mapping (§25)', () => {
    // unitTargetTeam=1 would be 'Physical' under the damage map; under the
    // team map it is 'Friendly'. Only the correct map yields Enemy=FALSE via
    // a KNOWN non-match rather than an unresolved row.
    const rows = [ab('a', { unitDamageType: 1, unitTargetTeam: 1 })];
    const enemy = resolveTriStateV2(rows, merged.unitTargetTeam, 'Enemy', 'unitTargetTeam');
    expect(enemy.state).toBe(TRI.FALSE);
    expect(enemy.known).toBe(1);
    const friendly = resolveTriStateV2(rows, merged.unitTargetTeam, 'Friendly', 'unitTargetTeam');
    expect(friendly.state).toBe(TRI.TRUE);
  });

  it('raw 4 target team resolves through CUSTOM as a known state, not unknown', () => {
    const rows = [ab('a', { unitTargetTeam: 4 }), ab('b', { unitTargetTeam: 2 })];
    const r = resolveTriStateV2(rows, merged.unitTargetTeam, 'Enemy', 'unitTargetTeam');
    expect(r.state).toBe(TRI.TRUE);
    expect(r.known).toBe(2); // Custom row counts as known evidence
  });
});

describe('heroCapabilityProfileV2 — determinism (§23)', () => {
  const rows = [
    ab('a', { unitDamageType: 2, unitTargetTeam: 2 }),
    ab('b', { unitDamageType: 0, unitTargetTeam: 0 }),
    ab('c', { unitDamageType: 4, unitTargetTeam: 1 }),
  ];

  it('same abilities in different order → byte-identical profile', () => {
    const one = heroCapabilityProfileV2('X', rows, merged);
    const two = heroCapabilityProfileV2('X', [rows[2], rows[0], rows[1]], merged);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it('signature is order-independent', () => {
    expect(capabilitySignatureV2(heroCapabilityProfileV2('X', rows, merged)))
      .toBe(capabilitySignatureV2(heroCapabilityProfileV2('X', [...rows].reverse(), merged)));
  });

  it('produces exactly the six §4 capabilities in stable key order', () => {
    const p = heroCapabilityProfileV2('X', rows, merged);
    expect(Object.keys(p.capabilities)).toEqual(CAPABILITIES.map((c) => c.id).sort());
    expect(CAPABILITIES.map((c) => c.id)).not.toContain('HAS_CUSTOM_TARGETED'); // §4
  });

  it('ZERO_SEMANTICS labels can never equal a capability semantic', () => {
    const semantics = new Set(CAPABILITIES.map((c) => c.semantic));
    for (const sem of Object.values(ZERO_SEMANTICS).flatMap((m) => Object.values(m))) {
      expect(semantics.has(sem)).toBe(false);
    }
  });
});

describe('distribution / redundancy / availability (§12–§14)', () => {
  const mk = (states) => ({
    heroId: 'h',
    capabilities: Object.fromEntries(Object.entries(states).map(([k, v]) => [k, { state: v }])),
  });

  it('capabilityDistributionV2 counts states', () => {
    const ps = [mk({ A: TRI.TRUE }), mk({ A: TRI.FALSE }), mk({ A: TRI.UNKNOWN })];
    expect(capabilityDistributionV2(ps, 'A')).toEqual({ TRUE: 1, FALSE: 1, UNKNOWN: 1 });
  });

  it('falseAvailability reports FALSE heroes and a known share over the pool', () => {
    const ps = [mk({ A: TRI.TRUE }), mk({ A: TRI.FALSE }), mk({ A: TRI.FALSE }), mk({ A: TRI.UNKNOWN })];
    const f = falseAvailability(ps, 'A');
    expect(f.falseHeroes).toBe(2);
    expect(f.knownHeroes).toBe(3);
    expect(f.knownShare).toBeCloseTo(0.75);
    expect(f.unknownShare).toBeCloseTo(0.25);
  });

  it('pair redundancy counts agreement-on-UNKNOWN as redundancy', () => {
    const ps = [mk({ A: TRI.UNKNOWN, B: TRI.UNKNOWN }), mk({ A: TRI.TRUE, B: TRI.FALSE })];
    const r = capabilityRedundancyV2(ps, 'A', 'B');
    expect(r.identical).toBe(1);
    expect(r.bothUnknown).toBe(1);
    expect(r.distinguish).toBe(1);
    expect(r.agreement).toBeCloseTo(0.5);
  });

  it('pairUniqueness enumerates the observed 2-feature state combinations', () => {
    const ps = [
      mk({ A: TRI.TRUE, B: TRI.TRUE }),
      mk({ A: TRI.FALSE, B: TRI.FALSE }),
      mk({ A: TRI.FALSE, B: TRI.FALSE }),
    ];
    const u = pairUniqueness(ps, 'A', 'B');
    expect(u.distinct).toBe(2);
    expect(u.combos['FALSE/FALSE']).toBe(2);
    expect(u.combos['TRUE/TRUE']).toBe(1);
  });

  it('signatureGroups groups deterministically, largest first', () => {
    const ps = [mk({ A: TRI.TRUE }), mk({ A: TRI.TRUE }), mk({ A: TRI.FALSE })];
    const g = signatureGroups(ps);
    expect(g).toHaveLength(2);
    expect(g[0].count).toBe(2);
    expect(g[1].count).toBe(1);
    expect(signatureGroups([...ps].reverse())).toEqual(g);
  });
});

describe('domainAudit (§8)', () => {
  it('classifies mapped / unknown / missing without conflating missing with zero', () => {
    const a = domainAudit([0, 1, 2, null], merged.unitDamageType, EXPECTED_RAW_DOMAIN.unitDamageType);
    expect(a.mapped).toBe(3);
    expect(a.missing).toBe(1);
    expect(a.unknown).toEqual({});
    expect(a.unmapped).toEqual({});
    expect(a.status).toBe('COMPLETE');
    expect(a.observed['0']).toBe(1); // raw zero observed, distinct from missing
  });

  it('flags a raw outside the expected domain as UNMAPPED_RAW_VALUE, not as unknown semantic', () => {
    const a = domainAudit([0, 7], merged.unitDamageType, EXPECTED_RAW_DOMAIN.unitDamageType);
    expect(a.status).toBe('UNMAPPED_RAW_VALUE');
    expect(a.unmapped['7']).toBe(1);
    expect(a.unknown).toEqual({}); // 7 is not "expected but unresolved"
  });

  it('an expected-but-unmapped raw stays in the unknown bucket with COMPLETE status', () => {
    const a = domainAudit([4], new Map(), EXPECTED_RAW_DOMAIN.unitDamageType);
    expect(a.unknown['4']).toBe(1);
    expect(a.status).toBe('COMPLETE');
  });

  it('enum NONE ≠ missing: a missing field never appears in observed', () => {
    const a = domainAudit([null, undefined], merged.unitTargetTeam, EXPECTED_RAW_DOMAIN.unitTargetTeam);
    expect(a.missing).toBe(2);
    expect(a.observed).toEqual({});
    expect(a.mapped).toBe(0);
  });
});

describe('heroDimensionCoverage (§10)', () => {
  it('complete only when every row resolves, empty hero never complete', () => {
    const rows = [ab('a', { unitDamageType: 0 }), ab('b', { unitDamageType: 2 })];
    expect(heroDimensionCoverage(rows, merged.unitDamageType, 'unitDamageType')).toEqual({ known: 2, total: 2, complete: true });
    const withMissing = [...rows, ab('c', null)];
    expect(heroDimensionCoverage(withMissing, merged.unitDamageType, 'unitDamageType').complete).toBe(false);
    expect(heroDimensionCoverage([], merged.unitDamageType, 'unitDamageType').complete).toBe(false);
  });
});

describe('positionIntersection (§17)', () => {
  const complete = {
    heroId: 1,
    capabilities: Object.fromEntries(CAPABILITIES.map((c) => [c.id, { state: TRI.TRUE }])),
  };
  const incomplete = {
    heroId: 2,
    capabilities: Object.fromEntries(CAPABILITIES.map((c, i) => [c.id, { state: i === 0 ? TRI.UNKNOWN : TRI.TRUE }])),
  };
  const positions = {
    1: { positions: { 1: { games: 900, share: 0.9 }, 2: { games: 100, share: 0.01 } } },
    2: { positions: { 3: { games: 600, share: 0.5 } } },
  };

  it('counts only gate-eligible cells and splits complete vs incomplete profiles', () => {
    const r = positionIntersection([complete, incomplete], positions);
    expect(r.cells).toBe(2); // hero1 pos1 (pos2 below gate), hero2 pos3
    expect(r.completeCells).toBe(1);
    expect(r.incompleteCells).toBe(1);
    expect(r.unknownCapabilities).toBe(1);
    expect(r.knownCapabilities).toBe(11);
    expect(r.heroesWithoutPositionData).toEqual([]);
  });

  it('heroes absent from positions.json are reported, not dropped silently', () => {
    const r = positionIntersection([{ heroId: 9, capabilities: {} }], positions);
    expect(r.heroesWithoutPositionData).toEqual([9]);
    expect(r.cells).toBe(0);
  });
});

describe('capabilityVerdictV2 (§28)', () => {
  it('§33-style metrics fall through to MARGINAL (sanity anchor)', () => {
    expect(capabilityVerdictV2({ rowCoverage: 0.474, completeShare: 0.024, signatureShare: 34 / 127, neverFalse: 4 }))
      .toBe(VERDICTS.MARGINAL);
  });

  it('full domain + strong differentiation → EXACT', () => {
    expect(capabilityVerdictV2({ rowCoverage: 0.998, completeShare: 0.98, signatureShare: 0.6, neverFalse: 0 }))
      .toBe(VERDICTS.EXACT);
  });

  it('good coverage but moderate differentiation → PARTIAL', () => {
    expect(capabilityVerdictV2({ rowCoverage: 0.998, completeShare: 0.9, signatureShare: 0.3, neverFalse: 1 }))
      .toBe(VERDICTS.PARTIAL);
  });

  it('good coverage but profiles still locked out of FALSE → MARGINAL', () => {
    expect(capabilityVerdictV2({ rowCoverage: 0.998, completeShare: 0.9, signatureShare: 0.6, neverFalse: 4 }))
      .toBe(VERDICTS.MARGINAL);
  });
});

describe('signature concentration (§35.1)', () => {
  /** §35.1 §5 — pathological fixture: 127 heroes, 33 signatures, but no discrimination. */
  function pathologicalGroups() {
    const groups = [{ signature: 'MEGA', count: 95, heroIds: [] }];
    for (let i = 0; i < 32; i += 1) groups.push({ signature: `S${i}`, count: 1, heroIds: [] });
    return groups;
  }

  it('distinct count looks fine while one group owns the pool', () => {
    const groups = pathologicalGroups();
    expect(groups.length / 127).toBeCloseTo(0.26, 2); // distinctSignatureShare = 26%
    expect(largestSignatureShare(groups, 127)).toBeCloseTo(95 / 127, 5); // 74.8%
    expect(topKSignatureShare(groups, 127, 2)).toBeCloseTo(96 / 127, 5);
  });

  it('real §35 numbers: largest 24/127, top-2 46/127', () => {
    const groups = [
      { signature: 'A', count: 24, heroIds: [] },
      { signature: 'B', count: 22, heroIds: [] },
      { signature: 'C', count: 12, heroIds: [] },
    ];
    expect(largestSignatureShare(groups, 127)).toBeCloseTo(24 / 127, 5);
    expect(topKSignatureShare(groups, 127, 2)).toBeCloseTo(46 / 127, 5);
    expect(topKSignatureShare(groups, 127, 1)).toBe(largestSignatureShare(groups, 127));
  });

  it('concentration helpers are total and edge-safe', () => {
    expect(largestSignatureShare([], 127)).toBe(0);
    expect(largestSignatureShare(pathologicalGroups(), 0)).toBe(0);
    expect(topKSignatureShare(pathologicalGroups(), 127, 0)).toBe(0);
    expect(topKSignatureShare([], 127, 2)).toBe(0);
    expect(topKSignatureShare(pathologicalGroups(), 127, 99)).toBeCloseTo(1, 5);
  });
});


