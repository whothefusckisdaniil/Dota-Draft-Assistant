export const DISPLAY_PHASES: readonly [
  'starting',
  'early',
  'core',
  'mid',
  'late',
  'luxury',
];
export const PHASE_CAPACITY: Readonly<Record<string, number>>;
export const NO_PHASE: 'NO_PHASE';
export const OVERFLOW_PHASE: 'overflow';
export const VALVE_TO_DISPLAY: Readonly<Record<string, string>>;
export const ASSEMBLY_STATUS: Readonly<{
  OK: 'OK';
  NO_BUILD_DATA: 'NO_BUILD_DATA';
}>;

export interface AssembledItem {
  itemId: number;
  phase: string;
  itemPriorRank: number | null;
  itemPriorScore: number | null;
  phaseEvidence: {
    status: string;
    source?: string;
    reason?: string;
    phases: string[];
    phaseFamilies?: string[];
    phaseExclusive?: boolean;
    agreement?: {
      decision: string;
      reason: string;
      families: string[];
      detail: string;
    };
  };
  phaseReason: string | null;
}

export interface AssembledBuild {
  heroId: number;
  position: string;
  status: 'OK' | 'NO_BUILD_DATA';
  phases: Record<string, AssembledItem[]>;
  overflow: AssembledItem[];
  stats: {
    candidateCount: number;
    uniqueCount: number;
    droppedByDedupe: number;
    droppedWrongCell: number;
    overflowCount: number;
    droppedByCapacity: number;
    emptyPhases: string[];
  };
}

export function canonicalDisplayPhase(candidate: unknown): {
  phase: string;
  reason: string | null;
};
export function assembleBuild(
  heroId: number,
  position: string | number,
  candidates: readonly unknown[],
): AssembledBuild;
export function validateAssembledBuild(
  build: AssembledBuild,
  candidateIds?: Iterable<number>,
): string[];
