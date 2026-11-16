#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import {
  StratzTransport,
  loadToken,
  buildChunkQuery,
  getCompleteWeeklyBuckets,
  BUCKET_SEC,
  CHUNK_SIZE,
  WEEKS_COUNT,
  BRACKETS,
  aggregateStratzMatchupChunks,
} from './update-data-stratz.mjs';
import {
  fetchOpenDotaMetadata,
  validateHeroMetadata,
} from './opendota/metadata.mjs';
import { diagnoseDataset } from './stratz-matchup-asymmetry-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL_INPUT_PATH = path.join(ROOT, 'scripts', 'stratz-diagnostic-input.json');
const RESEARCH_REPORT_PATH = path.join(
  ROOT,
  'research',
  'data-quality',
  'stratz-reverse-pair-asymmetry-report.json',
);
const META_PATH = path.join(ROOT, 'public', 'data', 'meta.json');
const HEROES_PATH = path.join(ROOT, 'public', 'data', 'heroes.json');
const REPEATABILITY_EVIDENCE_PATH = path.join(
  ROOT,
  'research',
  'data-quality',
  'stratz-reverse-pair-repeatability-evidence.json',
);

export const FIX10_REPEATABILITY_CONFIG = Object.freeze({
  targetHeroIds: Object.freeze([58, 61, 79]),
  buckets: Object.freeze([2963, 2964, 2965, 2966]),
});

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
};

function hashInput(input) {
  const { inputSha256: ignored, ...withoutHash } = input;
  return createHash('sha256').update(JSON.stringify(canonicalize(withoutHash))).digest('hex');
}

function hashEvidence(evidence) {
  const { evidenceSha256: ignored, ...withoutHash } = evidence;
  return createHash('sha256').update(JSON.stringify(canonicalize(withoutHash))).digest('hex');
}

function atomicWrite(filePath, value, deps = {}) {
  const mkdir = deps.mkdirSync ?? mkdirSync;
  const write = deps.writeFileSync ?? writeFileSync;
  const rename = deps.renameSync ?? renameSync;
  mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    write(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    rename(temporaryPath, filePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        throw new AggregateError([error, cleanupError], `Could not write ${filePath} or clean up its temporary file`);
      }
    }
    throw error;
  }
}

function parseHistoricalWindow(option) {
  if (option == null) return null;
  const match = /^(\d+)\.\.\.(\d+)$/.exec(String(option));
  if (!match) throw new Error('Invalid --window; expected START...END, for example 2957...2960');
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    throw new Error('Invalid --window: start and end must be integers and end must not precede start');
  }
  if (end - start + 1 !== WEEKS_COUNT) {
    throw new Error(`Invalid --window: exactly ${WEEKS_COUNT} consecutive buckets are required`);
  }
  const buckets = Array.from({ length: WEEKS_COUNT }, (_, index) => start + index);
  return {
    buckets,
    windowStartUtc: new Date(start * BUCKET_SEC * 1000).toISOString(),
    windowEndUtcExclusive: new Date((end + 1) * BUCKET_SEC * 1000).toISOString(),
  };
}

function resolveWindow(args, now) {
  const historical = parseHistoricalWindow(args.window);
  if (historical) return historical;
  const windowInfo = getCompleteWeeklyBuckets(now, WEEKS_COUNT);
  return {
    buckets: windowInfo.buckets,
    windowStartUtc: windowInfo.windowStartUtc,
    windowEndUtcExclusive: windowInfo.windowEndUtcExclusive,
  };
}

function validateHeroIds(metadata) {
  if (!Array.isArray(metadata.heroes) || metadata.heroes.length === 0) {
    throw new Error('OpenDota returned an empty hero list');
  }
  const ids = metadata.heroes.map((hero) => hero.id).sort((a, b) => a - b);
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('OpenDota returned a non-positive or non-integer hero ID');
  }
  if (new Set(ids).size !== ids.length) throw new Error('OpenDota returned duplicate hero IDs');
  const validation = validateHeroMetadata(metadata.heroes, metadata.latestPatch);
  if (validation.heroCount !== ids.length) throw new Error('OpenDota hero metadata count mismatch');
  return ids;
}

function validateBucketsResponse(response, buckets, expectedHeroIds, label) {
  if (!response || !response.data || !response.data.heroStats || Array.isArray(response.errors)) {
    throw new Error(`${label}: missing GraphQL data.heroStats or response contains GraphQL errors`);
  }
  const observedByBucket = {};
  const requested = new Set(expectedHeroIds);
  for (const bucket of buckets) {
    const dryads = response.data.heroStats[`w${bucket}`];
    if (!Array.isArray(dryads)) throw new Error(`${label}: missing or invalid bucket w${bucket}`);
    const observed = [];
    for (const dryad of dryads) {
      if (!Number.isSafeInteger(dryad?.heroId) || !requested.has(dryad.heroId)) {
        throw new Error(`${label}: unexpected or invalid heroId in bucket w${bucket}`);
      }
      if (observed.includes(dryad.heroId)) {
        throw new Error(`${label}: duplicate heroId ${dryad.heroId} in bucket w${bucket}`);
      }
      if (!Array.isArray(dryad.vs)) throw new Error(`${label}: invalid vs rows for hero ${dryad.heroId}`);
      observed.push(dryad.heroId);
    }
    observedByBucket[String(bucket)] = observed.sort((a, b) => a - b);
  }
  return observedByBucket;
}

function rawDirections(response, bucket, heroId) {
  const rows = response.data.heroStats[`w${bucket}`]
    .filter((dryad) => dryad.heroId === heroId)
    .flatMap((dryad) => dryad.vs);
  return new Map(rows.map((row) => [
    `${row.heroId1}:${row.heroId2}`,
    {
      heroId1: row.heroId1,
      heroId2: row.heroId2,
      matchCount: row.matchCount,
      winCount: row.winCount,
    },
  ]));
}

export async function querySingleHero(
  transport,
  heroId,
  buckets,
  queryBuilder = buildChunkQuery,
  query = queryBuilder([heroId], buckets),
) {
  return transport.query(query);
}

function compareSingleHero(batchChunks, singleResponse, heroId, buckets, batchObservedByBucket) {
  return buckets.map((bucket) => {
    const batchChunk = batchChunks.find((chunk) => chunk.chunkHeroIds.includes(heroId));
    const batchRows = batchChunk?.response?.data?.heroStats?.[`w${bucket}`];
    const batchResponse = {
      data: { heroStats: { [`w${bucket}`]: batchRows ?? [] } },
    };
    const batch = rawDirections(batchResponse, bucket, heroId);
    const single = rawDirections(singleResponse, bucket, heroId);
    const keys = [...new Set([...batch.keys(), ...single.keys()])].sort();
    const directions = keys.map((key) => {
      const batchRow = batch.get(key) ?? null;
      const singleRow = single.get(key) ?? null;
      return {
        key,
        batch: batchRow,
        single: singleRow,
        matches: JSON.stringify(batchRow) === JSON.stringify(singleRow),
      };
    });
    const batchHeroIds = batchObservedByBucket[String(bucket)] ?? [];
    const singleHeroIds = singleResponse.data.heroStats[`w${bucket}`]
      .map((dryad) => dryad.heroId).sort((a, b) => a - b);
    return {
      bucket,
      heroIdsMatch: batchHeroIds.includes(heroId) === singleHeroIds.includes(heroId),
      directions,
      matches: directions.every((direction) => direction.matches)
        && batchHeroIds.includes(heroId) === singleHeroIds.includes(heroId),
    };
  });
}

function normalizeStratzResponse(response) {
  const normalized = canonicalize(response);
  const heroStats = normalized?.data?.heroStats;
  if (!heroStats || typeof heroStats !== 'object') return normalized;
  for (const [bucket, dryads] of Object.entries(heroStats)) {
    if (!/^w\d+$/.test(bucket) || !Array.isArray(dryads)) continue;
    dryads.sort((a, b) => a.heroId - b.heroId);
    for (const dryad of dryads) {
      if (Array.isArray(dryad.vs)) {
        dryad.vs.sort((a, b) =>
          a.heroId1 - b.heroId1
          || a.heroId2 - b.heroId2
          || a.matchCount - b.matchCount
          || a.winCount - b.winCount);
      }
    }
  }
  return normalized;
}

function responseSha256(response) {
  return createHash('sha256')
    .update(JSON.stringify(normalizeStratzResponse(response)))
    .digest('hex');
}

function validateRepeatabilityConfig(config) {
  const { targetHeroIds, buckets } = config ?? {};
  if (!Array.isArray(targetHeroIds) || targetHeroIds.length === 0
    || targetHeroIds.some((heroId) => !Number.isSafeInteger(heroId) || heroId <= 0)
    || new Set(targetHeroIds).size !== targetHeroIds.length) {
    throw new Error('Repeatability targetHeroIds must be unique positive integers');
  }
  if (!Array.isArray(buckets) || buckets.length !== WEEKS_COUNT
    || buckets.some((bucket, index) => !Number.isSafeInteger(bucket)
      || (index > 0 && bucket !== buckets[index - 1] + 1))) {
    throw new Error(`Repeatability config requires ${WEEKS_COUNT} consecutive buckets`);
  }
  return {
    targetHeroIds: [...targetHeroIds],
    buckets: [...buckets],
    windowStartUtc: new Date(buckets[0] * BUCKET_SEC * 1000).toISOString(),
    windowEndUtcExclusive: new Date((buckets.at(-1) + 1) * BUCKET_SEC * 1000).toISOString(),
  };
}

function nowIso(deps) {
  const value = typeof deps.now === 'function' ? deps.now() : deps.now ?? new Date();
  return new Date(value).toISOString();
}

function validateRepeatabilityRows(response, buckets, targetHeroId, validHeroIds) {
  const validIds = validHeroIds ? new Set(validHeroIds) : null;
  for (const bucket of buckets) {
    const dryads = response.data.heroStats[`w${bucket}`];
    for (const dryad of dryads) {
      if (dryad.heroId !== targetHeroId) {
        throw new Error(`Repeatability response bucket w${bucket} contains unexpected hero ${dryad.heroId}`);
      }
      for (const row of dryad.vs) {
        if (!Number.isSafeInteger(row.heroId1) || row.heroId1 <= 0
          || !Number.isSafeInteger(row.heroId2) || row.heroId2 <= 0
          || row.heroId1 === row.heroId2
          || (row.heroId1 !== targetHeroId && row.heroId2 !== targetHeroId)
          || (validIds && (!validIds.has(row.heroId1) || !validIds.has(row.heroId2)))
          || !Number.isSafeInteger(row.matchCount) || row.matchCount < 0
          || !Number.isSafeInteger(row.winCount) || row.winCount < 0 || row.winCount > row.matchCount) {
          throw new Error(`Repeatability response contains an invalid matchup row for hero ${targetHeroId}`);
        }
      }
    }
  }
}

async function runRepeatabilityPass(passNumber, config, token, deps) {
  const Transport = deps.StratzTransport ?? StratzTransport;
  const queryBuilder = deps.buildChunkQuery ?? buildChunkQuery;
  const pass = {
    passNumber,
    status: 'INCOMPLETE',
    startedAt: nowIso(deps),
    finishedAt: null,
    queries: [],
  };
  let transport;
  try {
    transport = new Transport(token);
    await transport.init();
    for (const heroId of config.targetHeroIds) {
      const query = queryBuilder([heroId], config.buckets);
      const queryResult = {
        heroId,
        requestHash: createHash('sha256').update(query).digest('hex'),
        responseHash: null,
        status: 'FAILED',
        response: null,
      };
      try {
        const response = await transport.query(query);
        queryResult.response = response;
        queryResult.responseHash = responseSha256(response);
        validateBucketsResponse(response, config.buckets, [heroId], `repeatability pass ${passNumber}, hero ${heroId}`);
        validateRepeatabilityRows(response, config.buckets, heroId, deps.validHeroIds);
        queryResult.status = 'VERIFIED';
      } catch (error) {
        queryResult.error = redactError(error, token);
      }
      pass.queries.push(queryResult);
    }
    pass.status = pass.queries.length === config.targetHeroIds.length
      && pass.queries.every((queryResult) => queryResult.status === 'VERIFIED')
      ? 'COMPLETE'
      : 'INCOMPLETE';
  } catch (error) {
    pass.error = redactError(error, token);
    pass.status = 'INCOMPLETE';
  } finally {
    if (transport) {
      try {
        await transport.close();
      } catch (error) {
        pass.closeError = redactError(error, token);
        pass.status = 'INCOMPLETE';
      }
    }
    pass.finishedAt = nowIso(deps);
  }
  return pass;
}

function collectTargetRows(pass, config) {
  const rows = [];
  for (const query of pass?.queries ?? []) {
    if (query.status !== 'VERIFIED') continue;
    for (const bucket of config.buckets) {
      const dryads = query.response.data.heroStats[`w${bucket}`] ?? [];
      for (const dryad of dryads) {
        if (dryad.heroId !== query.heroId) continue;
        for (const row of dryad.vs) {
          rows.push({
            requestedHeroId: query.heroId,
            bucket,
            heroId1: row.heroId1,
            heroId2: row.heroId2,
            matchCount: row.matchCount,
            winCount: row.winCount,
          });
        }
      }
    }
  }
  return rows.sort((a, b) =>
    a.requestedHeroId - b.requestedHeroId
    || a.bucket - b.bucket
    || a.heroId1 - b.heroId1
    || a.heroId2 - b.heroId2
    || a.matchCount - b.matchCount
    || a.winCount - b.winCount);
}

function indexRepeatabilityRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.requestedHeroId}|${row.bucket}|${row.heroId1}:${row.heroId2}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const values of groups.values()) {
    values.sort((a, b) => a.matchCount - b.matchCount || a.winCount - b.winCount);
  }
  return groups;
}

function compareRepeatabilityRows(firstPass, secondPass, config) {
  const firstRows = collectTargetRows(firstPass, config);
  const secondRows = collectTargetRows(secondPass, config);
  const first = indexRepeatabilityRows(firstRows);
  const second = indexRepeatabilityRows(secondRows);
  const comparisons = [];
  for (const key of [...new Set([...first.keys(), ...second.keys()])].sort()) {
    const firstGroup = first.get(key) ?? [];
    const secondGroup = second.get(key) ?? [];
    for (let occurrence = 0; occurrence < Math.max(firstGroup.length, secondGroup.length); occurrence += 1) {
      const firstRow = firstGroup[occurrence] ?? null;
      const secondRow = secondGroup[occurrence] ?? null;
      comparisons.push({
        key: `${key}|${occurrence}`,
        pass1: firstRow,
        pass2: secondRow,
        matches: JSON.stringify(firstRow) === JSON.stringify(secondRow),
      });
    }
  }
  return {
    matchingRowCount: comparisons.filter((comparison) => comparison.matches).length,
    mismatchingRowCount: comparisons.filter((comparison) => !comparison.matches).length,
    mismatches: comparisons.filter((comparison) => !comparison.matches),
  };
}

export async function runRepeatability(config = FIX10_REPEATABILITY_CONFIG, deps = {}) {
  const inputPath = deps.inputPath ?? CANONICAL_INPUT_PATH;
  const evidencePath = deps.evidencePath ?? REPEATABILITY_EVIDENCE_PATH;
  const validatedConfig = validateRepeatabilityConfig(config);
  const input = readInput(inputPath, deps.readFileSync);
  const evidence = {
    schemaVersion: 1,
    repeatabilityRunId: deps.repeatabilityRunId ?? randomUUID(),
    fix9InputSha256: input.inputSha256,
    diagnosticConfig: validatedConfig,
    transport: 'production-StratzTransport',
    tokenPersisted: false,
    passes: [],
    status: 'NOT_RUN',
    matchingRowCount: 0,
    mismatchingRowCount: 0,
    mismatches: [],
    evidenceSha256: '',
  };
  let token;
  try {
    token = (deps.loadToken ?? loadToken)();
  } catch (error) {
    evidence.error = redactError(error, '');
    evidence.evidenceSha256 = hashEvidence(evidence);
    assertNoCredentials(evidence);
    atomicWrite(evidencePath, evidence, deps);
    return evidence;
  }

  const passDeps = {
    ...deps,
    validHeroIds: input.dataStatus === 'REAL_STRATZ' ? input.heroMetadata.heroIds : undefined,
  };
  if (input.dataStatus === 'REAL_STRATZ'
    && validatedConfig.targetHeroIds.some((heroId) => !input.heroMetadata.heroIds.includes(heroId))) {
    throw new Error('Repeatability target hero IDs are not present in the FIX9 input');
  }
  evidence.passes.push(await runRepeatabilityPass(1, validatedConfig, token, passDeps));
  evidence.passes.push(await runRepeatabilityPass(2, validatedConfig, token, passDeps));
  const comparison = compareRepeatabilityRows(
    evidence.passes[0],
    evidence.passes[1],
    validatedConfig,
  );
  evidence.matchingRowCount = comparison.matchingRowCount;
  evidence.mismatchingRowCount = comparison.mismatchingRowCount;
  evidence.mismatches = comparison.mismatches;
  evidence.status = evidence.passes.every((pass) => pass.status === 'COMPLETE')
    ? comparison.mismatchingRowCount === 0 ? 'PASS' : 'FAIL'
    : 'INCOMPLETE';
  evidence.evidenceSha256 = hashEvidence(evidence);
  assertNoCredentials(evidence, token);
  atomicWrite(evidencePath, evidence, deps);
  return evidence;
}

function makeInput({
  diagnosticRunId = randomUUID(),
  retrievedAt = new Date().toISOString(),
  windowInfo,
  heroMetadata,
  heroIds,
  batchChunks = [],
  observedHeroIdsByBucket = {},
  singleHeroResults = [],
  dataStatus = 'REAL_STRATZ',
}) {
  const requested = new Set(heroIds);
  const missingHeroIdsByBucket = Object.fromEntries(windowInfo.buckets.map((bucket) => [
    String(bucket),
    heroIds.filter((heroId) => !(observedHeroIdsByBucket[String(bucket)] ?? []).includes(heroId)),
  ]));
  const input = {
    schemaVersion: 2,
    diagnosticRunId,
    dataStatus,
    datasetSource: dataStatus === 'SYNTHETIC_FIXTURE' ? 'SYNTHETIC' : 'STRATZ',
    retrievedAt,
    attemptedWindow: {
      buckets: windowInfo.buckets,
      windowStartUtc: windowInfo.windowStartUtc,
      windowEndUtcExclusive: windowInfo.windowEndUtcExclusive,
    },
    heroMetadata: {
      source: 'OpenDota',
      latestPatch: heroMetadata?.latestPatch ?? '',
      heroCount: heroIds.length,
      heroIds,
    },
    queryConfiguration: {
      chunkSize: CHUNK_SIZE,
      weeksCount: WEEKS_COUNT,
      brackets: [...BRACKETS],
    },
    batchResults: {
      chunks: batchChunks,
      requestedHeroIds: heroIds,
      observedHeroIdsByBucket,
      missingHeroIdsByBucket,
    },
    singleHeroResults,
    queryHashes: [
      ...batchChunks.map((chunk) => chunk.queryHash),
      ...singleHeroResults.map((result) => result.queryHash),
    ],
    dataProvenance: {
      transport: 'production-StratzTransport',
      tokenPersisted: false,
    },
    inputSha256: '',
  };
  if (requested.size !== heroIds.length) throw new Error('Duplicate requested hero IDs');
  input.inputSha256 = hashInput(input);
  return input;
}

export async function runFetch(args = {}, deps = {}) {
  const tokenLoader = deps.loadToken ?? loadToken;
  const metadataFetcher = deps.fetchOpenDotaMetadata ?? fetchOpenDotaMetadata;
  const Transport = deps.StratzTransport ?? StratzTransport;
  const queryBuilder = deps.buildChunkQuery ?? buildChunkQuery;
  const inputPath = deps.inputPath ?? CANONICAL_INPUT_PATH;
  const now = deps.now ?? new Date();
  const logger = deps.log ?? console;

  const token = tokenLoader();
  const metadata = await metadataFetcher();
  validateHeroMetadata(metadata.heroes, metadata.latestPatch);
  const heroIds = validateHeroIds(metadata);
  const windowInfo = resolveWindow(args, now);
  const heroIdChunks = [];
  for (let index = 0; index < heroIds.length; index += CHUNK_SIZE) {
    heroIdChunks.push(heroIds.slice(index, index + CHUNK_SIZE));
  }

  const transport = new Transport(token);
  const batchChunks = [];
  let transportError = null;
  let inputToWrite;
  try {
    await transport.init();
    for (let chunkIndex = 0; chunkIndex < heroIdChunks.length; chunkIndex += 1) {
      const chunkHeroIds = heroIdChunks[chunkIndex];
      const query = queryBuilder(chunkHeroIds, windowInfo.buckets);
      const response = await transport.query(query);
      validateBucketsResponse(response, windowInfo.buckets, chunkHeroIds, `batch chunk ${chunkIndex}`);
      batchChunks.push({
        chunkIndex,
        chunkHeroIds,
        queryHash: createHash('sha256').update(query).digest('hex'),
        response,
      });
    }

    const observedHeroIdsByBucket = Object.fromEntries(windowInfo.buckets.map((bucket) => [
      String(bucket),
      [...new Set(batchChunks.flatMap((chunk) =>
        chunk.response.data.heroStats[`w${bucket}`].map((dryad) => dryad.heroId)))].sort((a, b) => a - b),
    ]));
    const batchDatasets = windowInfo.buckets.map((bucket) => ({
      bucket,
      dataset: aggregateStratzMatchupChunks(
        batchChunks.map(({ chunkIndex, chunkHeroIds, response }) => ({ chunkIndex, chunkHeroIds, response })),
        { buckets: [bucket] },
        new Set(heroIds),
      ),
    }));
    const problematicHeroIds = new Set();
    for (const { dataset } of batchDatasets) {
      const analysis = diagnoseDataset(dataset);
      for (const pair of analysis.pairDiagnoses) {
        if (pair.thresholdExceeded === true) {
          problematicHeroIds.add(pair.heroIdA);
          problematicHeroIds.add(pair.heroIdB);
        }
      }
    }
    if (problematicHeroIds.size === 0) problematicHeroIds.add(heroIds[0]);

    const singleHeroResults = [];
    for (const heroId of [...problematicHeroIds].sort((a, b) => a - b)) {
      const query = queryBuilder([heroId], windowInfo.buckets);
      const queryHash = createHash('sha256').update(query).digest('hex');
      try {
        const response = await querySingleHero(
          transport,
          heroId,
          windowInfo.buckets,
          queryBuilder,
          query,
        );
        validateBucketsResponse(response, windowInfo.buckets, [heroId], `single hero ${heroId}`);
        aggregateStratzMatchupChunks(
          [{ chunkIndex: 0, chunkHeroIds: [heroId], response }],
          { buckets: windowInfo.buckets },
          new Set(heroIds),
        );
        singleHeroResults.push({
          heroId,
          buckets: windowInfo.buckets,
          queryHash,
          status: 'VERIFIED',
          response,
          comparisons: compareSingleHero(
            batchChunks,
            response,
            heroId,
            windowInfo.buckets,
            observedHeroIdsByBucket,
          ),
        });
      } catch (error) {
        singleHeroResults.push({
          heroId,
          buckets: windowInfo.buckets,
          queryHash,
          status: 'FAILED',
          error: redactError(error, token),
        });
      }
    }

    inputToWrite = makeInput({
      diagnosticRunId: deps.diagnosticRunId,
      retrievedAt: (deps.now ?? new Date()).toISOString(),
      windowInfo,
      heroMetadata: metadata,
      heroIds,
      batchChunks,
      observedHeroIdsByBucket,
      singleHeroResults,
    });
  } catch (error) {
    transportError = error;
    throw error;
  } finally {
    try {
      await transport.close();
    } catch (closeError) {
      if (transportError) {
        throw new AggregateError([transportError, closeError], 'Fetch and transport close both failed');
      }
      throw closeError;
    }
  }
  atomicWrite(inputPath, inputToWrite, deps);
  logger.info?.(`Saved ${batchChunks.length} batch chunks to ${inputPath}`);
  return inputToWrite;
}

function redactError(error, token) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(token).join('<redacted>').replace(/Bearer\s+\S+/gi, 'Bearer <redacted>');
}

function assertNoCredentials(value, token = '') {
  if (Array.isArray(value)) {
    for (const item of value) assertNoCredentials(item, token);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'tokenPersisted' && /token|authorization|cookie|secret|credential/i.test(key)) {
        throw new Error(`Credential-like field found in diagnostic input: ${key}`);
      }
      assertNoCredentials(child, token);
    }
  } else if (typeof value === 'string') {
    if ((token && value.includes(token)) || /Bearer\s+\S+|(?:api[_-]?key)\s*[:=]/i.test(value)) {
      throw new Error('Credential-like value found in diagnostic input');
    }
  }
}

function readInput(inputPath, read = readFileSync) {
  if (!existsSync(inputPath)) throw new Error(`Canonical diagnostic input not found: ${inputPath}`);
  let input;
  try {
    input = JSON.parse(read(inputPath, 'utf8'));
  } catch (error) {
    throw new Error(`Canonical diagnostic input is not valid JSON: ${error.message}`);
  }
  if (input.schemaVersion !== 2) throw new Error(`Unsupported diagnostic schemaVersion: ${input.schemaVersion}`);
  if (!['REAL_STRATZ', 'NOT_COLLECTED', 'SYNTHETIC_FIXTURE'].includes(input.dataStatus)) {
    throw new Error(`Invalid diagnostic dataStatus: ${input.dataStatus}`);
  }
  if (input.inputSha256 !== hashInput(input)) throw new Error('Diagnostic input SHA-256 mismatch');
  assertNoCredentials(input);
  const required = [
    'diagnosticRunId', 'datasetSource', 'retrievedAt', 'attemptedWindow', 'heroMetadata',
    'queryConfiguration', 'batchResults', 'singleHeroResults', 'queryHashes', 'dataProvenance',
  ];
  for (const key of required) if (!(key in input)) throw new Error(`Diagnostic input missing ${key}`);
  if (!Array.isArray(input.attemptedWindow.buckets)
    || input.attemptedWindow.buckets.length !== WEEKS_COUNT
    || input.attemptedWindow.buckets.some((bucket, index, buckets) =>
      !Number.isSafeInteger(bucket) || (index > 0 && bucket !== buckets[index - 1] + 1))) {
    throw new Error('Diagnostic input must contain four consecutive attempted buckets');
  }
  const expectedStart = input.attemptedWindow.buckets[0] * BUCKET_SEC * 1000;
  const expectedEnd = (input.attemptedWindow.buckets.at(-1) + 1) * BUCKET_SEC * 1000;
  if (new Date(input.attemptedWindow.windowStartUtc).getTime() !== expectedStart
    || new Date(input.attemptedWindow.windowEndUtcExclusive).getTime() !== expectedEnd) {
    throw new Error('Diagnostic input UTC boundaries do not match its attempted buckets');
  }
  if (input.queryConfiguration.chunkSize !== CHUNK_SIZE
    || input.queryConfiguration.weeksCount !== WEEKS_COUNT) {
    throw new Error('Diagnostic query configuration does not match production');
  }
  if (!Array.isArray(input.queryConfiguration.brackets)
    || JSON.stringify(input.queryConfiguration.brackets) !== JSON.stringify(BRACKETS)) {
    throw new Error('Diagnostic bracket configuration does not match production');
  }
  if (input.dataProvenance.transport !== 'production-StratzTransport'
    || input.dataProvenance.tokenPersisted !== false) {
    throw new Error('Diagnostic input has invalid transport provenance');
  }
  if (input.dataStatus === 'REAL_STRATZ') {
    if (input.datasetSource !== 'STRATZ') throw new Error('REAL_STRATZ input must have datasetSource STRATZ');
    if (!Array.isArray(input.batchResults.chunks) || input.batchResults.chunks.length === 0) {
      throw new Error('REAL_STRATZ input contains no batch chunks');
    }
    const heroIds = input.heroMetadata.heroIds;
    if (!Array.isArray(heroIds)
      || heroIds.length !== input.heroMetadata.heroCount
      || heroIds.some((heroId) => !Number.isSafeInteger(heroId) || heroId <= 0)
      || new Set(heroIds).size !== heroIds.length
      || heroIds.some((heroId, index) => index > 0 && heroId <= heroIds[index - 1])) {
      throw new Error('REAL_STRATZ input has invalid or duplicate hero IDs');
    }
    if (JSON.stringify(input.batchResults.requestedHeroIds) !== JSON.stringify(heroIds)) {
      throw new Error('Batch requestedHeroIds do not match OpenDota metadata');
    }
    const seen = new Set();
    for (const [index, chunk] of input.batchResults.chunks.entries()) {
      if (chunk.chunkIndex !== index) throw new Error('Batch chunk indices are not contiguous');
      if (!Array.isArray(chunk.chunkHeroIds) || chunk.chunkHeroIds.length === 0
        || chunk.chunkHeroIds.length > CHUNK_SIZE) {
        throw new Error(`Invalid chunk size for chunk ${chunk.chunkIndex}`);
      }
      if (chunk.chunkHeroIds.some((heroId) => !Number.isSafeInteger(heroId) || heroId <= 0 || !heroIds.includes(heroId))) {
        throw new Error(`Chunk ${chunk.chunkIndex} contains an invalid or unknown hero ID`);
      }
      if (chunk.chunkHeroIds.some((heroId) => seen.has(heroId))) {
        throw new Error('REAL_STRATZ input has overlapping hero chunks');
      }
      chunk.chunkHeroIds.forEach((heroId) => seen.add(heroId));
      validateBucketsResponse(chunk.response, input.attemptedWindow.buckets, chunk.chunkHeroIds, `input chunk ${chunk.chunkIndex}`);
      if (!/^[a-f0-9]{64}$/.test(chunk.queryHash)) throw new Error('Invalid batch query hash');
    }
    if (seen.size !== heroIds.length || heroIds.some((heroId) => !seen.has(heroId))) {
      throw new Error('Batch chunks do not cover the requested hero IDs');
    }
    const observed = Object.fromEntries(input.attemptedWindow.buckets.map((bucket) => [
      String(bucket),
      [...new Set(input.batchResults.chunks.flatMap((chunk) =>
        chunk.response.data.heroStats[`w${bucket}`].map((dryad) => dryad.heroId)))].sort((a, b) => a - b),
    ]));
    if (JSON.stringify(canonicalize(observed)) !== JSON.stringify(canonicalize(input.batchResults.observedHeroIdsByBucket))) {
      throw new Error('Observed hero ID indexes do not match stored batch responses');
    }
    const missing = Object.fromEntries(input.attemptedWindow.buckets.map((bucket) => [
      String(bucket),
      heroIds.filter((heroId) => !observed[String(bucket)].includes(heroId)),
    ]));
    if (JSON.stringify(canonicalize(missing)) !== JSON.stringify(canonicalize(input.batchResults.missingHeroIdsByBucket))) {
      throw new Error('Missing hero ID indexes do not match stored batch responses');
    }
    if (!Array.isArray(input.singleHeroResults) || input.singleHeroResults.length === 0) {
      throw new Error('REAL_STRATZ input has no single-hero verification results');
    }
    for (const result of input.singleHeroResults) {
      if (!heroIds.includes(result.heroId) || !/^[a-f0-9]{64}$/.test(result.queryHash)) {
        throw new Error('Invalid single-hero result identity or query hash');
      }
      if (result.status === 'VERIFIED') {
        validateBucketsResponse(result.response, input.attemptedWindow.buckets, [result.heroId], `single hero ${result.heroId}`);
      } else if (result.status !== 'FAILED' || typeof result.error !== 'string' || result.error.length === 0) {
        throw new Error(`Invalid single-hero status for hero ${result.heroId}`);
      }
    }
    const expectedHashes = [
      ...input.batchResults.chunks.map((chunk) => chunk.queryHash),
      ...input.singleHeroResults.map((result) => result.queryHash),
    ];
    if (JSON.stringify(input.queryHashes) !== JSON.stringify(expectedHashes)) {
      throw new Error('queryHashes do not match batch and single-hero requests');
    }
  } else {
    const expectedSource = input.dataStatus === 'SYNTHETIC_FIXTURE' ? 'SYNTHETIC' : 'STRATZ';
    if (input.datasetSource !== expectedSource) {
      throw new Error(`${input.dataStatus} input has an invalid datasetSource`);
    }
    if (input.batchResults.chunks?.length) {
      throw new Error(`${input.dataStatus} input must not contain batch observations`);
    }
  }
  return input;
}

function loadProductionWindow(metaPath, read = readFileSync) {
  const meta = JSON.parse(read(metaPath, 'utf8'));
  const buckets = meta.matchupWindow?.weeklyBuckets;
  if (!Array.isArray(buckets)) throw new Error('Production meta.json has no matchupWindow.weeklyBuckets');
  return buckets;
}

function loadHeroNames(heroesPath, read = readFileSync) {
  const heroes = JSON.parse(read(heroesPath, 'utf8'));
  if (!Array.isArray(heroes)) throw new Error('Production heroes.json is not an array');
  return new Map(heroes.map((hero) => [hero.id, hero.name]));
}

function readRepeatabilityEvidence(evidencePath, input, read = readFileSync) {
  if (!existsSync(evidencePath)) return null;
  let evidence;
  try {
    evidence = JSON.parse(read(evidencePath, 'utf8'));
  } catch (error) {
    throw new Error(`Repeatability evidence is not valid JSON: ${error.message}`);
  }
  if (evidence.schemaVersion !== 1 || evidence.evidenceSha256 !== hashEvidence(evidence)) {
    throw new Error('Repeatability evidence schema or SHA-256 is invalid');
  }
  if (evidence.transport !== 'production-StratzTransport' || evidence.tokenPersisted !== false
    || !Array.isArray(evidence.passes)) {
    throw new Error('Repeatability evidence provenance or shape is invalid');
  }
  assertNoCredentials(evidence);
  if (evidence.fix9InputSha256 !== input.inputSha256) {
    throw new Error('Repeatability evidence does not reference the current FIX9 input');
  }
  return evidence;
}

function targetRowsFromResponse(response, requestedHeroId, buckets) {
  if (!response) return [];
  const rows = [];
  for (const bucket of buckets) {
    const dryads = response.data?.heroStats?.[`w${bucket}`] ?? [];
    for (const dryad of dryads) {
      if (dryad.heroId !== requestedHeroId) continue;
      for (const row of dryad.vs ?? []) {
        rows.push({
          requestedHeroId,
          bucket,
          heroId1: row.heroId1,
          heroId2: row.heroId2,
          matchCount: row.matchCount,
          winCount: row.winCount,
        });
      }
    }
  }
  return rows.sort((a, b) =>
    a.requestedHeroId - b.requestedHeroId
    || a.bucket - b.bucket
    || a.heroId1 - b.heroId1
    || a.heroId2 - b.heroId2
    || a.matchCount - b.matchCount
    || a.winCount - b.winCount);
}

function indexRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.requestedHeroId}|${row.bucket}|${row.heroId1}:${row.heroId2}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

function collectInputTargetRows(input, targetHeroIds, source) {
  const buckets = input.attemptedWindow.buckets;
  const rows = [];
  for (const heroId of targetHeroIds) {
    let response = null;
    if (source === 'batch') {
      const chunk = input.batchResults.chunks.find((item) => item.chunkHeroIds.includes(heroId));
      response = chunk?.response ?? null;
    } else {
      const single = input.singleHeroResults.find((item) => item.heroId === heroId && item.status === 'VERIFIED');
      response = single?.response ?? null;
    }
    rows.push(...targetRowsFromResponse(response, heroId, buckets));
  }
  return rows;
}

function collectEvidenceTargetRows(evidence, passIndex, targetHeroIds) {
  const pass = evidence?.passes?.[passIndex];
  if (!pass) return [];
  const rows = [];
  for (const query of pass.queries) {
    rows.push(...targetRowsFromResponse(query.status === 'VERIFIED' ? query.response : null,
      query.heroId, evidence.diagnosticConfig.buckets));
  }
  return rows;
}

function independentComparisons(input, evidence) {
  const targetHeroIds = evidence?.diagnosticConfig?.targetHeroIds ?? FIX10_REPEATABILITY_CONFIG.targetHeroIds;
  const verifiedSingleHeroIds = new Set(
    input.singleHeroResults.filter((item) => item.status === 'VERIFIED').map((item) => item.heroId),
  );
  const batch = indexRows(collectInputTargetRows(input, targetHeroIds, 'batch'));
  const single = indexRows(collectInputTargetRows(input, targetHeroIds, 'single'));
  const pass1 = indexRows(collectEvidenceTargetRows(evidence, 0, targetHeroIds));
  const pass2 = indexRows(collectEvidenceTargetRows(evidence, 1, targetHeroIds));
  const keys = [...new Set([...batch.keys(), ...single.keys(), ...pass1.keys(), ...pass2.keys()])].sort();
  const comparisons = [];
  for (const key of keys) {
    const groups = [batch, single, pass1, pass2].map((indexed) => indexed.get(key) ?? []);
    const [requestedHeroId, bucket, pairDirection] = key.split('|');
    for (let occurrence = 0; occurrence < Math.max(...groups.map((group) => group.length)); occurrence += 1) {
      const [batchRow, singleRow, pass1Row, pass2Row] = groups.map((group) => group[occurrence] ?? null);
      const singleHeroWasQueried = verifiedSingleHeroIds.has(Number(requestedHeroId));
      const equal = (left, right) => left && right
        ? left.heroId1 === right.heroId1
          && left.heroId2 === right.heroId2
          && left.matchCount === right.matchCount
          && left.winCount === right.winCount
        : left === right;
      comparisons.push({
        requestedHeroId: Number(requestedHeroId),
        bucket: Number(bucket),
        canonicalPairId: pairDirection.split(':').map(Number).sort((a, b) => a - b).join(':'),
        direction: pairDirection.replace(':', '->'),
        occurrence,
        batch: batchRow,
        singleHero: singleRow,
        pass1: pass1Row,
        pass2: pass2Row,
        batchSingleMatches: singleHeroWasQueried && (batchRow || singleRow)
          ? equal(batchRow, singleRow)
          : null,
        repeatabilityMatches: pass1Row || pass2Row ? equal(pass1Row, pass2Row) : null,
        fix9BatchPass1Matches: batchRow || pass1Row ? equal(batchRow, pass1Row) : null,
        fix9BatchPass2Matches: batchRow || pass2Row ? equal(batchRow, pass2Row) : null,
      });
    }
  }
  const countMismatches = (property) => comparisons.filter((item) => item[property] === false).length;
  const hasEvidence = Boolean(evidence);
  const batchSingleMismatchCount = countMismatches('batchSingleMatches');
  const repeatabilityMismatchCount = countMismatches('repeatabilityMatches');
  const fix9BatchPass1MismatchCount = countMismatches('fix9BatchPass1Matches');
  const fix9BatchPass2MismatchCount = countMismatches('fix9BatchPass2Matches');
  return {
    status: !hasEvidence
      ? 'NOT_RUN'
      : evidence.status === 'INCOMPLETE' || evidence.status === 'NOT_RUN'
        ? 'INCOMPLETE'
        : batchSingleMismatchCount > 0
          || repeatabilityMismatchCount > 0
          || fix9BatchPass1MismatchCount > 0
          || fix9BatchPass2MismatchCount > 0 ? 'FAIL' : 'PASS',
    comparedDirectionCount: comparisons.length,
    batchSingleMismatchCount,
    repeatabilityMismatchCount,
    fix9BatchPass1MismatchCount,
    fix9BatchPass2MismatchCount,
    comparisons,
  };
}

function summarizeRepeatability(evidence) {
  if (!evidence) return { status: 'NOT_RUN', matchingRowCount: 0, mismatchingRowCount: 0, mismatches: [] };
  return {
    status: evidence.status,
    repeatabilityRunId: evidence.repeatabilityRunId,
    evidenceSha256: evidence.evidenceSha256,
    fix9InputSha256: evidence.fix9InputSha256,
    diagnosticConfig: evidence.diagnosticConfig,
    passes: evidence.passes.map((pass) => ({
      passNumber: pass.passNumber,
      status: pass.status,
      startedAt: pass.startedAt,
      finishedAt: pass.finishedAt,
      error: pass.error ?? null,
      closeError: pass.closeError ?? null,
      queries: pass.queries.map((query) => ({
        heroId: query.heroId,
        status: query.status,
        requestHash: query.requestHash,
        responseHash: query.responseHash,
        error: query.error ?? null,
      })),
    })),
    matchingRowCount: evidence.matchingRowCount,
    mismatchingRowCount: evidence.mismatchingRowCount,
    mismatches: evidence.mismatches,
    error: evidence.error ?? null,
  };
}

function makePairBucketBreakdown(perBucket, focusPairIds, heroNames) {
  const output = [];
  for (const { bucket, dataset } of perBucket) {
    for (const canonical of focusPairIds) {
      const [heroAId, heroBId] = canonical.split(':').map(Number);
      const forward = (dataset[String(heroAId)] ?? []).filter((row) => row.hero_id === heroBId);
      const reverse = (dataset[String(heroBId)] ?? []).filter((row) => row.hero_id === heroAId);
      const duplicateForward = forward.length > 1;
      const duplicateReverse = reverse.length > 1;
      const duplicate = duplicateForward || duplicateReverse;
      const absent = forward.length === 0 || reverse.length === 0;
      const pair = diagnoseDataset(dataset).pairDiagnoses.find((item) => item.canonicalPairId === canonical);
      const comparable = !duplicate && !absent && forward.length === 1 && reverse.length === 1;
      const gamesA = forward.length === 1 ? forward[0].games_played : null;
      const gamesB = reverse.length === 1 ? reverse[0].games_played : null;
      const winsA = forward.length === 1 ? forward[0].wins : null;
      const winsB = reverse.length === 1 ? reverse[0].wins : null;
      const absoluteGamesDelta = comparable ? Math.abs(gamesA - gamesB) : null;
      const relativeDeltaA = comparable ? (gamesA === 0 ? 0 : absoluteGamesDelta / gamesA) : null;
      const relativeDeltaB = comparable ? (gamesB === 0 ? 0 : absoluteGamesDelta / gamesB) : null;
      const directionDiagnosisA = pair?.directionDiagnoses?.[0];
      const directionDiagnosisB = pair?.directionDiagnoses?.[1];
      const thresholdExceeded = comparable
        ? Boolean(directionDiagnosisA?.thresholdExceeded || directionDiagnosisB?.thresholdExceeded)
        : null;
      const status = duplicate
        ? 'DUPLICATE_DIRECTION'
        : absent
          ? forward.length === 0 && reverse.length === 0 ? 'NOT_OBSERVED' : 'MISSING_REVERSE'
          : thresholdExceeded ? 'FAIL' : 'PASS';
      output.push({
        canonicalPairId: canonical,
        bucket,
        heroAId,
        heroBId,
        heroA: heroNames.get(heroAId) ?? `Hero ${heroAId}`,
        heroB: heroNames.get(heroBId) ?? `Hero ${heroBId}`,
        gamesA,
        gamesB,
        winsA,
        winsB,
        absoluteGamesDelta,
        relativeDeltaA,
        relativeDeltaB,
        thresholdExceeded,
        status,
        directions: [
          {
            fromHeroId: heroAId,
            toHeroId: heroBId,
            count: forward.length,
            status: duplicate ? 'DUPLICATE_DIRECTION' : forward.length ? 'OBSERVED' : 'MISSING',
            rows: forward.map((row) => ({ games: row.games_played, wins: row.wins })),
            thresholdExceeded: comparable ? directionDiagnosisA.thresholdExceeded : null,
          },
          {
            fromHeroId: heroBId,
            toHeroId: heroAId,
            count: reverse.length,
            status: duplicate ? 'DUPLICATE_DIRECTION' : reverse.length ? 'OBSERVED' : 'MISSING',
            rows: reverse.map((row) => ({ games: row.games_played, wins: row.wins })),
            thresholdExceeded: comparable ? directionDiagnosisB.thresholdExceeded : null,
          },
        ],
      });
    }
  }
  return output.sort((a, b) =>
    a.canonicalPairId.localeCompare(b.canonicalPairId) || a.bucket - b.bucket);
}

function analyzeInput(input, evidence, heroNames) {
  const hasRealData = input.dataStatus === 'REAL_STRATZ';
  const batchChunks = hasRealData ? input.batchResults.chunks : [];
  const buckets = hasRealData ? input.attemptedWindow.buckets : [];
  const heroIds = hasRealData ? input.heroMetadata.heroIds : [];
  const perBucket = buckets.map((bucket) => ({
    bucket,
    dataset: aggregateStratzMatchupChunks(
      batchChunks.map(({ chunkIndex, chunkHeroIds, response }) => ({ chunkIndex, chunkHeroIds, response })),
      { buckets: [bucket] },
      new Set(heroIds),
    ),
  }));
  const aggregateDataset = hasRealData
    ? aggregateStratzMatchupChunks(
      batchChunks.map(({ chunkIndex, chunkHeroIds, response }) => ({ chunkIndex, chunkHeroIds, response })),
      { buckets },
      new Set(heroIds),
    )
    : {};
  const aggregateAnalysis = diagnoseDataset(aggregateDataset);
  const singleHeroComparisons = [];
  let singleHeroFailures = false;
  if (hasRealData) {
    for (const result of input.singleHeroResults) {
      if (result.status !== 'VERIFIED') {
        singleHeroFailures = true;
        continue;
      }
      validateBucketsResponse(result.response, buckets, [result.heroId], `single hero ${result.heroId}`);
      aggregateStratzMatchupChunks(
        [{ chunkIndex: 0, chunkHeroIds: [result.heroId], response: result.response }],
        { buckets },
        new Set(heroIds),
      );
      singleHeroComparisons.push(...compareSingleHero(
        batchChunks,
        result.response,
        result.heroId,
        buckets,
        input.batchResults.observedHeroIdsByBucket,
      ));
    }
  }
  const bucketAnalyses = perBucket.map(({ bucket, dataset }) => ({
    bucket,
    result: diagnoseDataset(dataset),
  }));
  const bucketBreakdown = bucketAnalyses.map(({ bucket, result }) => {
    return {
      bucket,
      checkedDirectionCount: result.checkedDirectionCount,
      directedViolationCount: result.directedViolations,
      uniqueViolationPairCount: result.uniqueViolationPairs,
      missingReversePairCount: result.missingReversePairCount,
      duplicateDirectionCount: result.duplicateDirectionCount,
    };
  });
  const significantPairs = new Set(
    aggregateAnalysis.pairDiagnoses
      .filter((pair) => pair.thresholdExceeded === true || pair.status !== 'COMPARED')
      .map((pair) => pair.canonicalPairId),
  );
  for (const { result } of bucketAnalyses) {
    for (const pair of result.pairDiagnoses) {
      if (pair.thresholdExceeded === true || pair.status !== 'COMPARED') {
        significantPairs.add(pair.canonicalPairId);
      }
    }
  }
  const pairBucketBreakdown = makePairBucketBreakdown(
    perBucket,
    [...significantPairs].sort((a, b) => {
      const [a1, a2] = a.split(':').map(Number);
      const [b1, b2] = b.split(':').map(Number);
      return a1 - b1 || a2 - b2;
    }),
    heroNames,
  );
  const consistencyMatches = singleHeroComparisons.every((comparison) => comparison.matches);
  const chunkConsistencyStatus = !hasRealData
    ? 'NOT_RUN'
    : singleHeroFailures || !consistencyMatches ? 'FAIL' : 'PASS';
  const diagnosticDataStatus = input.dataStatus === 'REAL_STRATZ'
    ? 'COLLECTED'
    : input.dataStatus === 'SYNTHETIC_FIXTURE' ? 'SYNTHETIC_ONLY' : 'NOT_COLLECTED';
  const repeatability = summarizeRepeatability(evidence);
  const independentQueryResult = independentComparisons(input, evidence);
  const aggregateViolationPairs = new Set(aggregateAnalysis.pairDiagnoses
    .filter((pair) => pair.thresholdExceeded === true)
    .map((pair) => pair.canonicalPairId));
  const failingBucketPairs = pairBucketBreakdown.filter((pair) =>
    aggregateViolationPairs.has(pair.canonicalPairId) && pair.thresholdExceeded === true);
  const failuresPerPair = new Map();
  for (const pair of failingBucketPairs) {
    failuresPerPair.set(pair.canonicalPairId, (failuresPerPair.get(pair.canonicalPairId) ?? 0) + 1);
  }
  const observedPattern = failingBucketPairs.length === 0
    ? null
    : [...failuresPerPair.values()].some((count) => count > 1)
      ? 'PERSISTENT_DIRECTIONAL_ASYMMETRY'
      : 'BUCKET_SPECIFIC_ANOMALY';
  let rootCauseStatus = 'UNRESOLVED';
  let rootCauseDescription = hasRealData
    ? 'Evidence identifies the observed pattern but does not establish its underlying cause.'
    : 'No real diagnostic observations collected';
  if (repeatability.status === 'FAIL') {
    rootCauseStatus = 'STRATZ_RESPONSE_NON_REPEATABLE';
    rootCauseDescription = 'Independent identical STRATZ requests returned different normalized matchup rows.';
  } else if (independentQueryResult.batchSingleMismatchCount > 0) {
    rootCauseStatus = 'BATCH_SINGLE_MISMATCH';
    rootCauseDescription = 'FIX9 batch and single-hero raw responses disagree for target matchup rows.';
  } else if (independentQueryResult.fix9BatchPass1MismatchCount > 0
    || independentQueryResult.fix9BatchPass2MismatchCount > 0) {
    rootCauseDescription =
      'Independent responses differ from FIX9 raw observations; available evidence does not establish whether source drift or another mechanism caused it.';
  } else if (repeatability.status === 'PASS' && observedPattern) {
    rootCauseDescription =
      'Repeated responses and FIX9 batch/single comparisons are stable; the cause of the directional asymmetry remains unresolved.';
  }
  const rootCauseEvidence = [
    ...(evidence ? [{
      type: 'repeatability-summary',
      status: evidence.status,
      evidenceSha256: evidence.evidenceSha256,
      matchingRowCount: evidence.matchingRowCount,
      mismatchingRowCount: evidence.mismatchingRowCount,
      passes: evidence.passes.map((pass) => ({
        passNumber: pass.passNumber,
        status: pass.status,
        startedAt: pass.startedAt,
        finishedAt: pass.finishedAt,
        queries: pass.queries.map(({ heroId, status, requestHash, responseHash }) => ({
          heroId,
          status,
          requestHash,
          responseHash,
        })),
      })),
    }] : []),
    {
      type: 'independent-comparison-summary',
      status: independentQueryResult.status,
      comparedDirectionCount: independentQueryResult.comparedDirectionCount,
      batchSingleMismatchCount: independentQueryResult.batchSingleMismatchCount,
      repeatabilityMismatchCount: independentQueryResult.repeatabilityMismatchCount,
      fix9BatchPass1MismatchCount: independentQueryResult.fix9BatchPass1MismatchCount,
      fix9BatchPass2MismatchCount: independentQueryResult.fix9BatchPass2MismatchCount,
    },
    ...failingBucketPairs.map((pair) => ({
      type: 'pair-bucket-observation',
      canonicalPairId: pair.canonicalPairId,
      bucket: pair.bucket,
      heroA: pair.heroA,
      heroB: pair.heroB,
      gamesA: pair.gamesA,
      gamesB: pair.gamesB,
      winsA: pair.winsA,
      winsB: pair.winsB,
      thresholdExceeded: pair.thresholdExceeded,
      status: pair.status,
    })),
    ...independentQueryResult.comparisons
      .filter((comparison) => comparison.batchSingleMatches === false
        || comparison.repeatabilityMatches === false)
      .map((comparison) => ({ type: 'independent-query-mismatch', ...comparison })),
  ];

  return {
    datasetSource: input.datasetSource,
    diagnosticDataStatus,
    productionPublishedWindow: [],
    attemptedWindow: input.attemptedWindow.buckets,
    diagnosticWindow: hasRealData ? buckets : [],
    validationThresholds: {
      relativeDeltaThreshold: 0.03,
      absoluteGamesDeltaThreshold: 15,
    },
    checkedDirectionCount: aggregateAnalysis.checkedDirectionCount,
    directedViolationCount: aggregateAnalysis.directedViolations,
    uniqueViolationPairCount: aggregateAnalysis.uniqueViolationPairs,
    missingReversePairCount: aggregateAnalysis.missingReversePairCount,
    duplicateDirectionCount: aggregateAnalysis.duplicateDirectionCount,
    affectedPairs: aggregateAnalysis.pairDiagnoses.filter((pair) =>
      pair.thresholdExceeded === true || pair.status !== 'COMPARED'),
    bucketBreakdown,
    pairBucketBreakdown,
    rootCause: {
      status: rootCauseStatus,
      description: rootCauseDescription,
      observedPattern,
      evidence: rootCauseEvidence,
    },
    observations: hasRealData ? aggregateAnalysis.pairDiagnoses : [],
    fixApplied: [],
    chunkConsistency: { status: chunkConsistencyStatus, comparisons: singleHeroComparisons },
    independentQueryComparisons: independentQueryResult,
    repeatability,
    productionPublishAllowed: false,
    inputSha256: input.inputSha256,
    diagnosticRunId: input.diagnosticRunId,
  };
}

export async function runReport(deps = {}) {
  const inputPath = deps.inputPath ?? CANONICAL_INPUT_PATH;
  const reportPath = deps.reportPath ?? RESEARCH_REPORT_PATH;
  const metaPath = deps.metaPath ?? META_PATH;
  const input = readInput(inputPath, deps.readFileSync);
  const evidence = readRepeatabilityEvidence(
    deps.repeatabilityEvidencePath ?? REPEATABILITY_EVIDENCE_PATH,
    input,
    deps.readFileSync,
  );
  const heroNames = loadHeroNames(deps.heroesPath ?? HEROES_PATH, deps.readFileSync);
  const report = analyzeInput(input, evidence, heroNames);
  report.productionPublishedWindow = loadProductionWindow(metaPath, deps.readFileSync);
  atomicWrite(reportPath, report, deps);
  return report;
}

export async function runCheck(deps = {}) {
  const inputPath = deps.inputPath ?? CANONICAL_INPUT_PATH;
  const reportPath = deps.reportPath ?? RESEARCH_REPORT_PATH;
  const metaPath = deps.metaPath ?? META_PATH;
  const input = readInput(inputPath, deps.readFileSync);
  const evidence = readRepeatabilityEvidence(
    deps.repeatabilityEvidencePath ?? REPEATABILITY_EVIDENCE_PATH,
    input,
    deps.readFileSync,
  );
  if (!existsSync(reportPath)) throw new Error(`Diagnostic report not found: ${reportPath}`);
  let existingReport;
  try {
    existingReport = JSON.parse((deps.readFileSync ?? readFileSync)(reportPath, 'utf8'));
  } catch (error) {
    throw new Error(`Diagnostic report is not valid JSON: ${error.message}`);
  }
  const expected = analyzeInput(input, evidence, loadHeroNames(deps.heroesPath ?? HEROES_PATH, deps.readFileSync));
  expected.productionPublishedWindow = loadProductionWindow(metaPath, deps.readFileSync);
  if (JSON.stringify(canonicalize(existingReport)) !== JSON.stringify(canonicalize(expected))) {
    throw new Error('Diagnostic report does not match canonical input or deterministic projection');
  }
  return {
    status: 'PASS',
    diagnosticDataStatus: expected.diagnosticDataStatus,
    inputSha256: input.inputSha256,
  };
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--window=')) options.window = arg.slice('--window='.length);
    else if (arg === '--window') options.window = argv[++index];
    else if (arg.startsWith('--heroes=')) {
      options.targetHeroIds = arg.slice('--heroes='.length).split(',').map(Number);
    }
    else throw new Error(`Unknown diagnostic option: ${arg}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const [command, ...rest] = argv;
  const options = parseCliArgs(rest);
  if (command === 'fetch') return runFetch(options, deps);
  if (command === 'report') return runReport(deps);
  if (command === 'check') return runCheck(deps);
  if (command === 'repeatability') {
    const config = {
      targetHeroIds: options.targetHeroIds ?? FIX10_REPEATABILITY_CONFIG.targetHeroIds,
      buckets: options.window
        ? parseHistoricalWindow(options.window).buckets
        : FIX10_REPEATABILITY_CONFIG.buckets,
    };
    return runRepeatability(config, deps);
  }
  throw new Error('Usage: node scripts/stratz-matchup-asymmetry-diagnostic.mjs <fetch|report|check|repeatability> [--window=START...END] [--heroes=ID,ID,...]');
}

if (process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[STRATZ Diagnostic] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
