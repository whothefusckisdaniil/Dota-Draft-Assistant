import { describe, expect, it } from 'vitest';
import heroesData from '../../public/data/heroes.json';
import itemsData from '../../public/data/items.json';
import itemStatsData from '../../public/data/item-stats.json';
import positionsData from '../../public/data/positions.json';
import valveBuilds from '../../research/valve-itembuilds.json';
import type { BuildEngineDataset } from './buildEngine';
import { createBuildEngine } from './buildEngine';
import { getBuildCandidates } from './buildCandidates';
import { eligibleLanes } from './positionEligibility';
import { DISPLAY_PHASES, assembleBuild } from './buildAssembly.mjs';

const dataset: BuildEngineDataset = {
  heroes: heroesData.map((hero) => ({ ...hero, nameRu: '' })),
  positions: positionsData,
  items: itemsData,
  itemStats: itemStatsData,
};

const engine = createBuildEngine(dataset);
const valveHeroKeys = dataset.heroes.map(({ id, key }) => ({ id, key }));

describe('production build engine against committed dataset', () => {
  it('covers every eligible hero-position cell without fallback or structural violations', () => {
    const eligible = new Set<string>();
    const built = new Set<string>();
    let ineligible = 0;
    let noBuildData = 0;
    let emptyPhaseCells = 0;
    let longestGeneralList = 0;
    const noBuildCells: string[] = [];

    for (const hero of dataset.heroes) {
      const heroEligibleLanes = eligibleLanes(dataset.positions, hero.id);
      for (const position of ['1', '2', '3', '4', '5'] as const) {
        const key = `${hero.id}:${position}`;
        const result = engine.getBuild(hero.id, position);
        if (!heroEligibleLanes.includes(position)) {
          ineligible += 1;
          expect(result).toMatchObject({ status: 'ineligible-position', heroId: hero.id, position, items: [] });
          continue;
        }

        eligible.add(key);
        const candidates = getBuildCandidates({
          heroId: hero.id,
          position,
          heroes: valveHeroKeys,
          catalogue: dataset.items,
          itemStats: dataset.itemStats,
          valve: valveBuilds,
        });
        if (candidates.length === 0) {
          noBuildData += 1;
          noBuildCells.push(`${hero.name}:${position}`);
          expect(result).toMatchObject({ status: 'no-build-data', heroId: hero.id, position, items: [] });
          continue;
        }

        built.add(key);
        expect(result.status).toBe('ready');
        expect(result.heroId).toBe(hero.id);
        expect(result.position).toBe(position);

        const candidateIds = new Set(candidates.map((candidate) => candidate.itemId));
        const itemIds = result.items.map((item) => item.itemId);
        expect(new Set(itemIds).size).toBe(itemIds.length);
        expect(itemIds.every((itemId) => candidateIds.has(itemId))).toBe(true);
        expect(result.items.every((item) => item.phase === 'general' || DISPLAY_PHASES.includes(item.phase))).toBe(true);
        expect(result.items.every((item) => item.evidence.itemPrior.status === 'available')).toBe(true);
        longestGeneralList = Math.max(
          longestGeneralList,
          result.items.filter((item) => item.phase === 'general').length,
        );

        const expected = assembleBuild(hero.id, position, candidates);
        const expectedItems = [
          ...DISPLAY_PHASES.flatMap((phase) => expected.phases[phase] ?? []),
          ...expected.overflow,
        ];
        expect(result.items.map((item) => [item.itemId, item.phase, item.rank, item.itemPriorScore])).toEqual(
          expectedItems.map((item) => [
            item.itemId,
            item.phase === 'overflow' || item.phase === 'NO_PHASE' ? 'general' : item.phase,
            item.itemPriorRank,
            item.itemPriorScore,
          ]),
        );
        if (DISPLAY_PHASES.some((phase) => !(expected.phases[phase]?.length))) emptyPhaseCells += 1;
      }
    }

    expect(dataset.heroes).toHaveLength(127);
    expect(eligible.size).toBe(290);
    expect(built.size).toBe(288);
    expect(ineligible).toBe(345);
    expect(noBuildData).toBe(2);
    expect(noBuildCells).toEqual(['Chen:4', 'Visage:5']);
    expect(emptyPhaseCells).toBe(288);
    expect(longestGeneralList).toBeGreaterThan(20);
  }, 60_000);

  it('returns byte-identical production results when dataset object iteration order is reversed', () => {
    const reverseRecord = <T>(record: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(record).reverse());
    const reversedDataset: BuildEngineDataset = {
      heroes: [...dataset.heroes].reverse(),
      positions: reverseRecord(dataset.positions),
      items: reverseRecord(dataset.items),
      itemStats: Object.fromEntries(
        Object.entries(dataset.itemStats).reverse().map(([heroId, byPosition]) => [
          heroId,
          Object.fromEntries(
            Object.entries(byPosition).reverse().map(([position, byItem]) => [
              position,
              reverseRecord(byItem),
            ]),
          ),
        ]),
      ),
    };
    const reversedEngine = createBuildEngine(reversedDataset);

    for (const hero of dataset.heroes) {
      for (const position of eligibleLanes(dataset.positions, hero.id)) {
        expect(JSON.stringify(reversedEngine.getBuild(hero.id, position)))
          .toBe(JSON.stringify(engine.getBuild(hero.id, position)));
      }
    }
  }, 60_000);

  it('restores the same build when switching away from and back to a position', () => {
    const hero = dataset.heroes.find(({ name }) => name === 'Broodmother');
    expect(hero).toBeDefined();
    const positions = eligibleLanes(dataset.positions, hero!.id);
    expect(positions).toContain('2');
    expect(positions).toContain('3');
    const firstPosition = positions[0];
    const otherPosition = positions.find((position) => position !== firstPosition);
    expect(otherPosition).toBeDefined();
    const original = JSON.stringify(engine.getBuild(hero!.id, firstPosition));

    expect(JSON.stringify(engine.getBuild(hero!.id, otherPosition!))).not.toBe(original);
    expect(JSON.stringify(engine.getBuild(hero!.id, firstPosition))).toBe(original);
  });

  it('has production build data for the four manual QA heroes on their evidenced roles', () => {
    const cases = [
      ['Puck', '2'],
      ['Juggernaut', '1'],
      ['Tidehunter', '3'],
      ['Crystal Maiden', '5'],
    ] as const;

    for (const [name, position] of cases) {
      const hero = dataset.heroes.find((entry) => entry.name === name);
      expect(hero, `${name} is present in the production roster`).toBeDefined();
      expect(eligibleLanes(dataset.positions, hero!.id)).toContain(position);
      expect(engine.getBuild(hero!.id, position).status).toBe('ready');
    }
  });
});
