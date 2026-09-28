import { describe, expect, it } from 'vitest';
import matchupsRaw from '../../public/data/matchups.json';
import heroesRaw from '../../public/data/heroes.json';
import type { Hero, MatchupRow } from '../types';
import { scoreCandidates } from './engine';
import type { Lane } from './positionsExtra';

const heroes = heroesRaw as unknown as Hero[];
const tables = matchupsRaw as unknown as Record<string, MatchupRow[]>;

describe('STRATZ production snapshot feeds the real scoring engine', () => {
  it('gives full matchup coverage (every hero has all 126 opponents)', () => {
    for (const h of heroes) {
      const rows = tables[String(h.id)];
      expect(rows, `table for ${h.id}`).toBeTruthy();
      expect(rows.length).toBe(heroes.length - 1);
    }
  });

  it('no longer hits the old thin-sample floor (min pair games >= 100)', () => {
    let min = Infinity;
    for (const rows of Object.values(tables)) {
      for (const r of rows) min = Math.min(min, r.games_played);
    }
    expect(min).toBeGreaterThanOrEqual(100);
  });

  it('scores every lane with full coverage and high confidence on a 5-hero draft', () => {
    const enemyIds = [13, 7, 74, 11, 42];
    const matchupByEnemy = new Map<number, MatchupRow[]>();
    for (const e of enemyIds) matchupByEnemy.set(e, tables[String(e)]);
    const input = {
      heroes,
      enemyIds,
      matchupByEnemy,
      heroById: new Map(heroes.map((h) => [h.id, h])),
    };
    for (const lane of ['1', '2', '3', '4', '5'] as Lane[]) {
      const ranked = scoreCandidates(input, lane);
      // Engine returns at most topN=15 per lane and hides candidates whose
      // role fit is below minPositionScore — STRATZ coverage is complete, so
      // the lane list is limited by role fit only, never by missing data.
      expect(ranked.length, lane).toBeGreaterThan(5);
      expect(ranked.length, lane).toBeLessThanOrEqual(15);
      for (const c of ranked) {
        expect(Number.isFinite(c.finalScore)).toBe(true);
        expect(c.usableEnemies).toBe(enemyIds.length);
        expect(c.lowData).toBe(false);
        // STRATZ samples are thousands of games per pair → confidence saturates.
        expect(c.confidence).toBe(1);
      }
      expect(ranked[0].finalScore).toBeGreaterThanOrEqual(ranked[ranked.length - 1].finalScore);
    }
  });
});
