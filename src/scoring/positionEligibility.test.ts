/**
 * Empirical position eligibility (ТЗ №9 §18.1).
 *
 * These run on SYNTHETIC fixtures on purpose. Asserting the shipped numbers
 * would bake one week's pick rates into the test suite: a hero whose real share
 * moves 8% -> 7.9% would fail the build for no reason, and worse, tuning the
 * fixture until the named heroes pass would be fitting the threshold to the
 * examples instead of deriving it (which §9 forbids). The regression against
 * the REAL snapshot lives in position-model.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  eligibleLanes,
  isEligibleAt,
  positionEligibility,
  POSITION_ELIGIBILITY,
} from './positionEligibility';
import type { PositionDataset } from '../types';

/** Build an entry from per-lane shares; games are derived so the floor is meaningful. */
function entry(shares: [number, number, number, number, number], totalGames = 100_000) {
  const positions = Object.fromEntries(
    shares.map((s, i) => [String(i + 1), { games: Math.round(s * totalGames), share: s }]),
  );
  return { totalGames, positions: positions as never };
}

const ds = (e: Record<number, ReturnType<typeof entry>>) => e as unknown as PositionDataset;

describe('position eligibility — the §18 regression examples', () => {
  it('Meepo is a core: 55/35/10/0/0 → pos4 and pos5 are out', () => {
    const m = ds({ 82: entry([0.55, 0.35, 0.1, 0, 0]) });
    expect(isEligibleAt(m, 82, '4')).toBe(false);
    expect(isEligibleAt(m, 82, '5')).toBe(false);
    expect(isEligibleAt(m, 82, '1')).toBe(true);
    expect(isEligibleAt(m, 82, '2')).toBe(true);
  });

  it('Wraith King is a carry: 40/0/55/0.03/0.02 → pos4 and pos5 are out', () => {
    const wk = ds({ 52: entry([0.4, 0, 0.55, 0.03, 0.02]) });
    expect(isEligibleAt(wk, 52, '4')).toBe(false);
    expect(isEligibleAt(wk, 52, '5')).toBe(false);
    expect(isEligibleAt(wk, 52, '1')).toBe(true);
    expect(isEligibleAt(wk, 52, '3')).toBe(true);
  });

  it('Bane is a support: 0/0/0/40/60 → pos4 and pos5 stay available', () => {
    const bane = ds({ 1: entry([0, 0, 0, 0.4, 0.6]) });
    expect(isEligibleAt(bane, 1, '4')).toBe(true);
    expect(isEligibleAt(bane, 1, '5')).toBe(true);
    expect(isEligibleAt(bane, 1, '1')).toBe(false);
  });
});

describe('position eligibility — flex heroes (§14)', () => {
  it('keeps every lane that clears the threshold, not just the top one', () => {
    // 45/0/35/20/0 — a genuine flex carry, not an off-pick.
    const flex = ds({ 7: entry([0.45, 0, 0.35, 0.2, 0]) });
    expect(eligibleLanes(flex, 7)).toEqual(['1', '3', '4']);
  });

  it('a rare off-role pick does not qualify even on a four-position spread', () => {
    // 96/0/0/2/2 — a hard carry that occasionally shows up on pos4.
    const strict = ds({ 8: entry([0.96, 0, 0, 0.02, 0.02]) });
    expect(isEligibleAt(strict, 8, '1')).toBe(true);
    expect(isEligibleAt(strict, 8, '4')).toBe(false);
    expect(isEligibleAt(strict, 8, '5')).toBe(false);
    expect(eligibleLanes(strict, 8)).toEqual(['1']);
  });
});

describe('position eligibility — both thresholds must hold (§13)', () => {
  it('rejects a position with a good share but too few games', () => {
    // 25% share, but only 100 games in the window — a handful of games.
    const thin = ds({ 9: entry([0.25, 0, 0, 0.25, 0.5], 400) });
    const v = positionEligibility(thin, 9, '5');
    expect(v.share).toBeGreaterThan(POSITION_ELIGIBILITY.minShare);
    expect(v.games).toBeLessThan(POSITION_ELIGIBILITY.minGames);
    expect(v.eligible).toBe(false);
  });

  it('rejects a position with many games but a negligible share', () => {
    const wide = ds({ 10: entry([0.5, 0.1, 0.1, 0.15, 0.15], 1_000_000) });
    // pos4: 15% share, 150k games — both clear, so this one IS eligible.
    expect(isEligibleAt(wide, 10, '4')).toBe(true);
    // pos2: 10% share, 100k games — also clears the 8% bar.
    expect(isEligibleAt(wide, 10, '2')).toBe(true);
  });

  it('is fail-closed for a hero with no position data at all', () => {
    expect(isEligibleAt(ds({}), 12345, '1')).toBe(false);
    expect(isEligibleAt(undefined, 12345, '1')).toBe(false);
    expect(eligibleLanes(undefined, 12345)).toEqual([]);
  });
});

/**
 * The generator (scripts/stratz/eligibility.mjs), the published meta.json and
 * the app must all agree on the thresholds. If the generator ships a different
 * number than the app enforces, the dataset is self-describing a rule the
 * ranking does not follow — a silent, permanent mismatch. meta.json is the
 * right thing to compare against: it is written from the generator's constant,
 * so this asserts the whole chain at once.
 */
describe('threshold contract', () => {
  it('the shipped meta.json records exactly the thresholds the app enforces', async () => {
    const meta = (await import('../../public/data/meta.json', { with: { type: 'json' } })).default as {
      positionData?: { eligibility?: { minShare: number; minGames: number } };
    };
    expect(meta.positionData?.eligibility?.minShare).toBe(POSITION_ELIGIBILITY.minShare);
    expect(meta.positionData?.eligibility?.minGames).toBe(POSITION_ELIGIBILITY.minGames);
  });
});

