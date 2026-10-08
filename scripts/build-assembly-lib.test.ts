/**
 * ТЗ №39 — Build Assembly tests. Synthetic doubles only: no network, no
 * production data, no new weights. Every test pins a §39 acceptance rule —
 * if the assembler invents a candidate, invents a phase, duplicates an item,
 * leaks across cells, or depends on object iteration order, a test fails.
 */
import { describe, it, expect } from 'vitest';
import {
  DISPLAY_PHASES, PHASE_CAPACITY, NO_PHASE, VALVE_TO_DISPLAY,
  ASSEMBLY_STATUS, canonicalDisplayPhase, assembleBuild, validateAssembledBuild,
} from './build-assembly-lib.mjs';

/** Minimal getBuildCandidates-shaped double. */
const cand = (itemId, over = {}) => ({
  heroId: 1,
  position: '1',
  itemId,
  rank: over.rank ?? itemId,
  itemPrior: { score: over.score ?? (1000 - itemId), purchases: 500 },
  evidence: {
    phase: over.phase ?? {
      status: 'available', source: 'ValveItemBuild',
      value: { phases: ['Core_Items'], phaseFamilies: ['mid'], phaseExclusive: true },
    },
  },
});

const withPhases = (...phases) => ({
  status: 'available', source: 'ValveItemBuild',
  value: { phases, phaseFamilies: [], phaseExclusive: phases.length === 1 },
});

describe('constants (§3, §5, §7)', () => {
  it('display phases are the six Valve categorical phases in order', () => {
    expect(DISPLAY_PHASES).toEqual(['starting', 'early', 'core', 'mid', 'late', 'luxury']);
  });
  it('capacity is a presentation cap, never tuned', () => {
    expect(PHASE_CAPACITY).toEqual({ starting: 3, early: 3, core: 5, mid: 3, late: 3, luxury: 3 });
  });
  it('Other_Items is absent from the mapping (never force-fitted)', () => {
    expect(VALVE_TO_DISPLAY.Other_Items).toBeUndefined();
    expect(VALVE_TO_DISPLAY.Core_Items).toBe('core');
    expect(VALVE_TO_DISPLAY.Luxury).toBe('luxury');
  });
});

describe('canonicalDisplayPhase (§5)', () => {
  it('maps a single Valve phase', () => {
    expect(canonicalDisplayPhase(cand(1, { phase: withPhases('Late_Items') })).phase).toBe('late');
  });
  it('several Valve phases -> earliest display phase wins (fixed rule)', () => {
    const r = canonicalDisplayPhase(cand(1, { phase: withPhases('Luxury', 'Starting_Items') }));
    expect(r.phase).toBe('starting');
  });
  it('phase arrays in a different order produce the same canonical result', () => {
    const a = canonicalDisplayPhase(cand(1, { phase: withPhases('Late_Items', 'Core_Items') }));
    const b = canonicalDisplayPhase(cand(1, { phase: withPhases('Core_Items', 'Late_Items') }));
    expect(a).toEqual(b);
    expect(a.phase).toBe('core');
  });
  it('unavailable evidence -> NO_PHASE, never an invented phase', () => {
    const r = canonicalDisplayPhase(cand(1, { phase: { status: 'unavailable', source: 'ValveItemBuild', reason: 'no_phase' } }));
    expect(r.phase).toBe(NO_PHASE);
    expect(r.reason).toBe('no_phase');
  });
  it('Other_Items-only -> NO_PHASE (misc bucket, not a timed phase)', () => {
    expect(canonicalDisplayPhase(cand(1, { phase: withPhases('Other_Items') })).phase).toBe(NO_PHASE);
  });
  it('unknown Valve phase -> NO_PHASE, never a guessed phase', () => {
    expect(canonicalDisplayPhase(cand(1, { phase: withPhases('Unknown_Items') })).phase).toBe(NO_PHASE);
  });
});

describe('assembleBuild (§4, §6–§8, §12–§14)', () => {
  it('places candidates by canonical phase and orders inside phase by ItemPrior rank', () => {
    const build = assembleBuild(1, '1', [
      cand(30, { rank: 2, phase: withPhases('Core_Items') }),
      cand(10, { rank: 1, phase: withPhases('Core_Items') }),
      cand(50, { rank: 3, phase: withPhases('Late_Items') }),
    ]);
    expect(build.status).toBe(ASSEMBLY_STATUS.OK);
    expect(build.phases.core.map((i) => i.itemId)).toEqual([10, 30]);
    expect(build.phases.late.map((i) => i.itemId)).toEqual([50]);
    expect(build.phases.core[0].itemPriorRank).toBe(1);
    expect(build.phases.core[0].phaseEvidence.status).toBe('available');
  });
  it('dedupes one itemId to a single phase using canonical phase then rank', () => {
    const build = assembleBuild(1, '1', [
      cand(10, { rank: 5, phase: withPhases('Late_Items') }),
      cand(10, { rank: 1, phase: withPhases('Core_Items') }),
    ]);
    const all = [...build.phases.core, ...build.phases.late, ...build.overflow];
    expect(all.filter((i) => i.itemId === 10)).toHaveLength(1);
    expect(build.phases.core.map((i) => i.itemId)).toEqual([10]);
    expect(build.stats.droppedByDedupe).toBe(1);
  });
  it('phase evidence outranks ItemPrior rank when duplicate candidate rows conflict', () => {
    const unavailable = {
      status: 'unavailable', source: 'ValveItemBuild', reason: 'no_phase',
    };
    const build = assembleBuild(1, '1', [
      cand(10, { rank: 1, phase: unavailable }),
      cand(10, { rank: 20, phase: withPhases('Core_Items') }),
    ]);
    expect(build.phases.core.map((i) => i.itemId)).toEqual([10]);
    expect(build.overflow).toEqual([]);
  });
  it('existing supported phase agreement outranks weaker duplicate evidence', () => {
    const supported = withPhases('Core_Items');
    supported.value.agreement = { decision: 'supported', reason: 'agreement', families: ['mid'] };
    const undecided = withPhases('Core_Items');
    undecided.value.agreement = { decision: 'undecided', reason: 'not_decidable', families: ['mid'] };
    const build = assembleBuild(1, '1', [
      cand(10, { rank: 1, phase: undecided }),
      cand(10, { rank: 20, phase: supported }),
    ]);
    expect(build.phases.core[0].phaseEvidence.agreement.decision).toBe('supported');
  });
  it('drops wrong-cell candidates and applies capacity top-N (presentation cap)', () => {
    const cands = [];
    for (let id = 1; id <= 6; id += 1) cands.push(cand(id, { rank: id, phase: withPhases('Core_Items') }));
    cands.push({ ...cand(99, { rank: 99 }), heroId: 2 }); // another hero leaks in
    cands.push({ ...cand(98, { rank: 98 }), position: '2' }); // another lane leaks in
    const build = assembleBuild(1, '1', cands);
    expect(build.phases.core).toHaveLength(5); // CORE capacity
    expect(build.stats.droppedByCapacity).toBe(1);
    expect(build.stats.droppedWrongCell).toBe(2);
    expect(build.heroId).toBe(1);
    expect(build.position).toBe('1');
  });
  it('empty candidates -> NO_BUILD_DATA, no fallback to another cell', () => {
    const build = assembleBuild(1, '1', []);
    expect(build.status).toBe(ASSEMBLY_STATUS.NO_BUILD_DATA);
    expect(build.phases.core).toEqual([]);
    expect(build.position).toBe('1');
  });
  it('candidates from another hero or position cannot supply a fallback build', () => {
    const build = assembleBuild(1, '1', [
      { ...cand(7, { phase: withPhases('Core_Items') }), heroId: 2 },
      { ...cand(8, { phase: withPhases('Early_Game') }), position: '2' },
    ]);
    expect(build.status).toBe(ASSEMBLY_STATUS.NO_BUILD_DATA);
    expect(build.stats.droppedWrongCell).toBe(2);
    expect(build.phases).toEqual({
      starting: [], early: [], core: [], mid: [], late: [], luxury: [],
    });
  });
  it('UNAVAILABLE phases land in overflow, never force-fitted', () => {
    const build = assembleBuild(1, '1', [
      cand(7, { phase: { status: 'unavailable', source: 'ValveItemBuild', reason: 'no_phase' } }),
    ]);
    expect(build.overflow.map((i) => i.itemId)).toEqual([7]);
    expect(build.overflow[0].phase).toBe(NO_PHASE);
  });
  it('Other_Items is retained as provenance but never force-fitted into a phase', () => {
    const build = assembleBuild(1, '1', [
      cand(7, { phase: withPhases('Other_Items') }),
    ]);
    expect(build.overflow[0].phase).toBe(NO_PHASE);
    expect(build.overflow[0].phaseEvidence.phases).toEqual(['Other_Items']);
    expect(validateAssembledBuild(build, [7])).toEqual([]);
  });
  it('order does not depend on input order (full comparator to itemId)', () => {
    const mk = () => [
      cand(3, { rank: 3, score: 10, phase: withPhases('Core_Items') }),
      cand(1, { rank: 3, score: 10, phase: withPhases('Core_Items') }),
      cand(2, { rank: 3, score: 10, phase: withPhases('Core_Items') }),
    ];
    const a = assembleBuild(1, '1', mk());
    const b = assembleBuild(1, '1', [...mk()].reverse());
    expect(a.phases.core.map((i) => i.itemId)).toEqual([1, 2, 3]);
    expect(b.phases.core.map((i) => i.itemId)).toEqual([1, 2, 3]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it('normalizes Valve phase ordering in output provenance', () => {
    const a = assembleBuild(1, '1', [
      cand(7, { phase: withPhases('Late_Items', 'Core_Items') }),
    ]);
    const b = assembleBuild(1, '1', [
      cand(7, { phase: withPhases('Core_Items', 'Late_Items') }),
    ]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.phases.core[0].phaseEvidence.phases).toEqual(['Core_Items', 'Late_Items']);
  });
  it('does not serialize phase provenance according to evidence object key order', () => {
    const makeEvidence = (reverse) => {
      const agreement = reverse
        ? { detail: 'stable', families: ['late', 'mid'], reason: 'agreement', decision: 'supported' }
        : { decision: 'supported', reason: 'agreement', families: ['mid', 'late'], detail: 'stable' };
      return {
        status: 'available',
        source: 'ValveItemBuild',
        value: {
          phases: ['Core_Items', 'Late_Items'],
          phaseFamilies: reverse ? ['late', 'mid'] : ['mid', 'late'],
          phaseExclusive: false,
          agreement,
        },
      };
    };
    const a = assembleBuild(1, '1', [cand(7, { phase: makeEvidence(false) })]);
    const b = assembleBuild(1, '1', [cand(7, { phase: makeEvidence(true) })]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('validateAssembledBuild (§16)', () => {
  it('clean build has no violations and subset rule holds', () => {
    const cands = [cand(10, { rank: 1, phase: withPhases('Core_Items') })];
    const build = assembleBuild(1, '1', cands);
    expect(validateAssembledBuild(build, [10])).toEqual([]);
    for (const list of Object.values(build.phases)) {
      for (const it of list) expect([10]).toContain(it.itemId);
    }
  });
  it('flags duplicates and outside-candidate items', () => {
    const bad = assembleBuild(1, '1', [cand(10, { rank: 1, phase: withPhases('Core_Items') })]);
    bad.phases.late.push({ ...bad.phases.core[0], phase: 'late' });
    expect(validateAssembledBuild(bad, [10]).join(' ')).toMatch(/duplicate:10/);
    expect(validateAssembledBuild(bad, [11]).join(' ')).toMatch(/outside_candidates/);
  });
  it('rejects invalid phase, false canonical phase, and nondeterministic ties', () => {
    const bad = assembleBuild(1, '1', [
      cand(10, { rank: 1, phase: withPhases('Core_Items') }),
      cand(11, { rank: 1, phase: withPhases('Core_Items') }),
    ]);
    bad.phases.extra = [];
    bad.phases.core.reverse();
    bad.phases.core[0].phaseEvidence.phases = ['Late_Items'];
    const violations = validateAssembledBuild(bad, [10, 11]);
    expect(violations).toContain('phase_invalid:extra');
    expect(violations).toContain('rank_order:core');
    expect(violations).toContain(`phase_not_canonical:${bad.phases.core[0].itemId}`);
  });
  it('rejects a phase that exceeds its presentation capacity', () => {
    const bad = assembleBuild(1, '1', [
      cand(10, { rank: 1, phase: withPhases('Core_Items') }),
    ]);
    bad.phases.core.push(...Array.from({ length: 5 }, (_, index) => ({
      ...bad.phases.core[0],
      itemId: index + 20,
      itemPriorRank: index + 2,
    })));
    expect(validateAssembledBuild(bad).join(' ')).toContain('phase_capacity:core');
  });
});
