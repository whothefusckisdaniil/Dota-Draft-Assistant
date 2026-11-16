import { describe, expect, it } from 'vitest';
import matchupsRaw from '../../public/data/matchups.json';
import heroesRaw from '../../public/data/heroes.json';
import positionsRaw from '../../public/data/positions.json';
import meta from '../../public/data/meta.json';
import bracketsRaw from '../../public/data/matchups-by-bracket.json';
import { computeBaseWinrates } from './baseline';
import { suggestBans } from './bans';
import synergyRaw from '../../public/data/synergy.json';
import synergyByBracketRaw from '../../public/data/synergy-by-bracket.json';
import type { Hero, MatchupRow, PositionDataset } from '../types';
import { scoreCandidates } from './engine';
import type { Lane } from './positionsExtra';

const heroes = heroesRaw as unknown as Hero[];
/** Right after a patch the window holds only a few days, so sample-size gates
 *  apply to a full window only (they must not block the daily refresh). */
const effectiveDays = (meta.matchupWindow as unknown as { effectiveDays?: number }).effectiveDays ?? 30;
const fullWindow = effectiveDays >= 21;
const tables = matchupsRaw as unknown as Record<string, MatchupRow[]>;
const tables_ = tables;
// The real production position layer, so this suite gates on real pick rates.
const positions = positionsRaw as unknown as Record<string, PositionDataset[number]>;
const positionById: PositionDataset = Object.fromEntries(
  Object.entries(positions).map(([id, v]) => [Number(id), v]),
);

describe('STRATZ production snapshot feeds the real scoring engine', () => {
  it('gives full matchup coverage (every hero has all 126 opponents)', () => {
    for (const h of heroes) {
      const rows = tables[String(h.id)];
      expect(rows, `table for ${h.id}`).toBeTruthy();
      expect(rows.length).toBe(heroes.length - 1);
    }
  });

  it('no longer hits the old thin-sample floor (min pair games >= 50)', () => {
    // ~126 on the first 30-day window; 50 leaves room for the daily-sliding data
    // (rare pairs are damped by shrinkage anyway).
    let min = Infinity;
    for (const rows of Object.values(tables)) {
      for (const r of rows) min = Math.min(min, r.games_played);
    }
    expect(min).toBeGreaterThanOrEqual(fullWindow ? 50 : 1);
  });

  it('scores every lane with full coverage and high confidence on a 5-hero draft', () => {
    const enemyIds = [13, 7, 74, 11, 42];
    const matchupByEnemy = new Map<number, MatchupRow[]>();
    for (const e of enemyIds) matchupByEnemy.set(e, tables[String(e)]);
    const input = {
      heroes,
      enemyIds,
      matchupByEnemy,
      positions: positionById,
      heroById: new Map(heroes.map((h) => [h.id, h])),
    };
    for (const lane of ['1', '2', '3', '4', '5'] as Lane[]) {
      const ranked = scoreCandidates(input, lane);
      // Engine returns at most topN=15 per lane, filtered by the empirical
      // position gate (STRATZ pick rates) — STRATZ matchup coverage is complete,
      // so the lane list is limited by where the hero is actually played, never
      // by missing matchup data.
      expect(ranked.length, lane).toBeGreaterThan(5);
      expect(ranked.length, lane).toBeLessThanOrEqual(15);
      for (const c of ranked) {
        expect(Number.isFinite(c.finalScore)).toBe(true);
        expect(c.usableEnemies).toBe(enemyIds.length);
        if (fullWindow) {
          expect(c.lowData).toBe(false);
          // STRATZ samples are thousands of games per pair → confidence saturates.
          expect(c.confidence).toBe(1);
        }
      }
      expect(ranked[0].finalScore).toBeGreaterThanOrEqual(ranked[ranked.length - 1].finalScore);
    }
  });
});

describe('per-rank tables (rank selector)', () => {
  const brackets = bracketsRaw as unknown as Record<string, Record<string, MatchupRow[]>>;
  const ids = (meta as unknown as { brackets: { ids: string[] } }).brackets.ids;

  it('meta lists the four STRATZ brackets and the file has exactly those', () => {
    expect(ids).toEqual(['HERALD_GUARDIAN', 'CRUSADER_ARCHON', 'LEGEND_ANCIENT', 'DIVINE_IMMORTAL']);
    expect(Object.keys(brackets)).toEqual(ids);
  });

  it('every rank covers every hero vs all 126 opponents, symmetric by construction', () => {
    for (const b of ids) {
      for (const h of heroes) {
        const rows = brackets[b][String(h.id)];
        expect(rows?.length, `${b} ${h.name}`).toBe(heroes.length - 1);
      }
      const [a, c] = [heroes[0].id, heroes[1].id];
      const ab = brackets[b][String(a)].find((r) => r.hero_id === c)!;
      const ba = brackets[b][String(c)].find((r) => r.hero_id === a)!;
      expect(ab.games_played).toBe(ba.games_played);
      expect(Math.abs(ab.wins + ba.wins - ab.games_played)).toBeLessThanOrEqual(1);
    }
  });

  it('each rank scores a draft with its own baselines', () => {
    const enemyIds = [13, 7, 74];
    for (const b of ids) {
      const matchupByEnemy = new Map(enemyIds.map((e) => [e, brackets[b][String(e)]]));
      const tables = new Map(Object.entries(brackets[b]).map(([k, v]) => [Number(k), v]));
      const ranked = scoreCandidates({
        heroes, enemyIds, matchupByEnemy, positions: positionById,
        heroById: new Map(heroes.map((h) => [h.id, h])), baseWinrates: computeBaseWinrates(tables),
      }, '2');
      expect(ranked.length, b).toBeGreaterThan(0);
      for (const c of ranked) expect(Number.isFinite(c.finalScore), b).toBe(true);
    }
  });
});

describe('synergy tables (allies, ban suggestions)', () => {
  const syn = synergyRaw as unknown as Record<string, MatchupRow[]>;
  const synByBracket = synergyByBracketRaw as unknown as Record<string, Record<string, MatchupRow[]>>;

  it('cover every hero with every teammate, symmetric, in all ranks and per rank', () => {
    for (const table of [syn, ...Object.values(synByBracket)]) {
      for (const h of heroes) expect(table[String(h.id)]?.length, h.name).toBe(heroes.length - 1);
      const [a, b] = [heroes[0].id, heroes[1].id];
      const ab = table[String(a)].find((r) => r.hero_id === b)!;
      const ba = table[String(b)].find((r) => r.hero_id === a)!;
      expect(ab).toMatchObject({ games_played: ba.games_played, wins: ba.wins });
    }
    expect(Object.keys(synByBracket)).toEqual(['HERALD_GUARDIAN', 'CRUSADER_ARCHON', 'LEGEND_ANCIENT', 'DIVINE_IMMORTAL']);
  });

  it('scores a draft with allies and suggests bans on the real snapshot', () => {
    const synergyByAlly = new Map(Object.entries(syn).map(([k, v]) => [Number(k), v]));
    const tables = new Map(Object.entries(tables_ as Record<string, MatchupRow[]>).map(([k, v]) => [Number(k), v]));
    const base = computeBaseWinrates(tables);
    const input = {
      heroes, enemyIds: [13, 7], matchupByEnemy: tables, positions: positionById,
      heroById: new Map(heroes.map((h) => [h.id, h])), baseWinrates: base,
      allyIds: [8, 26], synergyByAlly,
    };
    const ranked = scoreCandidates(input, '2');
    expect(ranked.length).toBeGreaterThan(0);
    for (const c of ranked) {
      expect(c.synergy.map((s) => s.allyId)).toEqual([8, 26]);
      expect(Number.isFinite(c.draftScore)).toBe(true);
      expect([8, 26, 13, 7]).not.toContain(c.hero.id);
    }
    const bans = suggestBans({ heroes, allyIds: [8, 26], enemyIds: [13, 7], excludeIds: [], matchupByHero: tables, synergyByHero: synergyByAlly, baseWinrates: base });
    expect(bans.length).toBe(8);
    for (const b of bans) expect([8, 26, 13, 7]).not.toContain(b.hero.id);
  });
});
