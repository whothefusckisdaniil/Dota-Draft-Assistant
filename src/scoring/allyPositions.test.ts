import { describe, expect, it } from 'vitest';
import type { PositionDataset } from '../types';
import { assignAllyPositions, lanePartner } from './allyPositions';
import { laneDetail } from './engine';

const shares = (s: number[]) => ({ totalGames: 1000, positions: Object.fromEntries(s.map((x, i) => [String(i + 1), { games: x * 1000, share: x }])) });
const POS = {
  27: shares([0, 0.02, 0.03, 0.3, 0.65]), // Shadow Shaman
  85: shares([0, 0.02, 0.2, 0.5, 0.28]), // Undying
  1: shares([0.95, 0.03, 0.02, 0, 0]), // Anti-Mage
} as unknown as PositionDataset;

describe('ally positions and lane partner', () => {
  it('guesses positions greedily, never your own role', () => {
    const m = assignAllyPositions([85, 27], POS, {}, '3');
    expect(m.get(27)).toEqual({ pos: '5', auto: true });
    expect(m.get(85)).toEqual({ pos: '4', auto: true });
    expect(lanePartner('3', m)).toBe(85);
    expect(lanePartner('1', m)).toBe(27);
    expect(lanePartner('2', m)).toBeNull();
  });

  it('keeps positions you set', () => {
    const m = assignAllyPositions([85, 27], POS, { 85: '5' }, '3');
    expect(m.get(85)).toEqual({ pos: '5', auto: false });
    expect(m.get(27)?.pos).toBe('4');
  });

  it('scores the lane against what both heroes usually get', () => {
    // Undying pos 4 wins 66% of its lanes; Bristleback pos 3 usually 41.5%
    const lane = { allyId: 85, partners: { 99: [5047, 1859, 1223] as [number, number, number] }, allyAvg: 0.661, candidateAvg: () => 0.415 };
    const d = laneDetail(99, lane)!;
    expect(d.share).toBeCloseTo(60.3, 1);
    expect(d.expected).toBeCloseTo(57.6, 1);
    expect(d.delta).toBeGreaterThan(2.5);
    expect(laneDetail(5, lane)).toBeNull();
  });
});
