import { describe, it, expect } from 'vitest';
import {
  TRI, CAPABILITIES,
  resolveCapability, heroCapabilityProfile, capabilityDistribution,
  capabilitySignature, capabilityRedundancy,
} from './stratz-hero-capability-lib.mjs';

const ab = (name, stat) => ({ ability: { name, stat } });

describe('resolveCapability', () => {
  const dmg = new Map([['1', 'Physical'], ['2', 'Magical'], ['4', 'Pure']]);

  it('TRUE from a single confirmed observation, whatever the rest', () => {
    const r = resolveCapability([ab('a', { unitDamageType: 2 }), ab('b', { unitDamageType: 0 })], dmg, 'Magical', 'unitDamageType');
    expect(r.state).toBe(TRI.TRUE);
    expect(r.evidence).toBe(1);
    expect(r.unknown).toBe(1);
  });

  it('FALSE only when every ability is known and none matches', () => {
    const r = resolveCapability([ab('a', { unitDamageType: 1 }), ab('b', { unitDamageType: 2 })], dmg, 'Pure', 'unitDamageType');
    expect(r.state).toBe(TRI.FALSE);
    expect(r.known).toBe(2);
  });

  it('UNKNOWN when some ability is unresolved and no TRUE was found', () => {
    const r = resolveCapability([ab('a', { unitDamageType: 1 }), ab('b', { unitDamageType: 0 })], dmg, 'Pure', 'unitDamageType');
    expect(r.state).toBe(TRI.UNKNOWN);
    expect(r.known).toBe(1);
    expect(r.unknown).toBe(1);
  });

  it('an absent value never becomes FALSE', () => {
    const r = resolveCapability([ab('a', {})], dmg, 'Pure', 'unitDamageType');
    expect(r.state).toBe(TRI.UNKNOWN);
  });

  it('a hero with no abilities at all is UNKNOWN, not FALSE', () => {
    expect(resolveCapability([], dmg, 'Pure', 'unitDamageType').state).toBe(TRI.UNKNOWN);
  });

  it('is order-independent', () => {
    const rows = [ab('a', { unitDamageType: 2 }), ab('b', { unitDamageType: 0 }), ab('c', { unitDamageType: 4 })];
    const f = (r) => resolveCapability(r, dmg, 'Pure', 'unitDamageType').state;
    expect(f(rows)).toBe(f([...rows].reverse()));
  });
});

describe('heroCapabilityProfile', () => {
  const maps = { unitDamageType: new Map([['2', 'Magical'], ['4', 'Pure']]), unitTargetTeam: new Map([['2', 'Enemy']]) };

    it('reads ONLY its own dimension field, never a shared fallback chain (regression)', () => {
    // The bug: every capability resolved `unitDamageType` first, so target
    // capabilities silently queried the damage field. A row whose damage type
    // and target team differ must not make them look identical.
    const dmgLocal = new Map([['1', 'Physical'], ['2', 'Magical'], ['4', 'Pure']]);
    const team = new Map([['2', 'Enemy']]);
    const rows = [ab('a', { unitDamageType: 2, unitTargetTeam: 2 }), ab('b', { unitDamageType: 4, unitTargetTeam: 0 })];
    const p = heroCapabilityProfile('X', rows, { unitDamageType: dmgLocal, unitTargetTeam: team });
    expect(p.capabilities.HAS_MAGICAL_DAMAGE.state).toBe(TRI.TRUE);
    expect(p.capabilities.HAS_PURE_DAMAGE.state).toBe(TRI.TRUE);
    expect(p.capabilities.HAS_ENEMY_TARGETED.state).toBe(TRI.TRUE);
    // damage type 4 = Pure on the second row; team 0 has no confirmed mapping.
    expect(resolveCapability(rows, team, 'Enemy', 'unitTargetTeam').known).toBe(1);
  });

  it('produces one entry per capability in a stable order', () => {
    const p = heroCapabilityProfile('X', [ab('a', { unitDamageType: 2, unitTargetTeam: 2 })], maps);
    expect(Object.keys(p.capabilities)).toEqual(CAPABILITIES.map((c) => c.id).sort());
    expect(p.capabilities.HAS_MAGICAL_DAMAGE.state).toBe(TRI.TRUE);
    expect(p.capabilities.HAS_ENEMY_TARGETED.state).toBe(TRI.TRUE);
    // A single fully-known Magical ability is complete evidence of "no Pure",
    // so FALSE here is correct — it is not a fallback for missing data.
    expect(p.capabilities.HAS_PURE_DAMAGE.state).toBe(TRI.FALSE);
  });

  it('downgrades to UNKNOWN once any ability is unresolved', () => {
    const p = heroCapabilityProfile('X', [ab('a', { unitDamageType: 2, unitTargetTeam: 2 }), ab('b', { unitDamageType: 0 })], maps);
    expect(p.capabilities.HAS_PURE_DAMAGE.state).toBe(TRI.UNKNOWN);
    expect(p.capabilities.HAS_MAGICAL_DAMAGE.state).toBe(TRI.TRUE);
  });

  it('signature is identical for the same abilities in any order', () => {
    const rows = [ab('a', { unitDamageType: 2 }), ab('b', { unitDamageType: 4 }), ab('c', { unitDamageType: 0 })];
    expect(capabilitySignature(heroCapabilityProfile('X', rows, maps)))
      .toBe(capabilitySignature(heroCapabilityProfile('X', [...rows].reverse(), maps)));
  });

  it('accepts bare ability rows as well as wrapped ones', () => {
    const wrapped = heroCapabilityProfile('X', [ab('a', { unitDamageType: 2 })], maps);
    const bare = heroCapabilityProfile('X', [{ name: 'a', stat: { unitDamageType: 2 } }], maps);
    expect(capabilitySignature(wrapped)).toBe(capabilitySignature(bare));
  });
});

describe('capabilityDistribution / redundancy', () => {
  const mk = (states) => ({ capabilities: Object.fromEntries(Object.entries(states).map(([k, v]) => [k, { state: v }])) });

  it('counts each state and ignores absent capabilities', () => {
    const d = capabilityDistribution([mk({ A: TRI.TRUE }), mk({ A: TRI.FALSE }), mk({ A: TRI.UNKNOWN })], 'A');
    expect(d).toEqual({ TRUE: 1, FALSE: 1, UNKNOWN: 1 });
    expect(capabilityDistribution([mk({ B: TRI.TRUE })], 'A')).toEqual({ TRUE: 0, FALSE: 0, UNKNOWN: 0 });
  });

  it('counts agreement on UNKNOWN as redundancy, not as agreement on a fact', () => {
    const r = capabilityRedundancy([mk({ A: TRI.UNKNOWN, B: TRI.UNKNOWN })], 'A', 'B');
    expect(r.identical).toBe(1);
    expect(r.bothUnknown).toBe(1);
  });

  it('detects perfect redundancy between two capabilities', () => {
    const r = capabilityRedundancy([mk({ A: TRI.TRUE, B: TRI.TRUE }), mk({ A: TRI.UNKNOWN, B: TRI.UNKNOWN })], 'A', 'B');
    expect(r.distinguish).toBe(0);
    expect(r.agreement).toBe(1);
  });

  it('returns agreement 0 rather than NaN for an empty pool', () => {
    expect(capabilityRedundancy([], 'A', 'B').agreement).toBe(0);
  });
});