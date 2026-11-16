import { describe, expect, it } from 'vitest';
import {
  canonicalPairId,
  relativeDeltaA,
  symmetricDMax,
  symmetricDMean,
  diagnosePair,
  diagnoseDataset,
  hashQuery,
  rowHasOrientationProblem,
} from './stratz-matchup-asymmetry-lib.mjs';

describe('canonicalPairId', () => {
  it('maps A->B and B->A to the same canonical key', () => {
    expect(canonicalPairId(32, 43)).toBe('32:43');
    expect(canonicalPairId(43, 32)).toBe('32:43');
  });

  it('produces min:max ordering', () => {
    expect(canonicalPairId(100, 10)).toBe('10:100');
  });
});

describe('relativeDeltaA', () => {
  it('returns 0 for equal values', () => {
    expect(relativeDeltaA(100, 100)).toBe(0);
  });

  it('returns correct relative delta', () => {
    expect(relativeDeltaA(100, 130)).toBe(0.3);
    expect(relativeDeltaA(130, 100)).toBeCloseTo(30 / 130, 6);
  });

  it('returns 0 when gamesA is 0', () => {
    expect(relativeDeltaA(0, 100)).toBe(0);
  });
});

describe('symmetricDMax', () => {
  it('returns 0 for equal values', () => {
    expect(symmetricDMax(100, 100)).toBe(0);
  });

  it('returns correct D_max', () => {
    expect(symmetricDMax(100, 130)).toBe(30 / 130);
  });
});

describe('symmetricDMean', () => {
  it('returns 0 for equal values', () => {
    expect(symmetricDMean(100, 100)).toBe(0);
  });

  it('returns correct D_mean', () => {
    expect(symmetricDMean(100, 130)).toBe((2 * 30) / 230);
  });
});

describe('diagnosePair', () => {
  it('passes when within threshold', () => {
    const d = diagnosePair(32, 43, 100, 50, 95, 47);
    expect(d.validationStatus).toBe('PASS');
    expect(d.thresholdExceeded).toBe(false);
    expect(d.canonicalPairId).toBe('32:43');
  });

  it('fails when relative >3% AND absolute >15', () => {
    const d = diagnosePair(32, 43, 100, 50, 70, 30);
    expect(d.validationStatus).toBe('FAIL');
    expect(d.thresholdExceeded).toBe(true);
    expect(d.absoluteGamesDelta).toBe(30);
    expect(d.relativeDeltaA).toBe(0.3);
  });

  it('passes when relative >3% but absolute <=15', () => {
    const d = diagnosePair(32, 43, 100, 50, 86, 43);
    expect(d.validationStatus).toBe('PASS');
  });

  it('passes when absolute >15 but relative <=3%', () => {
    const d = diagnosePair(32, 43, 1000, 500, 1015, 510);
    expect(d.validationStatus).toBe('PASS');
  });

  it('computes symmetric metrics', () => {
    const d = diagnosePair(32, 43, 100, 50, 70, 30);
    expect(d.symmetricRelativeDeltaDMax).toBe(30 / 100);
    expect(d.symmetricRelativeDeltaDMean).toBeCloseTo((2 * 30) / 170, 6);
  });
});

describe('diagnoseDataset', () => {
  function row(hero_id: number, games_played: number, wins: number) {
    return { hero_id, games_played, wins };
  }

  it('counts directed violations and unique pairs correctly', () => {
    const dataset: Record<string, { hero_id: number; games_played: number; wins: number }[]> = {
      '1': [row(2, 100, 50), row(3, 100, 50)],
      '2': [row(1, 70, 30), row(3, 100, 50)],
      '3': [row(1, 100, 50), row(2, 100, 50)],
    };
    const result = diagnoseDataset(dataset);
    // Pair 1-2: 1->2 has 100 vs 70 (rel=0.30, abs=30 -> FAIL); 2->1 has 70 vs 100 (rel=0.428, abs=30 -> FAIL)
    // 2 directed violations, 1 unique pair
    expect(result.directedViolations).toBe(2);
    expect(result.uniqueViolationPairs).toBe(1);
  });

  it('does not double count A->B and B->A as two unique pairs', () => {
    const dataset: Record<string, { hero_id: number; games_played: number; wins: number }[]> = {
      '1': [row(2, 100, 50)],
      '2': [row(1, 70, 30)],
    };
    const result = diagnoseDataset(dataset);
    expect(result.uniqueViolationPairs).toBe(1);
    expect(result.directedViolations).toBe(2);
  });

  it('passes a perfectly balanced dataset', () => {
    const dataset: Record<string, { hero_id: number; games_played: number; wins: number }[]> = {
      '1': [row(2, 100, 50)],
      '2': [row(1, 100, 50)],
    };
    const result = diagnoseDataset(dataset);
    expect(result.directedViolations).toBe(0);
    expect(result.uniqueViolationPairs).toBe(0);
  });

  it('represents a missing reverse as null instead of zero', () => {
    const result = diagnoseDataset({ '1': [row(2, 100, 50)] });
    expect(result.pairDiagnoses[0]).toMatchObject({
      status: 'MISSING_REVERSE',
      gamesA: 100,
      gamesB: null,
      winsB: null,
      thresholdExceeded: null,
    });
  });

  it('does not count a missing reverse as a threshold violation', () => {
    const result = diagnoseDataset({ '1': [row(2, 1000, 500)] });
    expect(result.directedViolations).toBe(0);
    expect(result.uniqueViolationPairs).toBe(0);
  });

  it('counts unique pairs missing their reverse direction', () => {
    const result = diagnoseDataset({
      '1': [row(2, 100, 50), row(3, 100, 50)],
      '2': [row(3, 100, 50)],
    });
    expect(result.missingReversePairCount).toBe(3);
  });

  it('marks both sides DUPLICATE_DIRECTION when only A→B is duplicated', () => {
    const result = diagnoseDataset({
      '1': [row(2, 100, 50), row(2, 200, 100)],
      '2': [row(1, 100, 50)],
    });
    expect(result.duplicateDirectionCount).toBe(1);
    expect(result.allRows.map((item) => item.status)).toEqual([
      'DUPLICATE_DIRECTION', 'DUPLICATE_DIRECTION', 'DUPLICATE_DIRECTION',
    ]);
    expect(result.checkedDirectionCount).toBe(0);
    expect(result.directedViolations).toBe(0);
  });

  it('marks both sides DUPLICATE_DIRECTION when only B→A is duplicated', () => {
    const result = diagnoseDataset({
      '1': [row(2, 100, 50)],
      '2': [row(1, 100, 50), row(1, 120, 60)],
    });
    expect(result.allRows).toHaveLength(3);
    expect(result.allRows.every((item) => item.status === 'DUPLICATE_DIRECTION')).toBe(true);
    expect(result.checkedDirectionCount).toBe(0);
    expect(result.duplicateDirectionCount).toBe(1);
  });

  it('counts both duplicated directions as two duplicated directed groups', () => {
    const result = diagnoseDataset({
      '1': [row(2, 100, 50), row(2, 120, 60)],
      '2': [row(1, 100, 50), row(1, 120, 60)],
    });
    expect(result.duplicateDirectionCount).toBe(2);
    expect(result.allRows).toHaveLength(4);
    expect(result.allRows.every((item) => item.status === 'DUPLICATE_DIRECTION')).toBe(true);
    expect(result.checkedDirectionCount).toBe(0);
  });

  it('counts three duplicate rows as one duplicated directed group', () => {
    const result = diagnoseDataset({
      '1': [row(2, 100, 50), row(2, 120, 60), row(2, 130, 65)],
      '2': [row(1, 100, 50)],
    });
    expect(result.duplicateDirectionCount).toBe(1);
    expect(result.allRows).toHaveLength(4);
    expect(result.allRows.every((item) => item.status === 'DUPLICATE_DIRECTION')).toBe(true);
    expect(result.checkedDirectionCount).toBe(0);
  });

  it('excludes every direction of an ambiguous pair from checkedDirectionCount', () => {
    const result = diagnoseDataset({
      '1': [row(2, 100, 50), row(2, 120, 60), row(3, 100, 50)],
      '2': [row(1, 100, 50)],
      '3': [row(1, 100, 50)],
    });
    expect(result.checkedDirectionCount).toBe(2);
    expect(result.allRows.filter((item) => item.status === 'DUPLICATE_DIRECTION')).toHaveLength(3);
  });

  it('counts both failing directed comparisons but only one unordered pair', () => {
    const result = diagnoseDataset({
      '1': [row(2, 100, 50)],
      '2': [row(1, 70, 30)],
    });
    expect(result.directedViolations).toBe(2);
    expect(result.uniqueViolationPairs).toBe(1);
    expect(result.pairDiagnoses).toHaveLength(1);
  });

  it('keeps D_max and D_mean metrics on a unique normal pair', () => {
    const result = diagnoseDataset({
      '1': [row(2, 100, 50)],
      '2': [row(1, 70, 35)],
    });
    expect(result.pairDiagnoses[0].symmetricRelativeDeltaDMax).toBe(0.3);
    expect(result.pairDiagnoses[0].symmetricRelativeDeltaDMean).toBeCloseTo(60 / 170, 6);
  });

  it('uses the production 3% AND 15-game threshold', () => {
    expect(diagnosePair(1, 2, 100, 50, 85, 40).thresholdExceeded).toBe(false);
    expect(diagnosePair(1, 2, 100, 50, 84, 40).thresholdExceeded).toBe(true);
  });

  it('retains the relative delta denominator and wins-sum semantics', () => {
    const diagnosis = diagnosePair(1, 2, 100, 55, 80, 40);
    expect(diagnosis.relativeDeltaA).toBe(0.2);
    expect(diagnosis.relativeDeltaB).toBe(0.25);
    expect(diagnosis.winsSumDelta).toBe(5);
  });

  it('returns deterministic pair ordering', () => {
    const dataset = {
      '9': [row(20, 100, 50), row(3, 100, 50)],
      '1': [row(8, 100, 50)],
    };
    expect(diagnoseDataset(dataset).pairDiagnoses.map((pair) => pair.canonicalPairId))
      .toEqual(['1:8', '3:9', '9:20']);
  });
});

describe('hashQuery', () => {
  it('produces deterministic 16-char hex hash', () => {
    const h1 = hashQuery('{ matchUp { heroId vs { heroId1 } } }');
    const h2 = hashQuery('{ matchUp { heroId vs { heroId1 } } }');
    expect(h1).toBe(h2);
    expect(h1.length).toBe(16);
    expect(/^[0-9a-f]{16}$/.test(h1)).toBe(true);
  });
});

describe('rowHasOrientationProblem', () => {
  it('returns false when enemyId matches heroId1', () => {
    expect(rowHasOrientationProblem(32, 32, 43)).toBe(false);
  });

  it('returns false when enemyId matches heroId2', () => {
    expect(rowHasOrientationProblem(32, 43, 32)).toBe(false);
  });

  it('returns true when enemyId matches neither', () => {
    expect(rowHasOrientationProblem(32, 10, 20)).toBe(true);
  });

  it('returns true for null values', () => {
    expect(rowHasOrientationProblem(32, null, 43)).toBe(true);
    expect(rowHasOrientationProblem(32, 43, null)).toBe(true);
  });
});