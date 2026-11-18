import type { PositionDataset } from '../types';
import type { Lane } from './positionsExtra';

/** Who shares a lane: safe lane 1 + 5, off lane 3 + 4, mid alone. */
export const LANE_PARTNER: Record<Lane, Lane | null> = { 1: '5', 5: '1', 3: '4', 4: '3', 2: null };

export interface AllyPosition {
  pos: Lane;
  /** Guessed from the hero's usual positions (not set by the user). */
  auto: boolean;
}

const LANES: Lane[] = ['1', '2', '3', '4', '5'];

/**
 * Positions of your allies. Set ones are kept; the rest are guessed greedily:
 * the ally most tied to a free position takes it first (Shadow Shaman → 5,
 * Undying → 4), never your own role. Heroes without position data get any
 * free position.
 */
export function assignAllyPositions(
  allyIds: number[],
  positions: PositionDataset,
  overrides: Record<number, Lane>,
  myPos: Lane | null,
): Map<number, AllyPosition> {
  const out = new Map<number, AllyPosition>();
  const taken = new Set<Lane>(myPos ? [myPos] : []);
  for (const id of allyIds) {
    const p = overrides[id];
    if (p) { out.set(id, { pos: p, auto: false }); taken.add(p); }
  }
  const open = allyIds.filter((id) => !out.has(id));
  while (open.length) {
    let best: { id: number; pos: Lane; share: number } | null = null;
    for (const id of open) {
      for (const pos of LANES) {
        if (taken.has(pos)) continue;
        const share = positions[id]?.positions?.[pos]?.share ?? 0;
        if (!best || share > best.share) best = { id, pos, share };
      }
    }
    if (!best) {
      // more allies than free positions (overrides collided): reuse the hero's main one
      for (const id of open) out.set(id, { pos: LANES.reduce((a, b) => ((positions[id]?.positions?.[b]?.share ?? 0) > (positions[id]?.positions?.[a]?.share ?? 0) ? b : a)), auto: true });
      break;
    }
    out.set(best.id, { pos: best.pos, auto: true });
    taken.add(best.pos);
    open.splice(open.indexOf(best.id), 1);
  }
  return out;
}

/** The ally on your lane when you play `myPos`, if positions say so. */
export function lanePartner(myPos: Lane, allyPositions: Map<number, AllyPosition>): number | null {
  const want = LANE_PARTNER[myPos];
  if (!want) return null;
  for (const [id, p] of allyPositions) if (p.pos === want) return id;
  return null;
}
