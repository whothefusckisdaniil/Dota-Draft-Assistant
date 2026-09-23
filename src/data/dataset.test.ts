import { describe, expect, it } from 'vitest';
import heroes from '../../public/data/heroes.json';
import matchupsRaw from '../../public/data/matchups.json';
import meta from '../../public/data/meta.json';
import type { Hero, MatchupRow } from '../types';

/** Dataset integrity gates (§38). These run in normal `npm test` — a broken or
 *  missing snapshot fails the suite, never reaches production silently. */
describe('generated dataset (public/data)', () => {
  it('meta points to a fresh, complete OpenDota snapshot', () => {
    expect(meta.source).toBe('OpenDota');
    expect(meta.heroCount).toBe(heroes.length);
    expect(meta.latestPatch).toMatch(/^\d+\.\d+/);
    const ageDays = (Date.now() - new Date(meta.generatedAt).getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThanOrEqual(0);
    expect(ageDays).toBeLessThan(30); // CI refreshes daily; stale = broken pipeline
  });

  it('every hero has a valid id, name and roles', () => {
    const ids = new Set<number>();
    for (const h of heroes as Hero[]) {
      expect(h.id, h.name).toBeGreaterThan(0);
      expect(h.name.length).toBeGreaterThan(0);
      expect(Array.isArray(h.roles)).toBe(true);
      expect(ids.has(h.id)).toBe(false);
      ids.add(h.id);
    }
    expect(heroes.length).toBeGreaterThanOrEqual(120);
  });

  it('every matchup table: known ids, games >= 0, 0 <= wins <= games', () => {
    const ids = new Set((heroes as Hero[]).map((h) => h.id));
    const tables = matchupsRaw as Record<string, MatchupRow[]>;
    expect(Object.keys(tables).length).toBeGreaterThanOrEqual(120);
    let rows = 0;
    for (const [enemyId, list] of Object.entries(tables)) {
      expect(ids.has(Number(enemyId)), enemyId).toBe(true);
      for (const r of list) {
        rows += 1;
        expect(ids.has(r.hero_id), `${enemyId}→${r.hero_id}`).toBe(true);
        expect(Number.isFinite(r.games_played)).toBe(true);
        expect(r.games_played).toBeGreaterThanOrEqual(0);
        expect(r.wins).toBeGreaterThanOrEqual(0);
        expect(r.wins).toBeLessThanOrEqual(r.games_played);
        expect(Number.isNaN(r.games_played)).toBe(false);
        expect(Number.isNaN(r.wins)).toBe(false);
      }
    }
    expect(rows).toBeGreaterThan(10000);
  });
});