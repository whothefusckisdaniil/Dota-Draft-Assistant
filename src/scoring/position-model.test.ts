/**
 * §19: the shipped snapshot must not put cores on support lanes.
 *
 * Unlike positionEligibility.test.ts (synthetic fixtures), this runs the REAL
 * production data through the REAL engine, so it fails if a future refresh
 * regresses the gate — not if a hero's real pick rate drifts within reason.
 *
 * The named heroes are regression EXAMPLES, not rules: nothing here is
 * hero-specific in the implementation, and no hero id is special-cased in
 * positionEligibility.ts. These assertions say the general rule keeps producing
 * the right answer on the data we actually ship.
 */
import { describe, expect, it } from 'vitest';
import heroesRaw from '../../public/data/heroes.json';
import matchupsRaw from '../../public/data/matchups.json';
import positionsRaw from '../../public/data/positions.json';
import metaRaw from '../../public/data/meta.json';
import type { Hero, MatchupRow, PositionDataset } from '../types';
import { scoreCandidates } from './engine';
import type { Lane } from './positionsExtra';
import { isEligibleAt } from './positionEligibility';

const heroes = heroesRaw as unknown as Hero[];
const tables = matchupsRaw as unknown as Record<string, MatchupRow[]>;
const meta = metaRaw as unknown as {
  positionData?: { weeklyBuckets: number[]; population: { brackets: string[] } };
  matchupWindow?: { weeklyBuckets: number[] };
};
const positionById = Object.fromEntries(
  Object.entries(positionsRaw as unknown as Record<string, PositionDataset[number]>).map(([k, v]) => [Number(k), v]),
) as PositionDataset;

const byName = new Map(heroes.map((h) => [h.name, h.id]));
const idOf = (name: string) => {
  const id = byName.get(name);
  if (id === undefined) throw new Error(`hero not in dataset: ${name}`);
  return id;
};

describe('production snapshot: position layer matches the matchup layer (§6, §15)', () => {
  it('positions and matchups come from the same weekly buckets and brackets', () => {
    expect(meta.positionData?.weeklyBuckets).toEqual(meta.matchupWindow?.weeklyBuckets);
    expect(meta.positionData?.population.brackets).toEqual([
      'HERALD_GUARDIAN', 'CRUSADER_ARCHON', 'LEGEND_ANCIENT', 'DIVINE_IMMORTAL',
    ]);
  });

  it('positions cover exactly the canonical roster', () => {
    expect(Object.keys(positionById).length).toBe(heroes.length);
    for (const h of heroes) expect(positionById[h.id], h.name).toBeTruthy();
  });
});

describe('production snapshot: the §8 edge cases resolve correctly', () => {
  const CASES: Array<[string, Lane[], Lane[]]> = [
    ['Wraith King', ['1', '3'], ['4', '5']],
    ['Meepo', ['1', '2'], ['4', '5']],
    ['Bane', ['4', '5'], ['1']],
    ['Tusk', ['3', '4', '5'], ['1']],
    ['Rubick', ['4', '5'], ['1']],
    ['Kunkka', ['2', '3'], ['4', '5']],
    ['Puck', ['2'], ['1', '3', '4', '5']],
    ['Mirana', ['4', '5'], ['1']],
    ['Clockwerk', ['3', '4', '5'], ['1', '2']],
    // Pudge is genuinely flex: 35% pos4, 29% pos5, 22% pos3 — and 12.6% pos2
    // (227k games), which clears the 8% bar. That is what the data says, so
    // the test records it rather than pretending the mid games do not exist.
    ['Pudge', ['2', '3', '4', '5'], ['1']],
  ];

  for (const [name, yes, no] of CASES) {
    it(`${name}: allowed [${yes}] / blocked [${no}]`, () => {
      const id = idOf(name);
      for (const lane of yes) {
        expect(isEligibleAt(positionById, id, lane), `${name} pos${lane}`).toBe(true);
      }
      for (const lane of no) {
        expect(isEligibleAt(positionById, id, lane), `${name} pos${lane}`).toBe(false);
      }
    });
  }
});
