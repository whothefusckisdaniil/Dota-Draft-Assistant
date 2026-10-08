import valveBuilds from '../../research/valve-itembuilds.json';
import { loadDataset, type Dataset } from '../data/dataset';
import type { BuildPhasePrior } from './buildPhasePrior';
import { getBuildCandidates } from './buildCandidates';
import { isEligibleAt } from './positionEligibility';
import type { Lane } from './positionsExtra';
import {
  ASSEMBLY_STATUS,
  DISPLAY_PHASES,
  assembleBuild,
} from './buildAssembly.mjs';
import type { AssembledItem } from './buildAssembly.mjs';

export type BuildPhase = (typeof DISPLAY_PHASES)[number] | 'general';
export type BuildPosition = Lane;

export interface BuildEvidence {
  itemPrior: BuildPhasePrior['itemPrior'];
  timing: BuildPhasePrior['timing'];
  valveHero: BuildPhasePrior['valveHero'];
  valveItem: BuildPhasePrior['valveItem'];
  phase: BuildPhasePrior['phase'];
}

export interface RecommendedBuildItem {
  itemId: number;
  /** Existing ItemPrior rank, not a purchase-sequence rank. */
  rank: number;
  /** `general` means no mappable Valve phase; it is not a Valve phase label. */
  phase: BuildPhase;
  itemPriorScore: number;
  evidence: BuildEvidence;
}

export type BuildResultStatus = 'ready' | 'no-build-data' | 'ineligible-position';

export interface ProductionBuild {
  heroId: number;
  position: BuildPosition;
  status: BuildResultStatus;
  items: RecommendedBuildItem[];
  confidence: {
    status: 'not-calibrated';
    reason: string;
  };
  caveats: string[];
}

const CONFIDENCE = Object.freeze({
  status: 'not-calibrated' as const,
  reason: 'No calibrated build-confidence model exists; no confidence score is inferred.',
});

const CAVEATS = Object.freeze([
  'Recommendations are based on historical Hero + Position item purchase patterns.',
  'Valve build phases are categorical source labels, not minute timings.',
  'Order within a phase is ItemPrior presentation rank, not exact purchase order.',
  'Items in General have no mappable Valve phase; General is not a source phase.',
  'The model does not use enemy draft, capabilities, win-based weights, slots, or item dependencies.',
]);

export type BuildEngineDataset = Pick<
  Dataset,
  'heroes' | 'positions' | 'items' | 'itemStats'
>;

export interface BuildEngine {
  getBuild(heroId: number, position: BuildPosition): ProductionBuild;
}

function evidenceFor(candidate: ReturnType<typeof getBuildCandidates>[number]): BuildEvidence {
  const {
    itemPrior,
    timing,
    valveHero,
    valveItem,
    phase,
  } = candidate.evidence;
  return { itemPrior, timing, valveHero, valveItem, phase };
}

function toRecommendedItem(
  item: AssembledItem,
  candidate: ReturnType<typeof getBuildCandidates>[number],
  phase: BuildPhase,
): RecommendedBuildItem {
  return {
    itemId: item.itemId,
    rank: candidate.rank,
    phase,
    itemPriorScore: candidate.itemPrior.score,
    evidence: evidenceFor(candidate),
  };
}

function emptyBuild(
  heroId: number,
  position: BuildPosition,
  status: Exclude<BuildResultStatus, 'ready'>,
): ProductionBuild {
  return {
    heroId,
    position,
    status,
    items: [],
    confidence: CONFIDENCE,
    caveats: [...CAVEATS],
  };
}

/**
 * Bind the existing dataset to the production build getter. The returned API
 * is synchronous and deterministic; loading is handled by the convenience
 * `getBuild()` export below.
 */
export function createBuildEngine(dataset: BuildEngineDataset): BuildEngine {
  const heroes = dataset.heroes.map(({ id, key }) => ({ id, key }));

  return {
    getBuild(heroId: number, position: BuildPosition): ProductionBuild {
      if (!Number.isInteger(heroId) || heroId < 1) {
        throw new RangeError(`getBuild: heroId must be a positive integer, received ${String(heroId)}`);
      }
      if (!['1', '2', '3', '4', '5'].includes(position)) {
        throw new RangeError(`getBuild: position must be "1" through "5", received ${String(position)}`);
      }
      if (!dataset.heroes.some((hero) => hero.id === heroId)) {
        return emptyBuild(heroId, position, 'no-build-data');
      }
      if (!isEligibleAt(dataset.positions, heroId, position)) {
        return emptyBuild(heroId, position, 'ineligible-position');
      }

      const candidates = getBuildCandidates({
        heroId,
        position,
        heroes,
        catalogue: dataset.items,
        itemStats: dataset.itemStats,
        valve: valveBuilds,
      });
      if (candidates.length === 0) {
        return emptyBuild(heroId, position, 'no-build-data');
      }

      const assembled = assembleBuild(heroId, position, candidates);
      const candidateById = new Map(candidates.map((candidate) => [candidate.itemId, candidate]));
      const items: RecommendedBuildItem[] = [];
      for (const phase of DISPLAY_PHASES) {
        for (const item of assembled.phases[phase] ?? []) {
          const candidate = candidateById.get(item.itemId);
          if (!candidate) {
            throw new Error(`getBuild: assembler returned item ${item.itemId} outside BuildCandidates`);
          }
          items.push(toRecommendedItem(item, candidate, phase));
        }
      }
      for (const item of assembled.overflow) {
        const candidate = candidateById.get(item.itemId);
        if (!candidate) {
          throw new Error(`getBuild: assembler returned item ${item.itemId} outside BuildCandidates`);
        }
        items.push(toRecommendedItem(item, candidate, 'general'));
      }

      const itemIds = new Set(items.map((item) => item.itemId));
      if (itemIds.size !== items.length) {
        throw new Error(`getBuild: assembler returned duplicate item ids for hero ${heroId}, position ${position}`);
      }
      return {
        heroId,
        position,
        status: assembled.status === ASSEMBLY_STATUS.OK ? 'ready' : 'no-build-data',
        items,
        confidence: CONFIDENCE,
        caveats: [...CAVEATS],
      };
    },
  };
}

/** Production-facing API: use the loaded local snapshot; no runtime API calls. */
export async function getBuild(
  heroId: number,
  position: BuildPosition,
): Promise<ProductionBuild> {
  const dataset = await loadDataset();
  return createBuildEngine(dataset).getBuild(heroId, position);
}
