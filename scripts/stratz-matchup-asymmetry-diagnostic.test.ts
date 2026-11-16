import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runCheck,
  runFetch,
  runReport,
  runRepeatability,
} from './stratz-matchup-asymmetry-diagnostic.mjs';
import { CHUNK_SIZE, WEEKS_COUNT } from './update-data-stratz.mjs';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'stratz-diagnostic-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const heroes = Array.from({ length: 100 }, (_, index) => ({
  id: index + 1,
  name: `hero_${index + 1}`,
  key: `npc_dota_hero_test_${index + 1}`,
  roles: ['Carry'],
  img: `https://example.test/${index + 1}.png`,
}));
const metadata = { heroes, latestPatch: '7.41' };
const bucketList = [2957, 2958, 2959, 2960];
const inputPath = () => path.join(tempDir, 'stratz-diagnostic-input.json');

function fixtureResponse(ids: number[], buckets: number[], options: { missingBucket?: number; wrongHero?: boolean } = {}) {
  const heroStats: Record<string, { heroId: number; vs: unknown[] }[]> = {};
  for (const bucket of buckets) {
    if (bucket === options.missingBucket) continue;
    heroStats[`w${bucket}`] = ids.map((heroId, index) => ({
      heroId: options.wrongHero && index === 0 ? 999 : heroId,
      vs: [],
    }));
  }
  return { data: { heroStats } };
}

function pairResponse(
  ids: number[],
  buckets: number[],
  options: {
    abCounts?: Record<number, [number, number]>;
    bcCounts?: Record<number, [number, number]>;
    missingDirection?: string;
  } = {},
) {
  const result = fixtureResponse(ids, buckets) as {
    data: { heroStats: Record<string, { heroId: number; vs: unknown[] }[]> };
  };
  for (const bucket of buckets) {
    for (const dryad of result.data.heroStats[`w${bucket}`]) {
      if (dryad.heroId === 58 && options.missingDirection !== '58:61') {
        const [games] = options.abCounts?.[bucket] ?? [100, 100];
        dryad.vs.push({ heroId1: 58, heroId2: 61, matchCount: games, winCount: 40 });
      } else if (dryad.heroId === 61) {
        if (options.missingDirection !== '61:58') {
          const [, games] = options.abCounts?.[bucket] ?? [100, 100];
          dryad.vs.push({ heroId1: 61, heroId2: 58, matchCount: games, winCount: 40 });
        }
        if (options.missingDirection !== '61:79') {
          const [games] = options.bcCounts?.[bucket] ?? [90, 90];
          dryad.vs.push({ heroId1: 61, heroId2: 79, matchCount: games, winCount: 45 });
        }
      } else if (dryad.heroId === 79 && options.missingDirection !== '79:61') {
        const [, games] = options.bcCounts?.[bucket] ?? [90, 90];
        dryad.vs.push({ heroId1: 79, heroId2: 61, matchCount: games, winCount: 45 });
      }
    }
  }
  return result;
}

function reportPaths() {
  return {
    inputPath: inputPath(),
    reportPath: path.join(tempDir, 'report.json'),
    metaPath: path.join(tempDir, 'meta.json'),
    heroesPath: path.join(tempDir, 'heroes.json'),
    repeatabilityEvidencePath: path.join(tempDir, 'not-present-repeatability.json'),
  };
}

function writeReportFixtures() {
  const paths = reportPaths();
  writeFileSync(paths.metaPath, JSON.stringify({ matchupWindow: { weeklyBuckets: bucketList } }));
  writeFileSync(paths.heroesPath, JSON.stringify(heroes.map((hero) => ({
    id: hero.id,
    name: hero.id === 58 ? 'Enchantress'
      : hero.id === 61 ? 'Broodmother'
        : hero.id === 79 ? 'Shadow Demon' : hero.name,
  }))));
  return paths;
}

function repeatResponse(
  ids: number[],
  buckets: number[],
  options: { pass?: number; changed?: 'matchCount' | 'winCount'; missingBucket?: number; reverseOrder?: boolean } = {},
) {
  const result = fixtureResponse(ids, buckets) as {
    data: { heroStats: Record<string, { heroId: number; vs: unknown[] }[]> };
  };
  for (const bucket of buckets) {
    if (bucket === options.missingBucket) {
      delete result.data.heroStats[`w${bucket}`];
      continue;
    }
    const dryads = result.data.heroStats[`w${bucket}`];
    for (const dryad of dryads) {
      if (dryad.heroId === 1) {
        dryad.vs.push({
          heroId1: 1,
          heroId2: 2,
          matchCount: 100 + (options.pass === 2 && options.changed === 'matchCount' ? 1 : 0),
          winCount: 45 + (options.pass === 2 && options.changed === 'winCount' ? 1 : 0),
        });
        dryad.vs.push({
          heroId1: 1,
          heroId2: 3,
          matchCount: 70 + (options.pass === 2 && options.changed === 'matchCount' ? 1 : 0),
          winCount: 35 + (options.pass === 2 && options.changed === 'winCount' ? 1 : 0),
        });
      } else if (dryad.heroId === 2) {
        dryad.vs.push({
          heroId1: 2,
          heroId2: 1,
          matchCount: 80 + (options.pass === 2 && options.changed === 'matchCount' ? 1 : 0),
          winCount: 40 + (options.pass === 2 && options.changed === 'winCount' ? 1 : 0),
        });
      } else if (dryad.heroId === 3) {
        dryad.vs.push({
          heroId1: 3,
          heroId2: 1,
          matchCount: 70 + (options.pass === 2 && options.changed === 'matchCount' ? 1 : 0),
          winCount: 30 + (options.pass === 2 && options.changed === 'winCount' ? 1 : 0),
        });
      }
    }
    if (options.reverseOrder) {
      dryads.reverse();
      for (const dryad of dryads) dryad.vs.reverse();
    }
  }
  return result;
}

function repeatabilityHarness(options: {
  initErrorPass?: number;
  queryErrorPass?: number;
  response?: (pass: number, ids: number[], buckets: number[]) => unknown;
} = {}) {
  let transportCount = 0;
  let clockTick = 0;
  const calls = { transports: 0, closed: 0, queries: [] as { pass: number; ids: number[]; buckets: number[] }[] };
  class MockTransport {
    readonly pass: number;
    constructor(readonly token: string) {
      this.pass = ++transportCount;
      calls.transports += 1;
    }
    async init() {
      if (options.initErrorPass === this.pass) throw new Error(`init failure ${this.pass}`);
    }
    async query(query: string) {
      const { ids, buckets } = JSON.parse(query) as { ids: number[]; buckets: number[] };
      calls.queries.push({ pass: this.pass, ids, buckets });
      if (options.queryErrorPass === this.pass) throw new Error(`query failure ${this.pass}`);
      return options.response?.(this.pass, ids, buckets) ?? repeatResponse(ids, buckets, { pass: this.pass });
    }
    async close() {
      calls.closed += 1;
    }
  }
  const queryBuilder = vi.fn((ids: number[], buckets: number[]) => JSON.stringify({ ids, buckets }));
  const paths = reportPaths();
  writeFileSync(paths.inputPath, JSON.stringify(notCollectedInput()));
  return {
    calls,
    queryBuilder,
    deps: {
      loadToken: () => 'repeatability-test-token',
      StratzTransport: MockTransport,
      buildChunkQuery: queryBuilder,
      inputPath: paths.inputPath,
      evidencePath: path.join(tempDir, 'repeatability.json'),
      repeatabilityRunId: 'repeatability-test-run',
      now: () => new Date(Date.UTC(2026, 10, 12, 0, 0, clockTick++)),
    },
  };
}

async function collectPairFixture(options: Parameters<typeof pairResponse>[2] = {}) {
  const h = harness({
    response: (ids, buckets) => pairResponse(ids, buckets, options),
  });
  await runFetch({ window: `${bucketList[0]}...${bucketList.at(-1)}` }, h.deps);
  return h;
}

function harness(options: {
  metadata?: typeof metadata;
  token?: string;
  initError?: Error;
  batchError?: Error;
  singleError?: Error;
  response?: (ids: number[], buckets: number[], index: number) => unknown;
  closeError?: Error;
} = {}) {
  const requestedQueries: { ids: number[]; buckets: number[] }[] = [];
  const calls = { init: 0, close: 0 };
  class MockTransport {
    constructor(readonly token: string) {}
    async init() {
      calls.init += 1;
      if (options.initError) throw options.initError;
    }
    async query(query: string) {
      const { ids, buckets } = JSON.parse(query) as { ids: number[]; buckets: number[] };
      requestedQueries.push({ ids, buckets });
      const isSingle = ids.length === 1;
      if (isSingle && options.singleError) throw options.singleError;
      if (!isSingle && options.batchError) throw options.batchError;
      return options.response?.(ids, buckets, requestedQueries.length)
        ?? fixtureResponse(ids, buckets);
    }
    async close() {
      calls.close += 1;
      if (options.closeError) throw options.closeError;
    }
  }
  const queryBuilder = vi.fn((ids: number[], buckets: number[]) => JSON.stringify({ ids, buckets }));
  return {
    requestedQueries,
    calls,
    queryBuilder,
    deps: {
      loadToken: () => options.token ?? 'test-token-never-persist',
      fetchOpenDotaMetadata: async () => options.metadata ?? metadata,
      StratzTransport: MockTransport,
      buildChunkQuery: queryBuilder,
      inputPath: inputPath(),
      now: new Date('2026-11-12T00:00:00.000Z'),
      diagnosticRunId: 'test-run',
      log: { info: vi.fn() },
    },
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      canonicalize((value as Record<string, unknown>)[key]),
    ]));
  }
  return value;
}

function normalizedResponseHash(response: unknown) {
  const normalized = canonicalize(response) as {
    data?: { heroStats?: Record<string, { heroId: number; vs?: { heroId1: number; heroId2: number; matchCount: number; winCount: number }[] }[]> };
  };
  for (const [bucket, dryads] of Object.entries(normalized.data?.heroStats ?? {})) {
    if (!/^w\d+$/.test(bucket)) continue;
    dryads.sort((a, b) => a.heroId - b.heroId);
    for (const dryad of dryads) {
      dryad.vs?.sort((a, b) =>
        a.heroId1 - b.heroId1 || a.heroId2 - b.heroId2
        || a.matchCount - b.matchCount || a.winCount - b.winCount);
    }
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function notCollectedInput() {
  const input = {
    schemaVersion: 2,
    diagnosticRunId: 'offline-run',
    dataStatus: 'NOT_COLLECTED',
    datasetSource: 'STRATZ',
    retrievedAt: '2026-11-12T00:00:00.000Z',
    attemptedWindow: {
      buckets: bucketList,
      windowStartUtc: '2026-09-03T00:00:00.000Z',
      windowEndUtcExclusive: '2026-10-01T00:00:00.000Z',
    },
    heroMetadata: { source: 'OpenDota', latestPatch: '', heroCount: 0, heroIds: [] },
    queryConfiguration: {
      chunkSize: CHUNK_SIZE,
      weeksCount: WEEKS_COUNT,
      brackets: ['HERALD_GUARDIAN', 'CRUSADER_ARCHON', 'LEGEND_ANCIENT', 'DIVINE_IMMORTAL'],
    },
    batchResults: {
      chunks: [],
      requestedHeroIds: [],
      observedHeroIdsByBucket: {},
      missingHeroIdsByBucket: {},
    },
    singleHeroResults: [],
    queryHashes: [],
    dataProvenance: { transport: 'production-StratzTransport', tokenPersisted: false },
    inputSha256: '',
  };
  const { inputSha256: _ignored, ...withoutHash } = input;
  input.inputSha256 = createHash('sha256')
    .update(JSON.stringify(canonicalize(withoutHash)))
    .digest('hex');
  return input;
}

describe('runFetch integration', () => {
  it('fetches all batch chunks and verifies at least one hero separately', async () => {
    const h = harness();
    const result = await runFetch({}, h.deps);
    expect(h.calls).toEqual({ init: 1, close: 1 });
    expect(h.requestedQueries).toHaveLength(Math.ceil(heroes.length / CHUNK_SIZE) + 1);
    expect(result.batchResults.chunks).toHaveLength(Math.ceil(heroes.length / CHUNK_SIZE));
    expect(result.singleHeroResults[0].status).toBe('VERIFIED');
    const firstBucket = result.attemptedWindow.buckets[0];
    expect(result.batchResults.chunks[0].response.data.heroStats[`w${firstBucket}`]).toHaveLength(CHUNK_SIZE);
  });

  it('uses the injected production query builder for batch and single-hero requests', async () => {
    const h = harness();
    await runFetch({}, h.deps);
    expect(h.queryBuilder).toHaveBeenCalledTimes(h.requestedQueries.length);
    expect(h.queryBuilder.mock.calls.some(([ids, buckets]) =>
      ids.length === 1 && ids[0] === 1
      && JSON.stringify(buckets) === JSON.stringify(h.requestedQueries[0].buckets),
    )).toBe(true);
  });

  it('splits hero IDs into bounded chunks', async () => {
    const h = harness();
    await runFetch({}, h.deps);
    const batch = h.requestedQueries.slice(0, -1);
    expect(batch.map((query) => query.ids.length)).toEqual([32, 32, 32, 4]);
    expect(batch.every((query) => query.ids.length <= CHUNK_SIZE)).toBe(true);
  });

  it('validates OpenDota metadata before initializing the transport', async () => {
    const h = harness({ metadata: { heroes: [], latestPatch: '' } as typeof metadata });
    await expect(runFetch({}, h.deps)).rejects.toThrow(/hero metadata/);
    expect(h.calls.init).toBe(0);
    expect(existsSync(inputPath())).toBe(false);
  });

  it('fails when the STRATZ token is unavailable', async () => {
    const h = harness();
    h.deps.loadToken = () => { throw new Error('STRATZ_API_TOKEN is not set'); };
    await expect(runFetch({}, h.deps)).rejects.toThrow(/STRATZ_API_TOKEN/);
    expect(h.calls.init).toBe(0);
  });

  it('closes the transport when initialization fails', async () => {
    const h = harness({ initError: new Error('init failed') });
    await expect(runFetch({}, h.deps)).rejects.toThrow('init failed');
    expect(h.calls.close).toBe(1);
    expect(existsSync(inputPath())).toBe(false);
  });

  it('does not save partial input after a batch query error', async () => {
    const h = harness({ batchError: new Error('query failed') });
    await expect(runFetch({}, h.deps)).rejects.toThrow('query failed');
    expect(h.calls.close).toBe(1);
    expect(existsSync(inputPath())).toBe(false);
  });

  it('rejects GraphQL errors and does not replace a prior input', async () => {
    writeFileSync(inputPath(), 'prior-valid-input');
    const h = harness({
      response: () => ({ data: { heroStats: {} }, errors: [{ message: 'bad query' }] }),
    });
    await expect(runFetch({}, h.deps)).rejects.toThrow(/GraphQL errors/);
    expect(readFileSync(inputPath(), 'utf8')).toBe('prior-valid-input');
  });

  it('rejects a response with a missing bucket', async () => {
    const h = harness({
      response: (ids, buckets) => fixtureResponse(ids, buckets, { missingBucket: buckets[1] }),
    });
    await expect(runFetch({}, h.deps)).rejects.toThrow(/missing or invalid bucket/);
  });

  it('rejects response hero IDs that were not requested', async () => {
    const h = harness({
      response: (ids, buckets) => fixtureResponse(ids, buckets, { wrongHero: true }),
    });
    await expect(runFetch({}, h.deps)).rejects.toThrow(/unexpected or invalid heroId/);
  });

  it('records single-hero query errors without converting them into observations', async () => {
    const h = harness({ singleError: new Error('single query failed') });
    const result = await runFetch({}, h.deps);
    expect(result.singleHeroResults[0]).toMatchObject({
      status: 'FAILED',
      error: 'single query failed',
    });
    expect(result.dataStatus).toBe('REAL_STRATZ');
  });

  it('closes the transport after successful fetch', async () => {
    const h = harness();
    await runFetch({}, h.deps);
    expect(h.calls.close).toBe(1);
  });

  it('does not write input if transport close fails', async () => {
    const h = harness({ closeError: new Error('close failed') });
    await expect(runFetch({}, h.deps)).rejects.toThrow('close failed');
    expect(existsSync(inputPath())).toBe(false);
  });

  it('saves a complete canonical input with independently verifiable SHA-256', async () => {
    const h = harness();
    const result = await runFetch({}, h.deps);
    const { inputSha256, ...withoutHash } = result;
    expect(inputSha256).toBe(createHash('sha256')
      .update(JSON.stringify(canonicalize(withoutHash))).digest('hex'));
    expect(JSON.parse(readFileSync(inputPath(), 'utf8'))).toEqual(result);
  });

  it('atomically renames a completed input into place', async () => {
    const h = harness();
    const renameSpy = vi.fn(renameSync);
    await runFetch({}, { ...h.deps, renameSync: renameSpy });
    expect(renameSpy).toHaveBeenCalledOnce();
    expect(renameSpy.mock.calls[0][1]).toBe(inputPath());
    expect(existsSync(inputPath())).toBe(true);
  });

  it('never persists the token or authorization material', async () => {
    const h = harness();
    const result = await runFetch({}, h.deps);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('test-token-never-persist');
    expect(serialized).not.toMatch(/authorization|cookie|Bearer/i);
    expect(result.dataProvenance.tokenPersisted).toBe(false);
  });

  it('accepts a valid historical four-bucket window and computes UTC boundaries', async () => {
    const h = harness();
    const result = await runFetch({ window: '2957...2960' }, h.deps);
    expect(result.attemptedWindow).toMatchObject({
      buckets: bucketList,
      windowStartUtc: '2026-09-03T00:00:00.000Z',
      windowEndUtcExclusive: '2026-10-01T00:00:00.000Z',
    });
  });

  it('rejects malformed or non-four-bucket historical windows', async () => {
    const h = harness();
    await expect(runFetch({ window: '2957...2959' }, h.deps)).rejects.toThrow(/exactly 4/);
    expect(h.calls.init).toBe(0);
  });

  it('does not persist partial data when single-hero structure is invalid', async () => {
    const h = harness({
      response: (ids, buckets, index) => index > 4
        ? { data: { heroStats: {} } }
        : fixtureResponse(ids, buckets),
    });
    const result = await runFetch({}, h.deps);
    expect(result.singleHeroResults[0].status).toBe('FAILED');
    expect(existsSync(inputPath())).toBe(true);
  });
});

describe('offline report and integrity check', () => {
  it('builds a NOT_COLLECTED report without network access', async () => {
    const input = inputPath();
    const report = path.join(tempDir, 'report.json');
    const meta = path.join(tempDir, 'meta.json');
    writeFileSync(input, JSON.stringify(notCollectedInput()));
    writeFileSync(meta, JSON.stringify({ matchupWindow: { weeklyBuckets: [2957, 2958, 2959, 2960] } }));
    const result = await runReport({
      inputPath: input,
      reportPath: report,
      metaPath: meta,
      repeatabilityEvidencePath: path.join(tempDir, 'no-evidence.json'),
    });
    expect(result.diagnosticDataStatus).toBe('NOT_COLLECTED');
    expect(result.observations).toEqual([]);
    expect(result.diagnosticWindow).toEqual([]);
    expect(result.productionPublishAllowed).toBe(false);
  });

  it('passes integrity check for a matching NOT_COLLECTED report', async () => {
    const input = inputPath();
    const report = path.join(tempDir, 'report.json');
    const meta = path.join(tempDir, 'meta.json');
    writeFileSync(input, JSON.stringify(notCollectedInput()));
    writeFileSync(meta, JSON.stringify({ matchupWindow: { weeklyBuckets: bucketList } }));
    const deps = {
      inputPath: input,
      reportPath: report,
      metaPath: meta,
      repeatabilityEvidencePath: path.join(tempDir, 'no-evidence.json'),
    };
    await runReport(deps);
    await expect(runCheck(deps))
      .resolves.toMatchObject({ status: 'PASS', diagnosticDataStatus: 'NOT_COLLECTED' });
  });

  it('rejects tampered inputs and stale deterministic reports', async () => {
    const input = inputPath();
    const report = path.join(tempDir, 'report.json');
    const meta = path.join(tempDir, 'meta.json');
    const payload = notCollectedInput();
    writeFileSync(input, JSON.stringify(payload));
    writeFileSync(meta, JSON.stringify({ matchupWindow: { weeklyBuckets: bucketList } }));
    const deps = {
      inputPath: input,
      reportPath: report,
      metaPath: meta,
      repeatabilityEvidencePath: path.join(tempDir, 'no-evidence.json'),
    };
    await runReport(deps);
    payload.diagnosticRunId = 'tampered';
    writeFileSync(input, JSON.stringify(payload));
    await expect(runCheck(deps))
      .rejects.toThrow(/SHA-256 mismatch/);
  });
});

describe('pair-level bucket report', () => {
  it('reports both problem pairs by bucket with hero names and both directions', async () => {
    const h = await collectPairFixture({
      abCounts: { 2957: [100, 80] },
      bcCounts: { 2958: [110, 90] },
    });
    const paths = writeReportFixtures();
    const report = await runReport({ ...h.deps, ...paths });
    expect(report.pairBucketBreakdown).toHaveLength(8);
    expect(report.pairBucketBreakdown.map((pair) => pair.canonicalPairId))
      .toEqual(['58:61', '58:61', '58:61', '58:61', '61:79', '61:79', '61:79', '61:79']);
    const first = report.pairBucketBreakdown.find((pair) => pair.canonicalPairId === '58:61' && pair.bucket === 2957);
    expect(first).toMatchObject({
      heroA: 'Enchantress',
      heroB: 'Broodmother',
      gamesA: 100,
      gamesB: 80,
      winsA: 40,
      winsB: 40,
      absoluteGamesDelta: 20,
      thresholdExceeded: true,
      status: 'FAIL',
    });
    expect(first.directions).toHaveLength(2);
    expect(report.pairBucketBreakdown.find((pair) => pair.canonicalPairId === '61:79' && pair.bucket === 2958))
      .toMatchObject({ heroA: 'Broodmother', heroB: 'Shadow Demon', thresholdExceeded: true });
  });

  it('keeps a missing reverse null and marks it MISSING_REVERSE', async () => {
    const h = await collectPairFixture({ missingDirection: '61:58' });
    const paths = writeReportFixtures();
    const report = await runReport({ ...h.deps, ...paths });
    const row = report.pairBucketBreakdown.find((pair) => pair.canonicalPairId === '58:61' && pair.bucket === 2957);
    expect(row).toMatchObject({
      gamesA: 100,
      gamesB: null,
      winsB: null,
      absoluteGamesDelta: null,
      thresholdExceeded: null,
      status: 'MISSING_REVERSE',
    });
  });

  describe('independent STRATZ repeatability diagnostic', () => {
    const config = { targetHeroIds: [1, 2, 3], buckets: bucketList };

    it('creates two independent transports and queries each configured hero in both passes', async () => {
      const h = repeatabilityHarness();
      const originalInput = readFileSync(h.deps.inputPath, 'utf8');
      const evidence = await runRepeatability(config, h.deps);
      expect(h.calls.transports).toBe(2);
      expect(h.calls.closed).toBe(2);
      expect(h.calls.queries).toHaveLength(6);
      expect(h.calls.queries.map((call) => `${call.pass}:${call.ids[0]}`))
        .toEqual(['1:1', '1:2', '1:3', '2:1', '2:2', '2:3']);
      expect(evidence.passes.map((pass) => pass.status)).toEqual(['COMPLETE', 'COMPLETE']);
      expect(readFileSync(h.deps.inputPath, 'utf8')).toBe(originalInput);
    });

    it('passes repeatability only when all normalized matchup rows match', async () => {
      const h = repeatabilityHarness();
      const evidence = await runRepeatability(config, h.deps);
      expect(evidence.status).toBe('PASS');
      expect(evidence.matchingRowCount).toBe(16);
      expect(evidence.mismatchingRowCount).toBe(0);
      expect(evidence.mismatches).toEqual([]);
    });

    it('fails and lists rows when matchCount changes between passes', async () => {
      const h = repeatabilityHarness({
        response: (pass, ids, buckets) => repeatResponse(ids, buckets, {
          pass,
          changed: 'matchCount',
        }),
      });
      const evidence = await runRepeatability(config, h.deps);
      expect(evidence.status).toBe('FAIL');
      expect(evidence.mismatchingRowCount).toBeGreaterThan(0);
      expect(evidence.mismatches[0]).toMatchObject({
        matches: false,
        pass1: expect.objectContaining({ matchCount: expect.any(Number) }),
        pass2: expect.objectContaining({ matchCount: expect.any(Number) }),
      });
    });

    it('fails and lists rows when winCount changes between passes', async () => {
      const h = repeatabilityHarness({
        response: (pass, ids, buckets) => repeatResponse(ids, buckets, {
          pass,
          changed: 'winCount',
        }),
      });
      const evidence = await runRepeatability(config, h.deps);
      expect(evidence.status).toBe('FAIL');
      expect(evidence.mismatches[0].pass1.winCount).not.toBe(evidence.mismatches[0].pass2.winCount);
    });

    it('marks a pass with a missing bucket INCOMPLETE instead of PASS', async () => {
      const h = repeatabilityHarness({
        response: (pass, ids, buckets) => repeatResponse(ids, buckets, {
          pass,
          missingBucket: pass === 2 ? 2958 : undefined,
        }),
      });
      const evidence = await runRepeatability(config, h.deps);
      expect(evidence.status).toBe('INCOMPLETE');
      expect(evidence.passes[1].status).toBe('INCOMPLETE');
      expect(evidence.passes[1].queries.every((query) => query.status === 'FAILED')).toBe(true);
    });

    it('continues to an independent second pass after the first transport fails', async () => {
      const h = repeatabilityHarness({ initErrorPass: 1 });
      const evidence = await runRepeatability(config, h.deps);
      expect(evidence.status).toBe('INCOMPLETE');
      expect(evidence.passes.map((pass) => pass.status)).toEqual(['INCOMPLETE', 'COMPLETE']);
      expect(h.calls.transports).toBe(2);
      expect(h.calls.closed).toBe(2);
    });

    it('marks a failed second transport INCOMPLETE and closes both transports', async () => {
      const h = repeatabilityHarness({ initErrorPass: 2 });
      const evidence = await runRepeatability(config, h.deps);
      expect(evidence.status).toBe('INCOMPLETE');
      expect(evidence.passes.map((pass) => pass.status)).toEqual(['COMPLETE', 'INCOMPLETE']);
      expect(h.calls.closed).toBe(2);
    });

    it('normalizes response and matchup row ordering before comparison and hashing', async () => {
      const h = repeatabilityHarness({
        response: (pass, ids, buckets) => repeatResponse(ids, buckets, {
          pass,
          reverseOrder: pass === 2,
        }),
      });
      const evidence = await runRepeatability(config, h.deps);
      expect(evidence.status).toBe('PASS');
      expect(evidence.passes[0].queries[0].responseHash)
        .toBe(evidence.passes[1].queries[0].responseHash);
    });

    it('stores independently verifiable request and normalized response SHA-256 hashes', async () => {
      const h = repeatabilityHarness();
      const evidence = await runRepeatability(config, h.deps);
      const query = JSON.stringify({ ids: [1], buckets: bucketList });
      expect(evidence.passes[0].queries[0].requestHash)
        .toBe(createHash('sha256').update(query).digest('hex'));
      expect(evidence.passes[0].queries[0].responseHash).toMatch(/^[a-f0-9]{64}$/);
      expect(evidence.passes[0].queries[0].response).toEqual(repeatResponse([1], bucketList, { pass: 1 }));
      expect(evidence.passes[0].queries[0].responseHash)
        .toBe(normalizedResponseHash(evidence.passes[0].queries[0].response));
      expect(JSON.parse(readFileSync(h.deps.evidencePath, 'utf8')).evidenceSha256)
        .toBe(evidence.evidenceSha256);
    });
  });

  it('reports a repeated multi-bucket anomaly without claiming its cause is solved', async () => {
    const h = await collectPairFixture({
      abCounts: Object.fromEntries(bucketList.map((bucket) => [bucket, [100, 80]])),
    });
    const paths = writeReportFixtures();
    const report = await runReport({ ...h.deps, ...paths });
    expect(report.pairBucketBreakdown.filter((pair) =>
      pair.canonicalPairId === '58:61' && pair.thresholdExceeded,
    )).toHaveLength(4);
    expect(report.rootCause).toMatchObject({
      status: 'UNRESOLVED',
      observedPattern: 'PERSISTENT_DIRECTIONAL_ASYMMETRY',
    });
  });

  it('isolates a one-bucket anomaly and emits deterministic pair ordering', async () => {
    const h = await collectPairFixture({ abCounts: { 2958: [100, 80] } });
    const paths = writeReportFixtures();
    const first = await runReport({ ...h.deps, ...paths });
    const second = await runReport({ ...h.deps, ...paths });
    expect(first.pairBucketBreakdown.filter((pair) =>
      pair.canonicalPairId === '58:61' && pair.thresholdExceeded,
    ).map((pair) => pair.bucket)).toEqual([2958]);
    expect(first.rootCause.observedPattern).toBe('BUCKET_SPECIFIC_ANOMALY');
    expect(first.pairBucketBreakdown).toEqual(second.pairBucketBreakdown);
  });

  it('applies the strict production threshold in each direction', async () => {
    const h = await collectPairFixture({
      abCounts: { 2957: [115, 100], 2958: [116, 100] },
      bcCounts: { 2957: [116, 100] },
    });
    const paths = writeReportFixtures();
    const report = await runReport({ ...h.deps, ...paths });
    expect(report.pairBucketBreakdown.find((pair) =>
      pair.canonicalPairId === '58:61' && pair.bucket === 2957,
    )).toMatchObject({ absoluteGamesDelta: 15, thresholdExceeded: false, status: 'PASS' });
    expect(report.pairBucketBreakdown.find((pair) =>
      pair.canonicalPairId === '61:79' && pair.bucket === 2957,
    )).toMatchObject({ absoluteGamesDelta: 16, thresholdExceeded: true, status: 'FAIL' });
  });
});
