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
import { buildDataset, validateProductionContract } from './update-data-stratz.mjs';
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

/** Item catalogue fixture: 145 is purchasable so the statistics reference resolves. */
function itemsFixture() {
  return {
    145: { id: 145, name: 'Battle Fury', dname: 'item_bfury', shortName: '', cost: 3900, isPurchasable: true, isStackable: false, isSideShop: false, stockMax: 0, isSupportFullItem: false, image: '', components: [] },
  };
}

/** Item statistics fixture: one hero, one position, one item. */
function itemStatsFixture(ids: number[]) {
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    out[String(id)] = { 1: { 145: { purchases: 100, wins: 50, heroGames: 1000, byMinute: { 8: 100 }, instances: { 0: 100 } } } };
  }
  return out;
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
      fetchItems: async () => itemsFixture(),
      fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
      fetchItems: async () => itemsFixture(),
      fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
      fetchItems: async () => itemsFixture(),
      fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
      fetchItems: async () => itemsFixture(),
      fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
      fetchItems: async () => itemsFixture(),
      fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
      fetchItems: async () => itemsFixture(),
      fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
        fetchItems: async () => itemsFixture(),
        fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
        fetchItems: async () => itemsFixture(),
        fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
        fetchItems: async () => itemsFixture(),
        fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
        fetchItems: async () => itemsFixture(),
        fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
      fetchItems: async () => itemsFixture(),
      fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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

  it('uses four complete weeks and excludes the current partial one', async () => {
    const { meta } = await buildDataset({
      fetchMetadata: metaFor(),
      fetchMatchups: async (ids: number[]) => matchupFixture(ids),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      fetchItems: async () => itemsFixture(),
      fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
      now: NOW,
      log: silent,
    });
    expect(meta.matchupWindow.weeklyBuckets).toHaveLength(4);
    expect(meta.matchupWindow.completeWeeksOnly).toBe(true);
    expect(meta.matchupWindow.excludedBuckets.currentIncomplete).not.toBe(
      meta.matchupWindow.weeklyBuckets.at(-1),
    );
    expect(meta.matchupWindow.windowStartUtc < meta.matchupWindow.windowEndUtcExclusive).toBe(true);
  });
});


describe('buildDataset — no stale latestPatch (ТЗ §8C)', () => {
  it('writes the patch from the current OpenDota response', async () => {
    const { meta } = await buildDataset({
      fetchMetadata: metaFor('7.43'),
      fetchMatchups: async (ids: number[]) => matchupFixture(ids),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      fetchItems: async () => itemsFixture(),
      fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
        fetchItems: async () => itemsFixture(),
        fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
      fetchItems: async () => itemsFixture(),
      fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
      now: NOW,
      log: silent,
    });
    expect(meta.source).toBe('STRATZ');
    expect(meta.heroMetadataSource).toBe('OpenDota');
    expect(meta.heroCount).toBe(100);
    expect(meta.generatedAt).toBe(NOW.toISOString());
    // STRATZ fields from ТЗ №6 must survive.
    expect(meta.matchupWindow.completeWeeksOnly).toBe(true);
    expect(meta.matchupWindow.weeklyBuckets).toHaveLength(4);
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
        fetchItems: async () => itemsFixture(),
        fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
        fetchItems: async () => itemsFixture(),
        fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
        fetchItems: async () => itemsFixture(),
        fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
      const { heroes, matchups, positions, items, itemStats, meta } = await buildDataset({
        fetchMetadata: async () => ({ heroes: heroFixture(ids), latestPatch: '7.42', heroCount: 101 }),
        fetchMatchups: async (h: number[]) => matchupFixture(h),
        fetchPositions: async (h: number[]) => positionFixture(h),
        fetchItems: async () => itemsFixture(),
        fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
        now: NOW,
        log: silent,
      });
      await publishDatasetAtomically(dir, {
        'heroes.json': heroes,
        'matchups.json': matchups,
        'positions.json': positions,
        'items.json': items,
        'item-stats.json': itemStats,
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
      'items.json': itemsFixture(),
      'item-stats.json': itemStatsFixture(staleIds),
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
          fetchItems: async () => itemsFixture(),
          fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
      fetchItems: async () => itemsFixture(),
      fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
      fetchItems: async () => itemsFixture(),
      fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
      fetchItems: async () => itemsFixture(),
      fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
      now: NOW,
      log: silent,
    });
    expect(meta.source).toBe('STRATZ');
    expect(meta.heroMetadataSource).toBe('OpenDota');
    expect(meta.latestPatch).toBe('7.42');
    expect(meta.heroCount).toBe(101);
    expect(meta.schema.heroCount).toBe(101);
    expect(meta.generatedAt).toBe(NOW.toISOString());
    expect(meta.matchupWindow.weeklyBuckets).toHaveLength(4);
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
        fetchItems: async () => itemsFixture(),
        fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
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
      fetchItems: async () => itemsFixture(),
      fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
      now: NOW,
      log: silent,
    });
    expect(heroes).toHaveLength(Object.keys(matchups).length);
    expect(heroes).toHaveLength(meta.heroCount);
    for (const h of heroes) {
      expect(matchups[String(h.id)], `table for ${h.id}`).toHaveLength(heroes.length - 1);
    }
  });

  it('keeps the four buckets contiguous and excludes only the current partial one', async () => {
    const { meta } = await buildDataset({
      fetchMetadata: metaFor(),
      fetchMatchups: async (ids: number[]) => matchupFixture(ids),
      fetchPositions: async (ids: number[]) => positionFixture(ids),
      fetchItems: async () => itemsFixture(),
      fetchItemsStats: async (ids: number[]) => itemStatsFixture(ids),
      now: NOW,
      log: silent,
    });
    const w = meta.matchupWindow;
    expect(w.weeks).toBe(4);
    expect(w.weeklyBuckets).toHaveLength(4);
    for (let i = 1; i < w.weeklyBuckets.length; i += 1) {
      expect(w.weeklyBuckets[i]).toBe(w.weeklyBuckets[i - 1] + 1);
    }
    expect(w.completeWeeksOnly).toBe(true);
    expect(w.excludedBuckets.currentIncomplete).not.toBe(w.weeklyBuckets[0]);
    expect(Date.parse(w.windowEndUtcExclusive)).toBeGreaterThan(Date.parse(w.windowStartUtc));
  });
});

