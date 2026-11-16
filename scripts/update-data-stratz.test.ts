/**
 * Contract tests for the STRATZ generator's production validator.
 *
 * `validateProductionContract` is the only thing standing between a malformed or
 * truncated STRATZ response and the committed production dataset, so every gate is
 * exercised here against deliberately corrupted synthetic data. A gate that never
 * throws is worse than no gate at all.
 *
 * These tests must not touch the network: importing the generator is safe because
 * `main()` only runs on a direct `node scripts/update-data-stratz.mjs` invocation.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PUBLISHED_FILES,
  aggregateStratzMatchupChunks,
  buildChunkQuery,
  buildDataset,
  symmetrizeBracketTable,
  aggregateStratzSynergyChunks,
  symmetrizeSynergyTable,
  validateSynergyTable,
  buildPublishPayload,
  validateProductionContract,
} from './update-data-stratz.mjs';
import { DATASET_FILES, OPTIONAL_DATASET_FILES } from './dataset-publish.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { publishDatasetAtomically } from './dataset-publish.mjs';

type Row = { hero_id: number; games_played: number; wins: number };
type Dataset = Record<string, Row[]>;

const N = 100; // the validator rejects fewer than 100 heroes
const IDS = Array.from({ length: N }, (_, i) => i + 1);
const HEROES = IDS.map((id) => ({ id }));

/** Perfectly balanced dataset: every ordered pair 1000 games / 500 wins. */
function baseline(): Dataset {
  const ds: Dataset = {};
  for (const i of IDS) {
    ds[String(i)] = IDS.filter((j) => j !== i).map((j) => ({
      hero_id: j,
      games_played: 1000,
      wins: 500,
    }));
  }
  return ds;
}

/** Look up the (enemy -> opponent) row; throws if the fixture lost it. */
function row(ds: Dataset, enemy: number, opponent: number): Row {
  const r = ds[String(enemy)]?.find((x) => x.hero_id === opponent);
  if (!r) throw new Error(`fixture bug: no row ${enemy}->${opponent}`);
  return r;
}

describe('validateProductionContract — accepts a healthy dataset', () => {
  it('passes a perfectly balanced dataset and reports its shape', () => {
    const res = validateProductionContract(HEROES, baseline());
    expect(res.totalPairs).toBe(N * (N - 1));
    expect(res.reversePairAsymmetry.maxPct).toBe(0);
    expect(res.winsSumSkew.maxPct).toBe(0);
    expect(res.rowColSkew.maxPct).toBe(0);
    expect(res.heroAggWr).toHaveLength(N);
    expect(res.heroAggWr.every((h) => h.wr === 50)).toBe(true);
  });

  it('rejects a hero definition that is too small to be trustworthy', () => {
    expect(() => validateProductionContract([{ id: 1 }], { 1: [] })).toThrow(/Too few heroes/);
  });
});

describe('validateProductionContract — structural gates', () => {
  it('rejects a missing hero table', () => {
    const ds = baseline();
    delete ds['1'];
    expect(() => validateProductionContract(HEROES, ds)).toThrow(/Hero ID mismatch.*Missing: 1/);
  });

  it('rejects an unexpected hero table', () => {
    const ds = baseline();
    ds['9999'] = [{ hero_id: 1, games_played: 10, wins: 5 }];
    expect(() => validateProductionContract(HEROES, ds)).toThrow(/Hero ID mismatch.*Extra: 9999/);
  });

  it('rejects a table with the wrong number of opponents', () => {
    const ds = baseline();
    ds['1'].pop();
    expect(() => validateProductionContract(HEROES, ds)).toThrow();
  });

  it('rejects a self-matchup row', () => {
    const ds = baseline();
    row(ds, 1, 2).hero_id = 1; // opponent becomes the key hero itself
    expect(() => validateProductionContract(HEROES, ds)).toThrow(/self-matchup rows/);
  });

  it('rejects a duplicated opponent', () => {
    const ds = baseline();
    row(ds, 1, 3).hero_id = 2; // 1 now lists opponent 2 twice
    expect(() => validateProductionContract(HEROES, ds)).toThrow(/duplicate opponent/);
  });

  it('rejects games_played <= 0', () => {
    const ds = baseline();
    const r = row(ds, 1, 2);
    r.games_played = 0;
    r.wins = 0;
    expect(() => validateProductionContract(HEROES, ds)).toThrow(/games_played <= 0/);
  });

  it('rejects wins outside [0, games_played]', () => {
    const ds = baseline();
    row(ds, 1, 2).wins = 1001;
    expect(() => validateProductionContract(HEROES, ds)).toThrow(/wins out of/);
  });

  it('rejects an unknown opponent id', () => {
    const ds = baseline();
    row(ds, 1, 2).hero_id = 99999;
    expect(() => validateProductionContract(HEROES, ds)).toThrow(/unknown opponent IDs/);
  });

  it('rejects a dataset whose row total does not match n*(n-1)', () => {
    const ds = baseline();
    ds['1'].push({ hero_id: 1, games_played: 1000, wins: 500 });
    expect(() => validateProductionContract(HEROES, ds)).toThrow(
      /Total pair rows mismatch|self-matchup/,
    );
  });
});

describe('validateProductionContract — symmetry gates', () => {
  it('rejects a reverse pair that is asymmetric beyond tolerance', () => {
    const ds = baseline();
    row(ds, 2, 1).games_played = 1200; // 20% / 200 games vs the 1000 on the other face
    expect(() => validateProductionContract(HEROES, ds)).toThrow(/games asymmetry tolerance/);
  });

  it('accepts a small absolute difference on a large pair (documented escape hatch)', () => {
    const ds = baseline();
    row(ds, 2, 1).games_played = 1010; // 1% relative, 10 games absolute
    expect(() => validateProductionContract(HEROES, ds)).not.toThrow();
  });

  it('tolerates a few ~4% asymmetric pairs (known STRATZ behaviour) and reports them', () => {
    const ds = baseline();
    row(ds, 1, 2).games_played = 1040; // like Broodmother / Shadow Demon: 1182 vs 1137
    row(ds, 3, 4).games_played = 1035;
    const result = validateProductionContract(HEROES, ds);
    expect(result.asymmetricFaces).toHaveLength(4); // each pair is seen from both sides
    expect(result.asymmetricFaces).toContainEqual({ enemyId: 1, heroId: 2, games: 1040, reverseGames: 1000 });
  });

  it('rejects soft asymmetry once it spreads over more pairs than the budget', () => {
    const ds = baseline();
    for (const [a, b] of [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]]) row(ds, a, b).games_played = 1040;
    expect(() => validateProductionContract(HEROES, ds)).toThrow(/games asymmetry tolerance/);
  });

  it('rejects a single pair above the 10% hard limit', () => {
    const ds = baseline();
    row(ds, 1, 2).games_played = 1110;
    row(ds, 1, 2).wins = 555;
    expect(() => validateProductionContract(HEROES, ds)).toThrow(/1 above 10%|2 above 10%/);
  });

  it('accepts a large relative difference on a tiny pair (the rounding-noise case)', () => {
    const ds = baseline();
    const a = row(ds, 1, 2);
    a.games_played = 100;
    a.wins = 50;
    const b = row(ds, 2, 1);
    b.games_played = 110; // 10% relative — but only 10 games absolute
    b.wins = 50;
    expect(() => validateProductionContract(HEROES, ds)).not.toThrow();
  });

  it('rejects a wins-sum skew beyond tolerance', () => {
    const ds = baseline();
    row(ds, 1, 2).wins = 600; // 600 + 500 != 1000
    expect(() => validateProductionContract(HEROES, ds)).toThrow(/wins sum skew/);
  });

  it('rejects a hero whose aggregate winrate leaves the 40-60% band', () => {
    const ds = baseline();
    for (const j of IDS.filter((j) => j !== 1)) {
      row(ds, 1, j).wins = 900; // hero 1 wins ~91% of everything...
      row(ds, j, 1).wins = 100; // ...and every reverse face balances the sum
    }
    expect(() => validateProductionContract(HEROES, ds)).toThrow(/aggregate WR outside 40-60%/);
  });

  it('rejects row/column total skew beyond 1.5%', () => {
    const ds = baseline();
    // +2.5% on every outgoing face of hero 1: under the 3% per-pair asymmetry
    // threshold, but it accumulates to 2.4% between the row and column totals.
    for (const j of IDS.filter((j) => j !== 1)) row(ds, 1, j).games_played = 1025;
    expect(() => validateProductionContract(HEROES, ds)).toThrow(/row\/column total skew/);
  });
});

describe('validateProductionContract — the committed production snapshot', () => {
  it('is accepted by its own validator', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const root = fileURLToPath(new URL('..', import.meta.url));
    const matchups = JSON.parse(await readFile(`${root}public/data/matchups.json`, 'utf8'));
    const heroes = JSON.parse(await readFile(`${root}public/data/heroes.json`, 'utf8'));
    const res = validateProductionContract(heroes, matchups);
    // The shipped snapshot must satisfy the very contract the generator enforces,
    // otherwise a passing generator run still leaves untrustworthy data committed.
    expect(res.totalPairs).toBe(heroes.length * (heroes.length - 1));
    expect(res.heroAggWr.every((h) => h.wr >= 40 && h.wr <= 60)).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// Pipeline ordering (ТЗ №7 §8B–E)
//
// The regression being locked down: the generator used to READ the committed
// heroes.json and query STRATZ with those ids, so a new hero, a retired hero, a
// roles change, a new portrait, a pub/pro stat change or a patch bump could
// never reach production. `buildDataset` takes both network steps as injected
// dependencies, which is what makes the ordering assertions below possible.
// ---------------------------------------------------------------------------

type Hero = { id: number; name: string; roles: string[]; img: string; pubPick: number };

const IDS_100 = Array.from({ length: 100 }, (_, i) => i + 1);

function heroFixture(ids: number[], over: Partial<Hero> = {}): Hero[] {
  return ids.map((id) => ({
    id, name: `Hero ${id}`, key: `npc_dota_hero_hero_${id}`, roles: ['Carry'],
    img: `https://cdn/x${id}.png`, pubPick: 1, ...over,
  }));
}

/** Perfectly balanced matchup tables for exactly `ids` (validator-legal). */
function matchupFixture(ids: number[]): Record<string, { hero_id: number; games_played: number; wins: number }[]> {
  const ds: Record<string, { hero_id: number; games_played: number; wins: number }[]> = {};
  for (const i of ids) {
    ds[String(i)] = ids.filter((j) => j !== i).map((j) => ({ hero_id: j, games_played: 1000, wins: 500 }));
  }
  return ds;
}

const NOW = new Date('2026-09-28T12:00:00Z');
const silent = () => {};
const metaFor = (patch = '7.42', n = 100) => async () => ({ heroes: heroFixture(IDS_100), latestPatch: patch, heroCount: n });

/** Position layer matching `matchupFixture`: 20% on every lane for every hero. */
function positionFixture(ids: number[]) {
  const out: Record<string, unknown> = {};
  for (const i of ids) {
    out[String(i)] = {
      totalGames: 5000,
      positions: Object.fromEntries(['1', '2', '3', '4', '5'].map((p) => [p, { games: 1000, share: 0.2 }])),
    };
  }
  return out;
}

describe('buildDataset — the STRATZ query is driven by FRESH metadata (ТЗ §8B)', () => {
  it('asks STRATZ for exactly the ids OpenDota returned this run', async () => {
    let queried: number[] = [];
    await buildDataset({
      fetchMetadata: metaFor(),
      fetchMatchups: async (heroIds: number[]) => {
        queried = heroIds;
        return matchupFixture(heroIds);
      },
      fetchPositions: async (heroIds: number[]) => positionFixture(heroIds),
      now: NOW,
      log: silent,
    });
    expect(queried).toEqual([...IDS_100].sort((a, b) => a - b));
  });

  it('propagates a newly added hero all the way into the published tables', async () => {
    // 100 -> 101: the case that used to be impossible, because the roster came
    // from the committed file rather than from OpenDota.
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    const { heroes, matchups, meta } = await buildDataset({
      fetchMetadata: async () => ({ heroes: heroFixture(ids), latestPatch: '7.42', heroCount: 101 }),
      fetchMatchups: async (heroIds: number[]) => matchupFixture(heroIds),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      now: NOW,
      log: silent,
    });
    expect(heroes).toHaveLength(101);
    expect(Object.keys(matchups)).toHaveLength(101);
    expect(matchups['101']).toHaveLength(100);
    expect(meta.heroCount).toBe(101);
    expect(meta.schema.totalRows).toBe(101 * 100);
  });

  it('drops a retired hero from every file of the snapshot', async () => {
    // 127 -> 126. The validator floors the roster at 100 heroes, so a small
    // roster is treated as a truncated response; the fixture is sized like the
    // real game so the drop is unambiguous.
    const all = Array.from({ length: 127 }, (_, i) => i + 1);
    const ids = all.filter((i) => i !== 55);
    const { heroes, matchups, meta } = await buildDataset({
      fetchMetadata: async () => ({ heroes: heroFixture(ids), latestPatch: '7.42', heroCount: 126 }),
      fetchMatchups: async (heroIds: number[]) => matchupFixture(heroIds),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      now: NOW,
      log: silent,
    });
    expect(heroes.map((h) => h.id)).not.toContain(55);
    expect(Object.keys(matchups)).not.toContain('55');
    expect(matchups['56'].map((r) => r.hero_id)).not.toContain(55);
    expect(meta.heroCount).toBe(126);
  });

  it('carries updated roles, portraits and pub/pro stats into heroes.json', async () => {
    const { heroes } = await buildDataset({
      fetchMetadata: async () => ({
        heroes: heroFixture(IDS_100, { roles: ['Support', 'Disabler'], img: 'https://cdn/NEW.png', pubPick: 4242 }),
        latestPatch: '7.42',
        heroCount: 100,
      }),
      fetchMatchups: async (heroIds: number[]) => matchupFixture(heroIds),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      now: NOW,
      log: silent,
    });
    expect(heroes[0].roles).toEqual(['Support', 'Disabler']);
    expect(heroes[0].img).toBe('https://cdn/NEW.png');
    expect(heroes[0].pubPick).toBe(4242);
  });
});

describe('buildDataset — latestPatch is never inherited from the old meta.json (ТЗ §8C)', () => {
  it('takes the patch from this run\'s OpenDota response', async () => {
    const { meta } = await buildDataset({
      fetchMetadata: metaFor('9.99', 100),
      fetchMatchups: async (ids: number[]) => matchupFixture(ids),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      now: NOW,
      log: silent,
    });
    expect(meta.latestPatch).toBe('9.99');
  });

  it('records the metadata source alongside the matchup source', async () => {
    const { meta } = await buildDataset({
      fetchMetadata: metaFor('7.42'),
      fetchMatchups: async (ids: number[]) => matchupFixture(ids),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      now: NOW,
      log: silent,
    });
    expect(meta.source).toBe('STRATZ');
    expect(meta.heroMetadataSource).toBe('OpenDota');
    expect(meta.heroCount).toBe(100);
  });
});

describe('buildDataset — failure policy (ТЗ §3, §8D)', () => {
  it('never reaches STRATZ when OpenDota metadata fails', async () => {
    const stratz = vi.fn(async () => {
      throw new Error('STRATZ must not be called');
    });
    await expect(
      buildDataset({
        fetchMetadata: async () => { throw new Error('OpenDota 500'); },
        fetchMatchups: stratz as never,
        fetchPositions: async (ids: number[]) => positionFixture(ids),
        now: NOW,
        log: silent,
      }),
    ).rejects.toThrow(/OpenDota 500/);
    expect(stratz).not.toHaveBeenCalled();
  });

  it('fails without a patch rather than reusing the committed one', async () => {
    await expect(
      buildDataset({
        fetchMetadata: metaFor('', 100),
        fetchMatchups: async (ids: number[]) => matchupFixture(ids),
        fetchPositions: async (ids: number[]) => positionFixture(ids),
        now: NOW,
        log: silent,
      }),
    ).rejects.toThrow();
  });

  it('propagates a STRATZ failure after metadata succeeded', async () => {
    await expect(
      buildDataset({
        fetchMetadata: metaFor(),
        fetchMatchups: async () => { throw new Error('Cloudflare challenge'); },
        now: NOW,
        log: silent,
      }),
    ).rejects.toThrow(/Cloudflare challenge/);
  });

  it('propagates a validation failure instead of publishing a partial dataset', async () => {
    await expect(
      buildDataset({
        fetchMetadata: metaFor(),
        fetchMatchups: async (ids: number[]) => {
          const t = matchupFixture(ids);
          delete t['7']; // a hole in the tables — exactly what gate #1 exists to catch
          return t;
        },
        fetchPositions: async (ids: number[]) => positionFixture(ids),
        now: NOW,
        log: silent,
      }),
    ).rejects.toThrow(/Hero ID mismatch|Missing: 7/);
  });

  it('rejects STRATZ tables that reference a hero OpenDota no longer lists', async () => {
    const ids = IDS_100.filter((i) => i !== 55);
    await expect(
      buildDataset({
        fetchMetadata: async () => ({ heroes: heroFixture(ids), latestPatch: '7.42', heroCount: 99 }),
        // STRATZ still knows hero 55: a stale response must not sneak it back in.
        fetchMatchups: async () => matchupFixture(IDS_100),
        fetchPositions: async (ids: number[]) => positionFixture(ids),
        now: NOW,
        log: silent,
      }),
    ).rejects.toThrow();
  });
});

describe('buildDataset — the published triple describes one snapshot (ТЗ §8E)', () => {
  it('keeps heroes, matchups and meta mutually consistent', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    const { heroes, matchups, meta, validationResult } = await buildDataset({
      fetchMetadata: async () => ({ heroes: heroFixture(ids), latestPatch: '7.43', heroCount: 101 }),
      fetchMatchups: async (heroIds: number[]) => matchupFixture(heroIds),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      now: NOW,
      log: silent,
    });
    // heroes.length === matchup table count
    expect(Object.keys(matchups)).toHaveLength(heroes.length);
    // every hero has exactly heroCount - 1 opponents
    for (const h of heroes) {
      expect(matchups[String(h.id)]).toHaveLength(heroes.length - 1);
    }
    // meta agrees with both, and totalPairGames is the real sum of the file
    expect(meta.heroCount).toBe(heroes.length);
    expect(meta.latestPatch).toBe('7.43');
    expect(meta.generatedAt).toBe(NOW.toISOString());
    expect(meta.schema.totalRows).toBe(validationResult.totalPairs);
    const actualGames = Object.values(matchups).reduce(
      (s, rows) => s + rows.reduce((x, r) => x + r.games_played, 0),
      0,
    );
    expect(meta.schema.totalPairGames).toBe(actualGames);
  });

  it('cuts the window at the current patch release date from OpenDota', async () => {
    const { meta } = await buildDataset({
      fetchMetadata: async () => ({ ...(await metaFor()()), latestPatchDate: '2026-09-16T00:00:00.000Z' }),
      fetchMatchups: async (ids: number[]) => matchupFixture(ids),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      now: NOW,
      log: silent,
    });
    // patch 12 days before NOW → previous patch cut off; bucket 2958 (Sep 10–17) keeps 1 of 7 days
    expect(meta.matchupWindow.windowStartUtc).toBe('2026-09-16T00:00:00.000Z');
    expect(meta.matchupWindow.weeklyBuckets).toEqual([2958, 2959, 2960]);
    expect(meta.matchupWindow.patch).toMatchObject({ name: '7.42', mode: 'CUT_AT_PATCH', releasedUtc: '2026-09-16T00:00:00.000Z' });
    expect(meta.positionData.bucketWeights).toEqual(meta.matchupWindow.bucketWeights);
  });

  it('uses the rolling last-30-days window, including the live current week', async () => {
    const { meta } = await buildDataset({
      fetchMetadata: metaFor(),
      fetchMatchups: async (ids: number[]) => matchupFixture(ids),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      now: NOW,
      log: silent,
    });
    // NOW = 2026-09-28T12:00Z → window 2026-08-29 .. now; bucket 2956 (Aug 27–Sep 3) is 5/7 inside.
    expect(meta.matchupWindow).toMatchObject({
      kind: 'rolling-days',
      days: 30,
      windowStartUtc: '2026-08-29T00:00:00.000Z',
      windowEndUtc: NOW.toISOString(),
      weeklyBuckets: [2956, 2957, 2958, 2959, 2960],
      currentBucket: 2960,
    });
    expect(meta.matchupWindow.bucketWeights[2956]).toBeCloseTo(5 / 7, 6);
    expect(meta.matchupWindow.bucketWeights[2960]).toBe(1);
    expect(meta.positionData.weeklyBuckets).toEqual(meta.matchupWindow.weeklyBuckets);
    expect(meta.positionData.bucketWeights).toEqual(meta.matchupWindow.bucketWeights);
  });
});


describe('buildDataset — no stale latestPatch (ТЗ §8C)', () => {
  it('writes the patch from the current OpenDota response', async () => {
    const { meta } = await buildDataset({
      fetchMetadata: metaFor('7.43'),
      fetchMatchups: async (ids: number[]) => matchupFixture(ids),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      now: NOW,
      log: silent,
    });
    expect(meta.latestPatch).toBe('7.43');
  });

  it('never reuses a previously committed patch', async () => {
    // The old code read `prevMeta.latestPatch` from public/data/meta.json and
    // defaulted to a hardcoded '7.41'. Assert the value is always the fetched
    // one, whichever way the two differ.
    for (const fresh of ['7.42', '7.39', '7.50']) {
      const { meta } = await buildDataset({
        fetchMetadata: metaFor(fresh),
        fetchMatchups: async (ids: number[]) => matchupFixture(ids),
        fetchPositions: async (ids: number[]) => positionFixture(ids),
        now: NOW,
        log: silent,
      });
      expect(meta.latestPatch).toBe(fresh);
    }
  });

  it('sets source/heroMetadataSource/heroCount per the meta contract', async () => {
    const { meta } = await buildDataset({
      fetchMetadata: metaFor('7.42', 100),
      fetchMatchups: async (ids: number[]) => matchupFixture(ids),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      now: NOW,
      log: silent,
    });
    expect(meta.source).toBe('STRATZ');
    expect(meta.heroMetadataSource).toBe('OpenDota');
    expect(meta.heroCount).toBe(100);
    expect(meta.generatedAt).toBe(NOW.toISOString());
    // STRATZ fields from ТЗ №6 must survive.
    expect(meta.matchupWindow.kind).toBe('rolling-days');
    expect(meta.matchupWindow.days).toBe(30);
    expect(meta.population.brackets).toHaveLength(4);
  });
});

describe('buildDataset — failure policy (ТЗ §8D, §3)', () => {
  const deps = () => {
    const calls: string[] = [];
    return {
      calls,
      fetchMetadata: async () => {
        calls.push('opendota');
        throw new Error('OpenDota 503');
      },
      fetchMatchups: async () => {
        calls.push('stratz');
        throw new Error('STRATZ unreachable');
      },
      fetchPositions: async (ids: number[]) => {
        calls.push('positions');
        throw new Error('STRATZ unreachable');
      },
    };
  };

  it('does not query STRATZ when the OpenDota fetch fails', async () => {
    const d = deps();
    await expect(buildDataset({ ...d, now: NOW, log: silent })).rejects.toThrow(/OpenDota 503/);
    expect(d.calls).toEqual(['opendota']);
  });

  it('propagates a STRATZ failure after a successful metadata fetch', async () => {
    const d = deps();
    d.fetchMetadata = async () => {
      d.calls.push('opendota');
      return { heroes: heroFixture(IDS_100), latestPatch: '7.42', heroCount: 100 };
    };
    await expect(buildDataset({ ...d, now: NOW, log: silent })).rejects.toThrow(/STRATZ unreachable/);
    expect(d.calls).toEqual(['opendota', 'stratz']);
  });

  it('propagates a validation failure and returns nothing publishable', async () => {
    // STRATZ answered, but with a truncated table -> the contract must reject it.
    const truncated = matchupFixture(IDS_100);
    delete truncated['77'];
    await expect(
      buildDataset({
        fetchMetadata: metaFor(),
        fetchMatchups: async () => truncated,
        fetchPositions: async (ids: number[]) => positionFixture(ids),
        now: NOW,
        log: silent,
      }),
    ).rejects.toThrow();
  });
});

describe('dataset snapshot coherence (ТЗ §8E)', () => {
  it('every hero has exactly heroCount-1 opponents in the same snapshot', async () => {
    for (const n of [100, 101, 127]) {
      const ids = Array.from({ length: n }, (_, i) => i + 1);
      const { heroes, matchups, meta } = await buildDataset({
        fetchMetadata: async () => ({ heroes: heroFixture(ids), latestPatch: '7.42', heroCount: n }),
        fetchMatchups: async (heroIds: number[]) => matchupFixture(heroIds),
        fetchPositions: async (ids: number[]) => positionFixture(ids),
        now: NOW,
        log: silent,
      });
      expect(heroes).toHaveLength(n);
      expect(Object.keys(matchups)).toHaveLength(n);
      for (const h of heroes) expect(matchups[String(h.id)], `hero ${h.id}`).toHaveLength(n - 1);
      expect(meta.heroCount).toBe(n);
    }
  });

  it('rejects a STRATZ table keyed by a hero OpenDota no longer lists', async () => {
    // STRATZ still answers for a hero the roster dropped: publishing this would
    // resurrect a retired hero in `matchups.json` only.
    const all = Array.from({ length: 127 }, (_, i) => i + 1);
    const ids = all.filter((i) => i !== 55);
    const ds = matchupFixture(ids);
    ds['55'] = ids.filter((j) => j !== 55).map((j) => ({ hero_id: j, games_played: 1000, wins: 500 }));
    await expect(
      buildDataset({
        fetchMetadata: async () => ({ heroes: heroFixture(ids), latestPatch: '7.42', heroCount: 126 }),
        fetchMatchups: async () => ds,
        fetchPositions: async (ids: number[]) => positionFixture(ids),
        now: NOW,
        log: silent,
      }),
    ).rejects.toThrow(/55/);
  });
});



describe('end-to-end: build -> publish -> serve (ТЗ §7/§8E)', () => {
  it('leaves a directory that a reader can consume as one coherent snapshot', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'e2e-'));
    const dir = path.join(root, 'data');
    try {
      const ids = Array.from({ length: 101 }, (_, i) => i + 1);
      const { heroes, matchups, positions, meta } = await buildDataset({
        fetchMetadata: async () => ({ heroes: heroFixture(ids), latestPatch: '7.42', heroCount: 101 }),
        fetchMatchups: async (h: number[]) => matchupFixture(h),
        fetchPositions: async (h: number[]) => positionFixture(h),
        now: NOW,
        log: silent,
      });
      await publishDatasetAtomically(dir, {
        'heroes.json': heroes,
        'matchups.json': matchups,
        'positions.json': positions,
        'meta.json': meta,
      });

      // Read it back the way the app does.
      const [h, m, metaRaw] = await Promise.all([
        readFile(path.join(dir, 'heroes.json'), 'utf8').then(JSON.parse),
        readFile(path.join(dir, 'matchups.json'), 'utf8').then(JSON.parse),
        readFile(path.join(dir, 'meta.json'), 'utf8').then(JSON.parse),
      ]);
      expect(h).toHaveLength(101);
      expect(Object.keys(m)).toHaveLength(101);
      expect(metaRaw.heroCount).toBe(101);
      expect(metaRaw.latestPatch).toBe('7.42');
      for (const hero of h) {
        expect(m[String(hero.id)], `table for ${hero.id}`).toHaveLength(100);
      }
      // No staging or backup leftovers.
      const entries = await readdir(root);
      expect(entries.filter((e) => e !== 'data')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a failed build never touches an existing dataset on disk', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'e2e-'));
    const dir = path.join(root, 'data');
    // An old, but internally consistent, dataset sitting on disk.
    const staleIds = [1, 2, 3];
    const stale = {
      'heroes.json': heroFixture(staleIds, { pubPick: 1 }),
      'matchups.json': matchupFixture(staleIds),
      'positions.json': positionFixture(staleIds),
      'meta.json': { source: 'STRATZ', heroMetadataSource: 'OpenDota', latestPatch: '7.40', heroCount: 3 },
    };
    try {
      await publishDatasetAtomically(dir, stale);
      const before = await readFile(path.join(dir, 'meta.json'), 'utf8');

      await expect(
        buildDataset({
          fetchMetadata: async () => {
            throw new Error('OpenDota timeout');
          },
          fetchMatchups: async (h: number[]) => matchupFixture(h),
          fetchPositions: async (ids: number[]) => positionFixture(ids),
          now: NOW,
          log: silent,
        }),
      ).rejects.toThrow(/OpenDota timeout/);

      expect(await readFile(path.join(dir, 'meta.json'), 'utf8')).toBe(before);
      expect(await readdir(root)).toEqual(['data']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('buildDataset — latestPatch is always fresh (ТЗ §8C)', () => {
  it('takes the patch from this run\'s OpenDota response', async () => {
    const { meta } = await buildDataset({
      fetchMetadata: metaFor('7.44'),
      fetchMatchups: async (ids: number[]) => matchupFixture(ids),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      now: NOW,
      log: silent,
    });
    expect(meta.latestPatch).toBe('7.44');
  });

  it('never reuses a previously committed patch, even when OpenDota regresses', async () => {
    // The old code seeded `latestPatch` from the previous meta.json (and hardcoded
    // '7.41' as a last resort), so a patch bump — or a rollback — could not be seen.
    const { meta } = await buildDataset({
      fetchMetadata: metaFor('7.38'),
      fetchMatchups: async (ids: number[]) => matchupFixture(ids),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      now: NOW,
      log: silent,
    });
    expect(meta.latestPatch).toBe('7.38');
    expect(meta.latestPatch).not.toBe('7.41');
  });

  it('records both sources and the fresh hero count in meta', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    const { meta } = await buildDataset({
      fetchMetadata: async () => ({ heroes: heroFixture(ids), latestPatch: '7.42', heroCount: 101 }),
      fetchMatchups: async (h: number[]) => matchupFixture(h),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      now: NOW,
      log: silent,
    });
    expect(meta.source).toBe('STRATZ');
    expect(meta.heroMetadataSource).toBe('OpenDota');
    expect(meta.latestPatch).toBe('7.42');
    expect(meta.heroCount).toBe(101);
    expect(meta.schema.heroCount).toBe(101);
    expect(meta.generatedAt).toBe(NOW.toISOString());
    expect(meta.matchupWindow.days).toBe(30);
  });
});

describe('buildDataset — failure policy (ТЗ §8D)', () => {
  it('never queries STRATZ when OpenDota metadata fails', async () => {
    let stratzCalled = false;
    await expect(
      buildDataset({
        fetchMetadata: async () => {
          throw new Error('OpenDota /heroes 503');
        },
        fetchMatchups: async (ids: number[]) => {
          stratzCalled = true;
          return matchupFixture(ids);
        },
        now: NOW,
        log: silent,
      }),
    ).rejects.toThrow(/OpenDota \/heroes 503/);
    // The ordering guarantee: no token is spent, no partial data is built.
    expect(stratzCalled).toBe(false);
  });

  it('rejects a roster that fails its own metadata gate before touching STRATZ', async () => {
    let stratzCalled = false;
    await expect(
      buildDataset({
        fetchMetadata: async () => ({ heroes: heroFixture([1, 2, 3]), latestPatch: '7.42', heroCount: 3 }),
        fetchMatchups: async (ids: number[]) => {
          stratzCalled = true;
          return matchupFixture(ids);
        },
        now: NOW,
        log: silent,
      }),
    ).rejects.toThrow(/hero metadata incomplete/);
    expect(stratzCalled).toBe(false);
  });

  it('propagates a STRATZ failure instead of publishing OpenDota-only data', async () => {
    await expect(
      buildDataset({
        fetchMetadata: metaFor(),
        fetchMatchups: async () => {
          throw new Error('STRATZ HTTP 429');
        },
        now: NOW,
        log: silent,
      }),
    ).rejects.toThrow(/STRATZ HTTP 429/);
  });

  it('rejects when STRATZ data does not cover the fresh roster', async () => {
    // Hero 101 was added upstream; STRATZ has no data for it. Publishing anyway
    // would ship a heroes.json the app cannot rank against.
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    await expect(
      buildDataset({
        fetchMetadata: async () => ({ heroes: heroFixture(ids), latestPatch: '7.42', heroCount: 101 }),
        fetchMatchups: async () => matchupFixture(IDS_100), // stale 100-hero answer
        fetchPositions: async (h: number[]) => positionFixture(h),
        now: NOW,
        log: silent,
      }),
    ).rejects.toThrow(/101/);
  });
});

describe('buildDataset — one consistent snapshot (ТЗ §8E)', () => {
  it('heroes, matchups and meta all describe the same hero set', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    const { heroes, matchups, meta } = await buildDataset({
      fetchMetadata: async () => ({ heroes: heroFixture(ids), latestPatch: '7.42', heroCount: 101 }),
      fetchMatchups: async (h: number[]) => matchupFixture(h),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      now: NOW,
      log: silent,
    });
    expect(heroes).toHaveLength(Object.keys(matchups).length);
    expect(heroes).toHaveLength(meta.heroCount);
    for (const h of heroes) {
      expect(matchups[String(h.id)], `table for ${h.id}`).toHaveLength(heroes.length - 1);
    }
  });

  it('keeps the window buckets contiguous and ending at the current week', async () => {
    const { meta } = await buildDataset({
      fetchMetadata: metaFor(),
      fetchMatchups: async (ids: number[]) => matchupFixture(ids),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      now: NOW,
      log: silent,
    });
    const w = meta.matchupWindow;
    for (let i = 1; i < w.weeklyBuckets.length; i += 1) {
      expect(w.weeklyBuckets[i]).toBe(w.weeklyBuckets[i - 1] + 1);
    }
    expect(w.weeklyBuckets.at(-1)).toBe(w.currentBucket);
    expect(Date.parse(w.windowEndUtc) - Date.parse(w.windowStartUtc)).toBeGreaterThanOrEqual(30 * 86_400_000);
    expect(Date.parse(w.windowEndUtc) - Date.parse(w.windowStartUtc)).toBeLessThan(31 * 86_400_000);
  });
});


// ---------------------------------------------------------------------------
// ТЗ №77 — the refresh serves Counterpick only: no item endpoints, no item
// layers, exactly four published files.
// ---------------------------------------------------------------------------

describe('validateProductionContract — zero-game rows', () => {
  it('rejects them by default but accepts them for per-rank tables', () => {
    const ds = baseline();
    row(ds, 1, 2).games_played = 0; row(ds, 1, 2).wins = 0;
    row(ds, 2, 1).games_played = 0; row(ds, 2, 1).wins = 0;
    expect(() => validateProductionContract(HEROES, ds)).toThrow(/games_played <= 0/);
    expect(() => validateProductionContract(HEROES, ds, { allowZeroGames: true })).not.toThrow();
  });
});

describe('synergy (same-team "with" rows)', () => {
  const resp = (bucket: number, dryads: unknown[]) => ({ data: { heroStats: { [`w${bucket}`]: dryads } } });

  it('aggregates with-rows per teammate, weighted by bucket, wins = team wins', () => {
    const chunks = [{ chunkIndex: 0, chunkHeroIds: [1, 2], response: {
      data: { heroStats: {
        w2957: [{ heroId: 1, vs: [], with: [{ heroId1: 1, heroId2: 2, matchCount: 700, winCount: 400 }] }],
        w2958: [{ heroId: 1, vs: [], with: [{ heroId1: 1, heroId2: 2, matchCount: 100, winCount: 60 }] }],
      } },
    } }];
    const t = aggregateStratzSynergyChunks(chunks, { buckets: [2957, 2958], weights: { 2957: 3 / 7, 2958: 1 } }, new Set([1, 2]));
    expect(t).toEqual({ '1': [{ hero_id: 2, games_played: 400, wins: 231 }] }); // 300+100, round(171.43+60)
  });

  it('rejects a row that does not involve the dryad hero', () => {
    const chunks = [{ chunkIndex: 0, chunkHeroIds: [1], response: resp(2957, [{ heroId: 1, with: [{ heroId1: 2, heroId2: 3, matchCount: 1, winCount: 1 }] }]) }];
    expect(() => aggregateStratzSynergyChunks(chunks, { buckets: [2957] }, new Set([1, 2, 3]))).toThrow(/orientation/);
  });

  it('symmetrizes both directions', () => {
    const t = symmetrizeSynergyTable({
      1: [{ hero_id: 2, games_played: 100, wins: 50 }],
      2: [{ hero_id: 1, games_played: 120, wins: 64 }],
    });
    expect(t['1']).toEqual([{ hero_id: 2, games_played: 110, wins: 57 }]);
    expect(t['2']).toEqual(t['1'].map((r) => ({ ...r, hero_id: 1 })));
  });

  it('validates roster, counts and team win rates', () => {
    const ok: Record<string, { hero_id: number; games_played: number; wins: number }[]> = {};
    for (const i of IDS) ok[String(i)] = IDS.filter((j) => j !== i).map((j) => ({ hero_id: j, games_played: 100, wins: 50 }));
    expect(() => validateSynergyTable(HEROES, ok)).not.toThrow();
    const bad = structuredClone(ok);
    bad['1'][0].wins = 101;
    expect(() => validateSynergyTable(HEROES, bad)).toThrow(/wins 101/);
    const zero = structuredClone(ok);
    zero['1'][0].games_played = 0; zero['1'][0].wins = 0;
    expect(() => validateSynergyTable(HEROES, zero)).toThrow(/games 0/);
    expect(() => validateSynergyTable(HEROES, zero, { allowZeroGames: true })).not.toThrow();
    const missing = structuredClone(ok);
    delete missing['5'];
    expect(() => validateSynergyTable(HEROES, missing)).toThrow(/no table for hero 5/);
  });

  it('buildDataset publishes synergy when the fetcher returns { vs, with }', async () => {
    const result = await buildDataset({
      fetchMetadata: metaFor(),
      fetchMatchups: async (ids: number[]) => ({ vs: matchupFixture(ids), with: matchupFixture(ids) }),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      now: NOW,
      log: silent,
    } as never);
    expect(result.synergy['1'][0]).toMatchObject({ games_played: 4000, wins: 2000 }); // 4 brackets summed
    expect(Object.keys(result.synergyByBracket)).toEqual(['HERALD_GUARDIAN', 'CRUSADER_ARCHON', 'LEGEND_ANCIENT', 'DIVINE_IMMORTAL']);
    expect(result.meta.synergy.files).toEqual(['synergy.json', 'synergy-by-bracket.json']);
    expect(Object.keys(buildPublishPayload(result))).toEqual([...PUBLISHED_FILES]);
  });

  it('the query asks for with-rows only when synergy is requested', () => {
    expect(buildChunkQuery([1], [2960], ['LEGEND_ANCIENT'], { withSynergy: true })).toContain('with { heroId1 heroId2 matchCount winCount }');
    expect(buildChunkQuery([1], [2960])).not.toContain('with {');
  });
});

describe('symmetrizeBracketTable', () => {
  it('averages both directions and keeps the enemy-perspective wins convention', () => {
    // 1→2: 100 games, hero 1 wins 40; 2→1: 140 games, hero 2 wins 84 (hero 1 wins 56)
    const t = symmetrizeBracketTable({
      1: [{ hero_id: 2, games_played: 100, wins: 40 }],
      2: [{ hero_id: 1, games_played: 140, wins: 84 }],
    });
    expect(t['1']).toEqual([{ hero_id: 2, games_played: 120, wins: 48 }]); // (40 + 56) / 2
    expect(t['2']).toEqual([{ hero_id: 1, games_played: 120, wins: 72 }]); // (84 + 60) / 2
    expect(t['1'][0].wins + t['2'][0].wins).toBe(120);
  });

  it('fails on a missing reverse row', () => {
    expect(() => symmetrizeBracketTable({ 1: [{ hero_id: 2, games_played: 10, wins: 5 }] })).toThrow(/missing reverse row/);
  });
});

describe('buildDataset — rank brackets', () => {
  it('fetches one table per bracket and publishes "All ranks" as their sum', async () => {
    const asked: string[][] = [];
    const share: Record<string, number> = { HERALD_GUARDIAN: 100, CRUSADER_ARCHON: 400, LEGEND_ANCIENT: 300, DIVINE_IMMORTAL: 200 };
    const result = await buildDataset({
      fetchMetadata: metaFor(),
      fetchMatchups: async (ids: number[], _w: unknown, opts: { brackets: string[] }) => {
        asked.push(opts.brackets);
        const g = share[opts.brackets[0]];
        const ds: Record<string, { hero_id: number; games_played: number; wins: number }[]> = {};
        for (const i of ids) ds[String(i)] = ids.filter((j) => j !== i).map((j) => ({ hero_id: j, games_played: g, wins: g / 2 }));
        return ds;
      },
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      now: NOW,
      log: silent,
    } as never);
    expect(asked).toEqual([['HERALD_GUARDIAN'], ['CRUSADER_ARCHON'], ['LEGEND_ANCIENT'], ['DIVINE_IMMORTAL']]);
    expect(Object.keys(result.matchupsByBracket)).toEqual(['HERALD_GUARDIAN', 'CRUSADER_ARCHON', 'LEGEND_ANCIENT', 'DIVINE_IMMORTAL']);
    expect(result.matchupsByBracket.DIVINE_IMMORTAL['1'][0].games_played).toBe(200);
    expect(result.matchupsByBracket.HERALD_GUARDIAN['1'][0]).toMatchObject({ games_played: 100, wins: 50 });
    expect(result.matchups['1'][0]).toMatchObject({ games_played: 1000, wins: 500 });
    expect(result.meta.brackets.ids).toEqual(['HERALD_GUARDIAN', 'CRUSADER_ARCHON', 'LEGEND_ANCIENT', 'DIVINE_IMMORTAL']);
    expect(result.meta.brackets.labels.DIVINE_IMMORTAL).toBe('Divine–Immortal');
  });

  it('a broken bracket table blocks the whole refresh and names the bracket', async () => {
    await expect(buildDataset({
      fetchMetadata: metaFor(),
      fetchMatchups: async (ids: number[], _w: unknown, opts: { brackets: string[] }) => {
        const ds = matchupFixture(ids);
        if (opts.brackets[0] === 'LEGEND_ANCIENT') {
          // hero 1 wins 80% of everything in this bracket only: the all-ranks sum
          // stays inside the 40–60% band (57.5%), the bracket table does not
          for (const row of ds['1']) row.wins = 800;
          for (const j of ids.filter((x) => x !== 1)) ds[String(j)].find((r) => r.hero_id === 1)!.wins = 200;
        }
        return ds;
      },
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      now: NOW,
      log: silent,
    } as never)).rejects.toThrow(/Bracket LEGEND_ANCIENT/);
  });

  it('builds the per-bracket GraphQL query for exactly the requested bracket', () => {
    const q = buildChunkQuery([1, 2], [2960], ['DIVINE_IMMORTAL']);
    expect(q).toContain('bracketBasicIds: [DIVINE_IMMORTAL]');
    expect(buildChunkQuery([1, 2], [2960])).toContain('bracketBasicIds: [HERALD_GUARDIAN, CRUSADER_ARCHON, LEGEND_ANCIENT, DIVINE_IMMORTAL]');
  });
});

describe('buildDataset — no item data (ТЗ №77)', () => {
  const run = async (extra: Record<string, unknown> = {}) => {
    const calls: string[] = [];
    const logs: string[] = [];
    const result = await buildDataset({
      fetchMetadata: async () => { calls.push('metadata'); return metaFor()(); },
      fetchMatchups: async (ids: number[]) => { calls.push('matchups'); return matchupFixture(ids); },
      fetchPositions: async (ids: number[]) => { calls.push('positions'); return positionFixture(ids); },
      now: NOW,
      log: (line: string) => logs.push(line),
      ...extra,
    } as never);
    return { result, calls, logs };
  };

  it('never calls item endpoints, even when item fetchers are passed in', async () => {
    const fetchItems = vi.fn(async () => ({}));
    const fetchItemsStats = vi.fn(async () => ({}));
    const { calls } = await run({ fetchItems, fetchItemsStats });
    expect(fetchItems).not.toHaveBeenCalled();
    expect(fetchItemsStats).not.toHaveBeenCalled();
    // one matchup request set per rank bracket, then positions
    expect(calls).toEqual(['metadata', 'matchups', 'matchups', 'matchups', 'matchups', 'positions']);
  });

  it('returns no item layers and no meta.itemData', async () => {
    const { result } = await run();
    expect(Object.keys(result).sort()).toEqual(['heroes', 'matchups', 'matchupsByBracket', 'meta', 'positionInfo', 'positions', 'synergy', 'synergyByBracket', 'validationResult']);
    expect(result.meta).not.toHaveProperty('itemData');
    expect(JSON.stringify(result.meta)).not.toMatch(/item/i);
  });

  it('keeps the matchup contract and the position checks', async () => {
    const { result, logs } = await run();
    expect(result.meta.dataQuality.checksPassed).toBe(13);
    expect(result.positionInfo.heroCount).toBe(100);
    expect(logs.join('\n')).not.toMatch(/item/i);
    await expect(buildDataset({
      fetchMetadata: metaFor(),
      fetchMatchups: async (ids: number[]) => matchupFixture(ids),
      fetchPositions: async (ids: number[]) => positionFixture(ids.slice(1)),
      now: NOW,
      log: silent,
    })).rejects.toThrow();
  });

  it('publishes exactly heroes, matchups, positions, meta and the per-rank tables', async () => {
    const { result } = await run();
    expect([...PUBLISHED_FILES]).toEqual(['heroes.json', 'matchups.json', 'positions.json', 'meta.json', 'matchups-by-bracket.json', 'synergy.json', 'synergy-by-bracket.json']);
    // a fetcher without same-team data publishes without the optional synergy layer
    expect(Object.keys(buildPublishPayload(result))).toEqual(PUBLISHED_FILES.slice(0, 5));
    expect([...DATASET_FILES, ...OPTIONAL_DATASET_FILES].sort()).toEqual([...PUBLISHED_FILES].sort());
    expect(() => buildPublishPayload({ ...result, positions: undefined } as never)).toThrow(/positions\.json/);
  });

  it('has no item pipeline left in the generator source', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const source = readFileSync(`${root}scripts/update-data-stratz.mjs`, 'utf8');
    expect(source).not.toMatch(/itemFullPurchase|stratz\/items\.mjs|fetchItems|item-stats\.json|'items\.json'|pruneItemCatalogue|validateItemData|heroGamesByPosition/);
    expect(existsSync(`${root}scripts/stratz/items.mjs`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// aggregateStratzMatchupChunks — production GraphQL contract
// ---------------------------------------------------------------------------

const vsRow = (heroId1: number, heroId2: number, matchCount = 100, winCount = 50) => ({
  heroId1,
  heroId2,
  matchCount,
  winCount,
});
const dryad = (heroId: number, vs: ReturnType<typeof vsRow>[] = []) => ({ heroId, vs });
const response = (buckets: Record<string, ReturnType<typeof dryad>[]>) => ({
  data: { heroStats: Object.fromEntries(
    Object.entries(buckets).map(([bucket, heroes]) => [`w${bucket}`, heroes]),
  ) },
});
const chunk = (chunkIndex: number, chunkHeroIds: number[], result: ReturnType<typeof response>) => ({
  chunkIndex,
  chunkHeroIds,
  response: result,
});
const aggregate = (
  chunks: ReturnType<typeof chunk>[],
  buckets = [2957],
  validHeroIds = [1, 2, 3, 4],
) => aggregateStratzMatchupChunks(chunks, { buckets }, new Set(validHeroIds));
const one = (heroId: number, vs: ReturnType<typeof vsRow>[], bucket = 2957) =>
  chunk(0, [heroId], response({ [bucket]: [dryad(heroId, vs)] }));

describe('aggregateStratzMatchupChunks — production GraphQL contract', () => {
  it('uses winCount when enemyId === heroId1', () => {
    expect(aggregate([one(1, [vsRow(1, 2, 100, 40)])])).toEqual({
      '1': [{ hero_id: 2, games_played: 100, wins: 40 }],
    });
  });

  it('complements winCount when enemyId === heroId2', () => {
    expect(aggregate([one(2, [vsRow(1, 2, 100, 40)])])).toEqual({
      '2': [{ hero_id: 1, games_played: 100, wins: 60 }],
    });
  });

  it('aggregates multiple matchup rows for one hero', () => {
    expect(aggregate([one(1, [vsRow(1, 2, 100, 40), vsRow(1, 3, 80, 20)])])).toEqual({
      '1': [
        { hero_id: 2, games_played: 100, wins: 40 },
        { hero_id: 3, games_played: 80, wins: 20 },
      ],
    });
  });

  it('aggregates several dryads in a response', () => {
    expect(aggregate([chunk(0, [1, 2], response({
      2957: [dryad(1, [vsRow(1, 3)]), dryad(2, [vsRow(2, 3, 70, 25)])],
    }))])).toEqual({
      '1': [{ hero_id: 3, games_played: 100, wins: 50 }],
      '2': [{ hero_id: 3, games_played: 70, wins: 25 }],
    });
  });

  it('sums observations from multiple buckets', () => {
    expect(aggregate([chunk(0, [1], response({
      2957: [dryad(1, [vsRow(1, 2, 100, 40)])],
      2958: [dryad(1, [vsRow(1, 2, 50, 20)])],
    }))], [2957, 2958])).toEqual({
      '1': [{ hero_id: 2, games_played: 150, wins: 60 }],
    });
  });

  it('scales a partly-included oldest week by its weight (rolling window)', () => {
    const chunks = [chunk(0, [1], response({
      2957: [dryad(1, [vsRow(1, 2, 700, 350)])], // weight 3/7 → 300 games, 150 wins
      2958: [dryad(1, [vsRow(1, 2, 100, 40)])],
    }))];
    const rows = aggregateStratzMatchupChunks(chunks, { buckets: [2957, 2958], weights: { 2957: 3 / 7, 2958: 1 } }, new Set([1, 2]));
    expect(rows).toEqual({ '1': [{ hero_id: 2, games_played: 400, wins: 190 }] });
  });

  it('rejects an out-of-range bucket weight', () => {
    const chunks = [one(1, [vsRow(1, 2)])];
    expect(() => aggregateStratzMatchupChunks(chunks, { buckets: [2957], weights: { 2957: 1.5 } }, new Set([1, 2])))
      .toThrow(/Invalid weight/);
  });

  it('aggregates disjoint chunks', () => {
    expect(aggregate([
      one(1, [vsRow(1, 2, 100, 40)]),
      chunk(1, [2], response({ 2957: [dryad(2, [vsRow(1, 2, 80, 30)])] })),
    ])).toEqual({
      '1': [{ hero_id: 2, games_played: 100, wins: 40 }],
      '2': [{ hero_id: 1, games_played: 80, wins: 50 }],
    });
  });

  it('returns an empty dataset for an empty dryad list', () => {
    expect(aggregate([chunk(0, [1], response({ 2957: [] }))])).toEqual({});
  });

  it('returns an empty dataset for a dryad with no vs rows', () => {
    expect(aggregate([one(1, [])])).toEqual({});
  });

  it('retains a zero-game matchup', () => {
    expect(aggregate([one(1, [vsRow(1, 2, 0, 0)])])).toEqual({
      '1': [{ hero_id: 2, games_played: 0, wins: 0 }],
    });
  });

  it('rejects duplicate hero IDs inside a requested chunk', () => {
    expect(() => aggregate([chunk(0, [1, 1], response({ 2957: [] }))])).toThrow(/duplicate Hero IDs/);
  });

  it('rejects duplicate dryad hero IDs in one bucket', () => {
    expect(() => aggregate([
      chunk(0, [1], response({ 2957: [dryad(1)] })),
      chunk(1, [1], response({ 2957: [dryad(1)] })),
    ])).toThrow(/Duplicate heroId/);
  });

  it('rejects a dryad outside its requested chunk', () => {
    expect(() => aggregate([chunk(0, [1], response({ 2957: [dryad(2)] }))])).toThrow(/not in current requested/);
  });

  it('rejects an invalid dryad heroId', () => {
    expect(() => aggregate([chunk(0, [1], response({ 2957: [dryad(0)] }))])).toThrow(/Invalid heroId/);
  });

  it('rejects an invalid heroId1', () => {
    expect(() => aggregate([one(1, [vsRow(0, 2)])])).toThrow(/Invalid heroId1/);
  });

  it('rejects an invalid heroId2', () => {
    expect(() => aggregate([one(1, [vsRow(1, 0)])])).toThrow(/Invalid heroId2/);
  });

  it('rejects a self-matchup', () => {
    expect(() => aggregate([one(1, [vsRow(1, 1)])])).toThrow(/Self-matchup/);
  });

  it('rejects a matchup with the wrong orientation', () => {
    expect(() => aggregate([one(1, [vsRow(2, 3)])])).toThrow(/Orientation error/);
  });

  it('rejects an opponent outside the global valid hero set', () => {
    expect(() => aggregate([one(1, [vsRow(1, 99)])])).toThrow(/global valid hero ID set/);
  });

  it('rejects a non-integer matchCount', () => {
    expect(() => aggregate([one(1, [vsRow(1, 2, 2.5, 1)])])).toThrow(/Invalid matchCount/);
  });

  it('rejects a non-integer winCount', () => {
    expect(() => aggregate([one(1, [vsRow(1, 2, 10, 1.5)])])).toThrow(/Invalid winCount/);
  });

  it('rejects negative game counts', () => {
    expect(() => aggregate([one(1, [vsRow(1, 2, -1, 0)])])).toThrow(/Invalid matchCount/);
  });

  it('rejects winCount greater than matchCount', () => {
    expect(() => aggregate([one(1, [vsRow(1, 2, 10, 11)])])).toThrow(/Invalid winCount/);
  });

  it('rejects duplicate directed matchups in one bucket', () => {
    expect(() => aggregate([one(1, [vsRow(1, 2), vsRow(1, 2, 90, 40)])])).toThrow(/Duplicate matchup row/);
  });

  it('rejects overlapping chunks that return the same hero', () => {
    expect(() => aggregate([
      chunk(0, [1], response({ 2957: [dryad(1)] })),
      chunk(1, [1], response({ 2957: [dryad(1)] })),
    ])).toThrow(/Duplicate heroId/);
  });

  it('does not fabricate observations for a missing bucket', () => {
    expect(aggregate([
      chunk(0, [1], response({ 2957: [dryad(1, [vsRow(1, 2)])] })),
    ], [2957, 2958])).toEqual({
      '1': [{ hero_id: 2, games_played: 100, wins: 50 }],
    });
  });

  it('preserves both row orientations and sums games and wins correctly', () => {
    expect(aggregate([
      one(1, [vsRow(1, 2, 100, 40)]),
      chunk(1, [2], response({ 2957: [dryad(2, [vsRow(1, 2, 100, 40)])] })),
    ])).toEqual({
      '1': [{ hero_id: 2, games_played: 100, wins: 40 }],
      '2': [{ hero_id: 1, games_played: 100, wins: 60 }],
    });
  });
});
