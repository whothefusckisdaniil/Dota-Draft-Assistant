/**
 * Rank semantics tests (ТЗ §25.2).
 *
 * The bug these lock down: a 5-wide bracket range was labelled as a PAIR of
 * brackets, so an experiment described as "Herald/Guardian" actually sampled
 * Herald only, and "Divine/Immortal" sampled Archon.
 */
import { describe, expect, it } from 'vitest';
import {
  BRACKETS,
  BROAD_BUCKETS,
  bracketLabel,
  bracketOf,
  broadBucketOf,
  exactStrata,
} from './rank-buckets.mjs';

describe('the OpenDota rank scale (§1)', () => {
  it('is eight brackets: seven bands plus a single Immortal tier', () => {
    expect(BRACKETS).toHaveLength(8);
    // 10-15 is six integer tiers, not five: Herald I..V plus the base tier.
    for (const b of BRACKETS.slice(0, 7)) expect(b.max - b.min).toBe(5);
    expect(BRACKETS[7]).toMatchObject({ key: 'immortal', min: 80, max: 80 });
  });

  it('labels a band with a single bracket name, never a pair', () => {
    // The original defect: `Herald/Guardian` on the range 10-15.
    for (const b of BRACKETS) expect(b.label).not.toContain('/');
  });

  it('uses the documented bases', () => {
    expect(BRACKETS.map((b) => b.min)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  it('never leaves a gap or an overlap', () => {
    const sorted = [...BRACKETS].sort((a, b) => a.min - b.min);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i].min).toBeGreaterThan(sorted[i - 1].max);
    }
  });
});

describe('bracketOf — one tier belongs to exactly one bracket', () => {
  it('maps the tier range the old code mislabelled', () => {
    // 10-15 is Herald alone, NOT "Herald/Guardian".
    expect(bracketLabel(12)).toBe('Herald');
    expect(bracketLabel(15)).toBe('Herald');
    expect(bracketLabel(21)).toBe('Guardian');
    expect(bracketLabel(35)).toBe('Crusader');
    expect(bracketLabel(45)).toBe('Archon');
  });

  it('covers the high brackets the old scale skipped entirely', () => {
    expect(bracketLabel(55)).toBe('Legend');
    expect(bracketLabel(65)).toBe('Ancient');
    expect(bracketLabel(70)).toBe('Divine');
    expect(bracketLabel(80)).toBe('Immortal');
  });

  it('returns null for an off-scale tier rather than guessing', () => {
    for (const t of [0, 5, 9, 16, 19, 81, 100, null, undefined]) {
      expect(bracketOf(t), String(t)).toBeNull();
    }
    expect(bracketLabel(99)).toBe('unmapped(99)');
  });
});

describe('BROAD_BUCKETS — the four calibrated spans', () => {
  it('merges two adjacent brackets each, and says which', () => {
    expect(BROAD_BUCKETS).toHaveLength(4);
    for (const b of BROAD_BUCKETS) expect(b.brackets).toHaveLength(2);
  });

  it('uses the ranges from §1', () => {
    expect(BROAD_BUCKETS.map((b) => [b.min, b.max])).toEqual([
      [10, 25], [30, 45], [50, 65], [70, 80],
    ]);
  });

  it('places every on-scale tier in exactly one broad bucket', () => {
    for (const b of BRACKETS) {
      const tier = b.min;
      const broad = broadBucketOf(tier);
      expect(broad, `tier ${tier}`).not.toBeNull();
      expect(broad.brackets, `tier ${tier}`).toContain(b.key);
    }
  });

  it('spans Divine and Immortal together for the top bucket', () => {
    const top = broadBucketOf(80);
    expect(top.key).toBe('divine_immortal');
    expect(top.brackets).toEqual(['divine', 'immortal']);
  });
});

describe('exactStrata — what an executed experiment really sampled', () => {
  it('names the single bracket, not the broad pair', () => {
    // The tiers present in the executed 16-match plan.
    expect([12, 14].map(exactStrata)).toEqual(['Herald', 'Herald']);
    expect([21, 22, 23].map(exactStrata)).toEqual(['Guardian', 'Guardian', 'Guardian']);
    expect([32, 35].map(exactStrata)).toEqual(['Crusader', 'Crusader']);
    expect([43, 45].map(exactStrata)).toEqual(['Archon', 'Archon']);
  });

  it('shows the executed sample covered no Legend/Ancient or Divine/Immortal', () => {
    const executed = [12, 14, 21, 22, 23, 32, 35, 43, 45];
    const strata = new Set(executed.map(exactStrata));
    expect([...strata].sort()).toEqual(['Archon', 'Crusader', 'Guardian', 'Herald']);
    expect(strata.has('Legend')).toBe(false);
    expect(strata.has('Ancient')).toBe(false);
    expect(strata.has('Divine')).toBe(false);
    expect(strata.has('Immortal')).toBe(false);
  });
});
