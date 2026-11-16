#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  StratzTransport,
  loadToken,
  buildChunkQuery,
  aggregateStratzMatchupChunks,
  BUCKET_SEC,
  BRACKETS,
  WEEKS_COUNT,
} from './update-data-stratz.mjs';
import { diagnoseDataset } from './stratz-matchup-asymmetry-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT_CAUSE_EVIDENCE_PATH = path.join(
  ROOT,
  'research/data-quality/stratz-reverse-pair-root-cause-evidence.json',
);
export const ROOT_CAUSE_RAW_PATH = path.join(
  ROOT,
  'research/data-quality/stratz-reverse-pair-root-cause-raw-responses.json',
);

export const FIX9_INPUT_CANONICAL_SHA256 =
  '59e46634e94bb7e0e3db180c2ddbefd4dd6be422bbd026539d4ccff84e217ef1';
export const FIX10_REPEATABILITY_CANONICAL_SHA256 =
  '44d728edd96411c81213824d9d4d8ad65be39c5286ff884f5dade4175c2d028c';
export const RELATIVE_DELTA_THRESHOLD = 0.03;
export const ABSOLUTE_GAMES_DELTA_THRESHOLD = 15;

const INPUT_PATH = path.join(ROOT, 'scripts/stratz-diagnostic-input.json');
const REPEATABILITY_PATH = path.join(
  ROOT,
  'research/data-quality/stratz-reverse-pair-repeatability-evidence.json',
);
const HISTORICAL_REPORT_PATH = path.join(
  ROOT,
  'research/data-quality/stratz-reverse-pair-asymmetry-report.json',
);
const HEROES_PATH = path.join(ROOT, 'public/data/heroes.json');
const STRATZ_RESEARCH_DOC_PATH = path.join(ROOT, 'docs/stratz-research.md');
const PRODUCTION_PATHS = Object.freeze({
  heroes: path.join(ROOT, 'public/data/heroes.json'),
  matchups: path.join(ROOT, 'public/data/matchups.json'),
  meta: path.join(ROOT, 'public/data/meta.json'),
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

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function canonicalJsonSha256(value, omittedKey) {
  const copy = { ...value };
  if (omittedKey) delete copy[omittedKey];
  return sha256(JSON.stringify(canonicalize(copy)));
}

export function sha256File(filePath, read = readFileSync) {
  return sha256(read(filePath));
}

export function normalizeStratzResponse(response) {
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

export function responseSha256(response) {
  return sha256(JSON.stringify(normalizeStratzResponse(response)));
}

function parseJson(filePath, read = readFileSync) {
  return JSON.parse(read(filePath, 'utf8'));
}

function sourceFiles(deps = {}) {
  const read = deps.readFileSync ?? readFileSync;
  const inputPath = deps.inputPath ?? INPUT_PATH;
  const repeatabilityPath = deps.repeatabilityPath ?? REPEATABILITY_PATH;
  const reportPath = deps.historicalReportPath ?? HISTORICAL_REPORT_PATH;
  const heroesPath = deps.heroesPath ?? HEROES_PATH;
  const input = parseJson(inputPath, read);
  const repeatability = parseJson(repeatabilityPath, read);
  const historicalReport = parseJson(reportPath, read);
  const heroesData = parseJson(heroesPath, read);

  if (canonicalJsonSha256(input, 'inputSha256') !== FIX9_INPUT_CANONICAL_SHA256
    || input.inputSha256 !== FIX9_INPUT_CANONICAL_SHA256) {
    throw new Error('FIX9 input canonical SHA-256 does not match the protected value');
  }
  if (canonicalJsonSha256(repeatability, 'evidenceSha256') !== FIX10_REPEATABILITY_CANONICAL_SHA256
    || repeatability.evidenceSha256 !== FIX10_REPEATABILITY_CANONICAL_SHA256) {
    throw new Error('FIX10 repeatability evidence canonical SHA-256 does not match the protected value');
  }
  if (repeatability.fix9InputSha256 !== input.inputSha256
    || historicalReport.inputSha256 !== input.inputSha256) {
    throw new Error('FIX9 input hash reference differs across protected evidence');
  }
  if (historicalReport.productionPublishAllowed !== false) {
    throw new Error('Historical report does not protect production publishing');
  }
  if (input.dataStatus !== 'REAL_STRATZ'
    || input.batchResults?.chunks?.length === 0
    || !Array.isArray(input.attemptedWindow?.buckets)
    || input.attemptedWindow.buckets.length !== WEEKS_COUNT) {
    throw new Error('FIX9 input is missing real STRATZ batch data or the four-bucket window');
  }

  const heroRows = Array.isArray(heroesData) ? heroesData : heroesData.heroes ?? [];
  const heroNames = new Map(heroRows.map((hero) => [
    Number(hero.id ?? hero.hero_id),
    hero.localized_name ?? hero.name ?? hero.displayName ?? `Hero ${hero.id ?? hero.hero_id}`,
  ]));
  const fileHashes = Object.fromEntries(
    Object.entries({
      fix9Input: inputPath,
      fix10RepeatabilityEvidence: repeatabilityPath,
      fix10HistoricalReport: reportPath,
      stratzResearchDoc: STRATZ_RESEARCH_DOC_PATH,
      productionHeroes: PRODUCTION_PATHS.heroes,
      productionMatchups: PRODUCTION_PATHS.matchups,
      productionMeta: PRODUCTION_PATHS.meta,
    }).map(([name, filePath]) => [name, sha256File(filePath, read)]),
  );
  return { input, repeatability, historicalReport, heroNames, fileHashes };
}

function chunksFromInput(input) {
  return input.batchResults.chunks.map(({ chunkIndex, chunkHeroIds, response }) => ({
    chunkIndex,
    chunkHeroIds,
    response,
  }));
}

function getPairDiagnosis(diagnosis, canonicalPairId) {
  return diagnosis.pairDiagnoses.find((pair) => pair.canonicalPairId === canonicalPairId) ?? null;
}

export function diagnosisRecord(pair, bucket, heroNames = new Map()) {
  if (!pair) {
    return {
      canonicalPairId: null,
      bucket,
      status: 'MISSING_PAIR',
      thresholdExceeded: null,
      gamesA: null,
      gamesB: null,
      winsA: null,
      winsB: null,
      absoluteGamesDelta: null,
      relativeDeltaA: null,
      relativeDeltaB: null,
      directions: [],
    };
  }
  const [heroAId, heroBId] = pair.canonicalPairId.split(':').map(Number);
  if (pair.status !== 'COMPARED') {
    return {
      canonicalPairId: pair.canonicalPairId,
      bucket,
      heroAId,
      heroBId,
      heroA: heroNames.get(heroAId) ?? `Hero ${heroAId}`,
      heroB: heroNames.get(heroBId) ?? `Hero ${heroBId}`,
      status: pair.status,
      thresholdExceeded: null,
      gamesA: pair.gamesA ?? null,
      gamesB: pair.gamesB ?? null,
      winsA: pair.winsA ?? null,
      winsB: pair.winsB ?? null,
      absoluteGamesDelta: null,
      relativeDeltaA: null,
      relativeDeltaB: null,
      directions: [],
    };
  }
  return {
    canonicalPairId: pair.canonicalPairId,
    bucket,
    heroAId,
    heroBId,
    heroA: heroNames.get(heroAId) ?? `Hero ${heroAId}`,
    heroB: heroNames.get(heroBId) ?? `Hero ${heroBId}`,
    gamesA: pair.gamesA,
    gamesB: pair.gamesB,
    winsA: pair.winsA,
    winsB: pair.winsB,
    absoluteGamesDelta: pair.absoluteGamesDelta,
    relativeDeltaA: pair.relativeDeltaA,
    relativeDeltaB: pair.relativeDeltaB,
    thresholdExceeded: pair.thresholdExceeded,
    status: pair.validationStatus,
    directions: pair.directionDiagnoses.map((direction) => ({
      heroIdA: direction.heroIdA,
      heroIdB: direction.heroIdB,
      gamesA: direction.gamesA,
      gamesB: direction.gamesB,
      winsA: direction.winsA,
      winsB: direction.winsB,
      absoluteGamesDelta: direction.absoluteGamesDelta,
      relativeDeltaA: direction.relativeDeltaA,
      relativeDeltaB: direction.relativeDeltaB,
      thresholdExceeded: direction.thresholdExceeded,
      status: direction.validationStatus,
    })),
  };
}

export function isComparableViolation(pair) {
  return pair?.status === 'COMPARED' && pair.thresholdExceeded === true;
}

function buildHeroConcentration(anomalies, heroNames) {
  const byHero = new Map();
  for (const anomaly of anomalies) {
    for (const heroId of [anomaly.heroAId, anomaly.heroBId]) {
      if (!byHero.has(heroId)) {
        byHero.set(heroId, {
          heroId,
          pairWeekViolationCount: 0,
          partners: new Set(),
          bucketDistribution: {},
          heroAOccurrences: 0,
          heroBOccurrences: 0,
          gamesAGreaterCount: 0,
          gamesBGreaterCount: 0,
          gamesEqualCount: 0,
          absoluteDeltas: [],
          relativeDeltasA: [],
          relativeDeltasB: [],
        });
      }
      const item = byHero.get(heroId);
      item.pairWeekViolationCount += 1;
      item.partners.add(heroId === anomaly.heroAId ? anomaly.heroBId : anomaly.heroAId);
      item.bucketDistribution[anomaly.bucket] = (item.bucketDistribution[anomaly.bucket] ?? 0) + 1;
      item.heroAOccurrences += heroId === anomaly.heroAId ? 1 : 0;
      item.heroBOccurrences += heroId === anomaly.heroBId ? 1 : 0;
      item.gamesAGreaterCount += anomaly.gamesA > anomaly.gamesB ? 1 : 0;
      item.gamesBGreaterCount += anomaly.gamesB > anomaly.gamesA ? 1 : 0;
      item.gamesEqualCount += anomaly.gamesA === anomaly.gamesB ? 1 : 0;
      item.absoluteDeltas.push(anomaly.absoluteGamesDelta);
      item.relativeDeltasA.push(anomaly.relativeDeltaA);
      item.relativeDeltasB.push(anomaly.relativeDeltaB);
    }
  }
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return [...byHero.values()].map((item) => ({
    heroId: item.heroId,
    heroName: heroNames.get(item.heroId) ?? `Hero ${item.heroId}`,
    pairWeekViolationCount: item.pairWeekViolationCount,
    uniquePartnerCount: item.partners.size,
    uniquePartnerIds: [...item.partners].sort((a, b) => a - b),
    bucketDistribution: Object.fromEntries(
      Object.entries(item.bucketDistribution).sort(([a], [b]) => Number(a) - Number(b)),
    ),
    canonicalPairPositionCount: {
      heroA: item.heroAOccurrences,
      heroB: item.heroBOccurrences,
    },
    gamesAGreaterCount: item.gamesAGreaterCount,
    gamesBGreaterCount: item.gamesBGreaterCount,
    gamesEqualCount: item.gamesEqualCount,
    meanAbsoluteGamesDelta: mean(item.absoluteDeltas),
    maxAbsoluteGamesDelta: Math.max(...item.absoluteDeltas),
    meanRelativeDeltaA: mean(item.relativeDeltasA),
    maxRelativeDeltaA: Math.max(...item.relativeDeltasA),
    meanRelativeDeltaB: mean(item.relativeDeltasB),
    maxRelativeDeltaB: Math.max(...item.relativeDeltasB),
  })).sort((a, b) =>
    b.pairWeekViolationCount - a.pairWeekViolationCount || a.heroId - b.heroId);
}

function buildAggregateAttribution(pairIds, bucketDiagnoses, aggregateDiagnosis) {
  return pairIds.map((canonicalPairId) => {
    const aggregate = getPairDiagnosis(aggregateDiagnosis, canonicalPairId);
    const byBucket = bucketDiagnoses.map(({ bucket, diagnosis }) => {
      const pair = getPairDiagnosis(diagnosis, canonicalPairId);
      if (!pair || pair.status !== 'COMPARED') {
        return {
          bucket,
          status: pair?.status ?? 'MISSING_PAIR',
          gamesA: pair?.gamesA ?? null,
          gamesB: pair?.gamesB ?? null,
          winsA: pair?.winsA ?? null,
          winsB: pair?.winsB ?? null,
          signedGamesDeltaAminusB: null,
          relativeDeltaA: null,
          relativeDeltaB: null,
          thresholdExceeded: null,
          changeInSignedDeltaFromPreviousBucket: null,
          contributionToAggregateSignedDelta: null,
        };
      }
      return {
        bucket,
        status: pair.validationStatus,
        gamesA: pair.gamesA,
        gamesB: pair.gamesB,
        winsA: pair.winsA,
        winsB: pair.winsB,
        signedGamesDeltaAminusB: pair.gamesA - pair.gamesB,
        relativeDeltaA: pair.relativeDeltaA,
        relativeDeltaB: pair.relativeDeltaB,
        thresholdExceeded: pair.thresholdExceeded,
        changeInSignedDeltaFromPreviousBucket: null,
        contributionToAggregateSignedDelta: null,
      };
    });
    for (let index = 0; index < byBucket.length; index += 1) {
      const current = byBucket[index];
      const previous = byBucket[index - 1];
      if (previous?.signedGamesDeltaAminusB != null && current.signedGamesDeltaAminusB != null) {
        current.changeInSignedDeltaFromPreviousBucket =
          current.signedGamesDeltaAminusB - previous.signedGamesDeltaAminusB;
      }
    }
    const aggregateDelta = aggregate?.status === 'COMPARED'
      ? aggregate.gamesA - aggregate.gamesB
      : null;
    for (const bucket of byBucket) {
      if (aggregateDelta && bucket.signedGamesDeltaAminusB != null) {
        bucket.contributionToAggregateSignedDelta = bucket.signedGamesDeltaAminusB / aggregateDelta;
      }
    }
    const validBuckets = byBucket.filter((bucket) => bucket.signedGamesDeltaAminusB != null);
    const signedDeltas = validBuckets.map((bucket) => bucket.signedGamesDeltaAminusB);
    const signs = new Set(signedDeltas.filter((delta) => delta !== 0).map(Math.sign));
    const sumGamesA = validBuckets.reduce((sum, bucket) => sum + bucket.gamesA, 0);
    const sumGamesB = validBuckets.reduce((sum, bucket) => sum + bucket.gamesB, 0);
    return {
      canonicalPairId,
      aggregate: aggregate?.status === 'COMPARED'
        ? {
          status: aggregate.validationStatus,
          gamesA: aggregate.gamesA,
          gamesB: aggregate.gamesB,
          winsA: aggregate.winsA,
          winsB: aggregate.winsB,
          absoluteGamesDelta: aggregate.absoluteGamesDelta,
          signedGamesDeltaAminusB: aggregateDelta,
          relativeDeltaA: aggregate.relativeDeltaA,
          relativeDeltaB: aggregate.relativeDeltaB,
          thresholdExceeded: aggregate.thresholdExceeded,
          bucketGameSumsMatch: sumGamesA === aggregate.gamesA && sumGamesB === aggregate.gamesB,
        }
        : {
          status: aggregate?.status ?? 'MISSING_PAIR',
          gamesA: null,
          gamesB: null,
          winsA: null,
          winsB: null,
          absoluteGamesDelta: null,
          signedGamesDeltaAminusB: null,
          relativeDeltaA: null,
          relativeDeltaB: null,
          thresholdExceeded: null,
          bucketGameSumsMatch: null,
        },
      bucketDirectionPattern: signs.size === 0 ? 'NO_DELTA'
        : signs.size === 1 ? 'SAME_SIGN' : 'SIGN_CHANGES',
      perBucket: byBucket,
    };
  });
}

function rawPairOrientation(input, anomalies) {
  const chunks = chunksFromInput(input);
  const rows = [];
  for (const anomaly of anomalies) {
    for (const requestedHeroId of [anomaly.heroAId, anomaly.heroBId]) {
      const chunk = chunks.find((entry) => entry.chunkHeroIds.includes(requestedHeroId));
      const dryad = chunk?.response?.data?.heroStats?.[`w${anomaly.bucket}`]
        ?.find((entry) => entry.heroId === requestedHeroId);
      const matches = dryad?.vs?.filter((row) =>
        (row.heroId1 === anomaly.heroAId && row.heroId2 === anomaly.heroBId)
        || (row.heroId1 === anomaly.heroBId && row.heroId2 === anomaly.heroAId)) ?? [];
      for (const row of matches) {
        rows.push({
          canonicalPairId: anomaly.canonicalPairId,
          bucket: anomaly.bucket,
          requestedHeroId,
          heroId1: row.heroId1,
          heroId2: row.heroId2,
          requestedHeroIsHeroId1: row.heroId1 === requestedHeroId,
          matchCount: row.matchCount,
          winCount: row.winCount,
          winsForRequestedHero: row.heroId1 === requestedHeroId
            ? row.winCount : row.matchCount - row.winCount,
        });
      }
    }
  }
  return rows.sort((a, b) =>
    a.bucket - b.bucket
    || a.canonicalPairId.localeCompare(b.canonicalPairId)
    || a.requestedHeroId - b.requestedHeroId
    || a.heroId1 - b.heroId1
    || a.heroId2 - b.heroId2);
}

export function analyzeFix9Raw(input, { heroNames = new Map() } = {}) {
  const chunks = chunksFromInput(input);
  const buckets = input.attemptedWindow.buckets;
  const validHeroIds = new Set(input.heroMetadata.heroIds);
  const bucketDiagnoses = buckets.map((bucket) => {
    const dataset = aggregateStratzMatchupChunks(chunks, { buckets: [bucket] }, validHeroIds);
    return { bucket, dataset, diagnosis: diagnoseDataset(dataset) };
  });
  const aggregateDataset = aggregateStratzMatchupChunks(chunks, { buckets }, validHeroIds);
  const aggregateDiagnosis = diagnoseDataset(aggregateDataset);
  const anomalyInventory = bucketDiagnoses.flatMap(({ bucket, diagnosis }) =>
    diagnosis.pairDiagnoses
      .filter(isComparableViolation)
      .map((pair) => diagnosisRecord(pair, bucket, heroNames)))
    .sort((a, b) => a.bucket - b.bucket
      || a.heroAId - b.heroAId
      || a.heroBId - b.heroBId);
  const directedViolationRecords = anomalyInventory.flatMap((pair) =>
    pair.directions
      .filter((direction) => direction.thresholdExceeded)
      .map((direction) => ({
        canonicalPairId: pair.canonicalPairId,
        bucket: pair.bucket,
        heroId1: direction.heroIdA,
        heroId2: direction.heroIdB,
        gamesA: direction.gamesA,
        gamesB: direction.gamesB,
        winsA: direction.winsA,
        winsB: direction.winsB,
        absoluteGamesDelta: direction.absoluteGamesDelta,
        relativeDeltaA: direction.relativeDeltaA,
        relativeDeltaB: direction.relativeDeltaB,
        thresholdExceeded: direction.thresholdExceeded,
        status: direction.status,
      })));
  const pairIds = [...new Set(anomalyInventory.map((row) => row.canonicalPairId))]
    .sort((a, b) => {
      const [a1, a2] = a.split(':').map(Number);
      const [b1, b2] = b.split(':').map(Number);
      return a1 - b1 || a2 - b2;
    });
  const bucketSummary = bucketDiagnoses.map(({ bucket, diagnosis }) => ({
    bucket,
    checkedDirectionCount: diagnosis.checkedDirectionCount,
    directedViolationCount: diagnosis.directedViolations,
    pairWeekViolationCount: diagnosis.pairDiagnoses.filter((pair) =>
      pair.status === 'COMPARED' && pair.thresholdExceeded === true).length,
    uniqueViolationPairCount: diagnosis.uniqueViolationPairs,
    missingReversePairCount: diagnosis.missingReversePairCount,
    duplicateDirectionCount: diagnosis.duplicateDirectionCount,
  }));
  const aggregateAttribution = buildAggregateAttribution(
    pairIds,
    bucketDiagnoses,
    aggregateDiagnosis,
  );
  const aggregateViolationPairs = aggregateDiagnosis.pairDiagnoses
    .filter((pair) => pair.status === 'COMPARED' && pair.thresholdExceeded === true);
  const orientationRows = rawPairOrientation(input, anomalyInventory);
  const orientationAnalysis = {
    gamesAGreaterThanGamesB: anomalyInventory.filter((pair) => pair.gamesA > pair.gamesB).length,
    gamesBGreaterThanGamesA: anomalyInventory.filter((pair) => pair.gamesB > pair.gamesA).length,
    gamesEqual: anomalyInventory.filter((pair) => pair.gamesA === pair.gamesB).length,
    canonicalHeroALowerIdCount: anomalyInventory.length,
    rawRowsForAnomalyDirections: orientationRows.length,
    rawRequestedHeroIsHeroId1Count: orientationRows.filter((row) => row.requestedHeroIsHeroId1).length,
    rawRequestedHeroIsHeroId2Count: orientationRows.filter((row) => !row.requestedHeroIsHeroId1).length,
    rawRows: orientationRows,
  };
  const pairWeekThresholdedAggregatePassCount = anomalyInventory.filter((pair) =>
    !aggregateViolationPairs.some((aggregate) => aggregate.canonicalPairId === pair.canonicalPairId)).length;
  return {
    thresholds: {
      relativeDeltaGreaterThan: RELATIVE_DELTA_THRESHOLD,
      absoluteGamesDeltaGreaterThan: ABSOLUTE_GAMES_DELTA_THRESHOLD,
      relation: 'AND',
    },
    aggregateWindow: {
      buckets,
      checkedDirectionCount: aggregateDiagnosis.checkedDirectionCount,
      directedViolationCount: aggregateDiagnosis.directedViolations,
      uniqueViolationPairCount: aggregateDiagnosis.uniqueViolationPairs,
      missingReversePairCount: aggregateDiagnosis.missingReversePairCount,
      duplicateDirectionCount: aggregateDiagnosis.duplicateDirectionCount,
      violations: aggregateViolationPairs.map((pair) => ({
        canonicalPairId: pair.canonicalPairId,
        heroAId: pair.heroIdA,
        heroBId: pair.heroIdB,
        gamesA: pair.gamesA,
        gamesB: pair.gamesB,
        winsA: pair.winsA,
        winsB: pair.winsB,
        absoluteGamesDelta: pair.absoluteGamesDelta,
        relativeDeltaA: pair.relativeDeltaA,
        relativeDeltaB: pair.relativeDeltaB,
        thresholdExceeded: pair.thresholdExceeded,
        status: pair.validationStatus,
      })),
    },
    perBucket: {
      summary: bucketSummary,
      directedViolationCount: directedViolationRecords.length,
      pairWeekViolationCount: anomalyInventory.length,
      uniquePairCount: pairIds.length,
      anomalyInventory,
      directedViolationRecords,
      candidatePairBucketObservations: pairIds.flatMap((canonicalPairId) =>
        bucketDiagnoses.map(({ bucket, diagnosis }) =>
          diagnosisRecord(getPairDiagnosis(diagnosis, canonicalPairId), bucket, heroNames))),
    },
    heroConcentration: buildHeroConcentration(anomalyInventory, heroNames),
    aggregateAttribution: {
      pairs: aggregateAttribution,
      pairWeekFailuresWhosePairPassesAggregate: pairWeekThresholdedAggregatePassCount,
      aggregatePassingUniquePairCount: pairIds.length - aggregateViolationPairs.length,
      aggregateGameSumsMatchAllBuckets: aggregateAttribution.every((pair) =>
        pair.aggregate.bucketGameSumsMatch === true),
      aggregatePassingMechanisms: {
        totalPairs: aggregateAttribution.filter((pair) =>
          pair.aggregate.status === 'PASS').length,
        passingBecauseAbsoluteDeltaAtMostThreshold: aggregateAttribution.filter((pair) =>
          pair.aggregate.status === 'PASS'
          && pair.aggregate.absoluteGamesDelta <= ABSOLUTE_GAMES_DELTA_THRESHOLD).length,
        passingBecauseRelativeDeltaAtMostThreshold: aggregateAttribution.filter((pair) =>
          pair.aggregate.status === 'PASS'
          && pair.aggregate.absoluteGamesDelta > ABSOLUTE_GAMES_DELTA_THRESHOLD
          && pair.aggregate.relativeDeltaA <= RELATIVE_DELTA_THRESHOLD
          && pair.aggregate.relativeDeltaB <= RELATIVE_DELTA_THRESHOLD).length,
        passingBecauseEitherDirectionalRelativeDeltaAtMostThreshold: aggregateAttribution.filter((pair) =>
          pair.aggregate.status === 'PASS'
          && pair.aggregate.absoluteGamesDelta > ABSOLUTE_GAMES_DELTA_THRESHOLD
          && (pair.aggregate.relativeDeltaA <= RELATIVE_DELTA_THRESHOLD
            || pair.aggregate.relativeDeltaB <= RELATIVE_DELTA_THRESHOLD)).length,
      },
      signedDirectionPatternCounts: {
        sameSignAcrossBuckets: aggregateAttribution.filter((pair) =>
          pair.bucketDirectionPattern === 'SAME_SIGN').length,
        signChangesAcrossBuckets: aggregateAttribution.filter((pair) =>
          pair.bucketDirectionPattern === 'SIGN_CHANGES').length,
        noDelta: aggregateAttribution.filter((pair) =>
          pair.bucketDirectionPattern === 'NO_DELTA').length,
      },
    },
    orientationAnalysis,
    uniquePairIds: pairIds,
  };
}

function currentBatchPairAnalysis(input, analysis, rawArtifact) {
  const control = rawArtifact.matchedBatchControl;
  const chunks = chunksFromInput(input).map(({ chunkIndex, chunkHeroIds }) => ({
    chunkIndex,
    chunkHeroIds,
    response: control?.queryResponses?.[`matched-fix9-chunk-${chunkIndex}`]?.response,
  }));
  const records = control?.records ?? [];
  if (chunks.some((chunk) => !chunk.response)
    || records.length !== input.batchResults.chunks.length
    || records.some((record) => record.status !== 'VERIFIED')) {
    return { status: 'INCOMPLETE', perBucket: [], aggregate: null, baselineAggregateViolations: [] };
  }
  const validHeroIds = new Set(input.heroMetadata.heroIds);
  const buckets = input.attemptedWindow.buckets;
  const perBucketDiagnoses = buckets.map((bucket) => ({
    bucket,
    diagnosis: diagnoseDataset(aggregateStratzMatchupChunks(
      chunks,
      { buckets: [bucket] },
      validHeroIds,
    )),
  }));
  const aggregateDiagnosis = diagnoseDataset(aggregateStratzMatchupChunks(
    chunks,
    { buckets },
    validHeroIds,
  ));
  const baselinePairWeekKeys = new Set(analysis.perBucket.anomalyInventory.map((pair) =>
    `${pair.canonicalPairId}|${pair.bucket}`));
  const currentPairWeekViolations = perBucketDiagnoses.flatMap(({ bucket, diagnosis }) =>
    diagnosis.pairDiagnoses
      .filter((pair) => pair.status === 'COMPARED' && pair.thresholdExceeded === true)
      .map((pair) => diagnosisRecord(pair, bucket)));
  const currentPairWeekKeys = new Set(currentPairWeekViolations.map((pair) =>
    `${pair.canonicalPairId}|${pair.bucket}`));
  const baselinePairWeekKeysMissingCurrent = [...baselinePairWeekKeys]
    .filter((key) => !currentPairWeekKeys.has(key))
    .sort();
  const newCurrentPairWeekKeys = [...currentPairWeekKeys]
    .filter((key) => !baselinePairWeekKeys.has(key))
    .sort();
  const baselineAggregateViolations = analysis.aggregateAttribution.pairs
    .filter((pair) => pair.aggregate.thresholdExceeded === true);
  const findPair = (diagnosis, canonicalPairId) => diagnosis.pairDiagnoses.find((pair) =>
    pair.canonicalPairId === canonicalPairId);
  const describePair = (pair) => pair ? {
    status: pair.validationStatus ?? pair.status,
    gamesA: pair.gamesA ?? null,
    gamesB: pair.gamesB ?? null,
    winsA: pair.winsA ?? null,
    winsB: pair.winsB ?? null,
    absoluteGamesDelta: pair.absoluteGamesDelta ?? null,
    relativeDeltaA: pair.relativeDeltaA ?? null,
    relativeDeltaB: pair.relativeDeltaB ?? null,
    thresholdExceeded: pair.thresholdExceeded ?? null,
    directions: (pair.directionDiagnoses ?? []).map((direction) => ({
      heroIdA: direction.heroIdA,
      heroIdB: direction.heroIdB,
      gamesA: direction.gamesA,
      winsA: direction.winsA,
      gamesB: direction.gamesB,
      winsB: direction.winsB,
      thresholdExceeded: direction.thresholdExceeded,
      validationStatus: direction.validationStatus,
    })),
  } : {
    status: 'MISSING_PAIR',
    gamesA: null,
    gamesB: null,
    winsA: null,
    winsB: null,
    absoluteGamesDelta: null,
    relativeDeltaA: null,
    relativeDeltaB: null,
    thresholdExceeded: null,
    directions: [],
  };
  return {
    status: 'VERIFIED',
    perBucket: perBucketDiagnoses.map(({ bucket, diagnosis }) => ({
      bucket,
      directedViolationCount: diagnosis.directedViolations,
      pairWeekViolationCount: diagnosis.pairDiagnoses.filter((pair) =>
        pair.status === 'COMPARED' && pair.thresholdExceeded === true).length,
      uniqueViolationPairCount: diagnosis.uniqueViolationPairs,
    })),
    aggregate: {
      directedViolationCount: aggregateDiagnosis.directedViolations,
      uniqueViolationPairCount: aggregateDiagnosis.uniqueViolationPairs,
      violations: aggregateDiagnosis.pairDiagnoses
        .filter((pair) => pair.status === 'COMPARED' && pair.thresholdExceeded === true)
        .map((pair) => pair.canonicalPairId)
        .sort(),
    },
    perBucketViolations: currentPairWeekViolations,
    pairWeekComparisonToFix9: {
      fix9ViolationCount: baselinePairWeekKeys.size,
      currentViolationCount: currentPairWeekKeys.size,
      identicalViolatingPairWeeks: baselinePairWeekKeysMissingCurrent.length === 0
        && newCurrentPairWeekKeys.length === 0,
      missingFromCurrent: baselinePairWeekKeysMissingCurrent,
      newInCurrent: newCurrentPairWeekKeys,
    },
    baselineAggregateViolations: baselineAggregateViolations.map((baseline) => ({
      canonicalPairId: baseline.canonicalPairId,
      baselineAggregate: baseline.aggregate,
      currentAggregate: describePair(findPair(aggregateDiagnosis, baseline.canonicalPairId)),
      baselinePerBucket: baseline.perBucket,
      currentPerBucket: perBucketDiagnoses.map(({ bucket, diagnosis }) => ({
        bucket,
        ...describePair(findPair(diagnosis, baseline.canonicalPairId)),
      })),
    })),
  };
}

export function createCompositionPlan(anomalyInventory, buckets) {
  const pairMap = new Map();
  for (const anomaly of anomalyInventory) {
    if (!pairMap.has(anomaly.canonicalPairId)) {
      pairMap.set(anomaly.canonicalPairId, {
        canonicalPairId: anomaly.canonicalPairId,
        heroAId: anomaly.heroAId,
        heroBId: anomaly.heroBId,
      });
    }
  }
  const pairs = [...pairMap.values()].sort((a, b) =>
    a.heroAId - b.heroAId || a.heroBId - b.heroBId);
  const requests = [];
  for (const pair of pairs) {
    requests.push({
      requestId: `pair-${pair.heroAId}-${pair.heroBId}-order-${pair.heroAId}-${pair.heroBId}`,
      kind: 'pair-order',
      pairId: pair.canonicalPairId,
      requestedHeroIds: [pair.heroAId, pair.heroBId],
    });
    requests.push({
      requestId: `pair-${pair.heroAId}-${pair.heroBId}-order-${pair.heroBId}-${pair.heroAId}`,
      kind: 'pair-order',
      pairId: pair.canonicalPairId,
      requestedHeroIds: [pair.heroBId, pair.heroAId],
    });
  }
  const heroIds = [...new Set(pairs.flatMap((pair) => [pair.heroAId, pair.heroBId]))]
    .sort((a, b) => a - b);
  for (const heroId of heroIds) {
    requests.push({
      requestId: `single-${heroId}`,
      kind: 'single-hero',
      requestedHeroIds: [heroId],
    });
  }
  return { pairs, uniqueHeroIds: heroIds, requests, buckets: [...buckets] };
}

function readResponseRows(response, buckets, requestedHeroIds) {
  const rows = [];
  const observedHeroIdsByBucket = {};
  const missingBuckets = [];
  for (const bucket of buckets) {
    const dryads = response?.data?.heroStats?.[`w${bucket}`];
    if (!Array.isArray(dryads)) {
      missingBuckets.push(bucket);
      observedHeroIdsByBucket[bucket] = [];
      continue;
    }
    observedHeroIdsByBucket[bucket] = dryads.map((dryad) => dryad.heroId)
      .filter((heroId) => requestedHeroIds.includes(heroId))
      .sort((a, b) => a - b);
    for (const dryad of dryads) {
      if (!requestedHeroIds.includes(dryad.heroId)) continue;
      for (const row of dryad.vs ?? []) {
        rows.push({
          requestedHeroId: dryad.heroId,
          bucket,
          heroId1: row.heroId1,
          heroId2: row.heroId2,
          matchCount: row.matchCount,
          winCount: row.winCount,
        });
      }
    }
  }
  return {
    rows: rows.sort(compareRowValues),
    observedHeroIdsByBucket,
    missingBuckets,
  };
}

function compareRowValues(a, b) {
  return a.requestedHeroId - b.requestedHeroId
    || a.bucket - b.bucket
    || a.heroId1 - b.heroId1
    || a.heroId2 - b.heroId2
    || a.matchCount - b.matchCount
    || a.winCount - b.winCount;
}

function rowKey(row) {
  return `${row.requestedHeroId}|${row.bucket}|${row.heroId1}|${row.heroId2}`;
}

export function compareMatchupRows(leftRows, rightRows, requestedHeroIds) {
  const heroFilter = new Set(requestedHeroIds);
  const index = (rows) => {
    const result = new Map();
    for (const row of rows.filter((item) => heroFilter.has(item.requestedHeroId))) {
      const key = rowKey(row);
      if (!result.has(key)) result.set(key, []);
      result.get(key).push({ matchCount: row.matchCount, winCount: row.winCount });
    }
    for (const values of result.values()) {
      values.sort((a, b) => a.matchCount - b.matchCount || a.winCount - b.winCount);
    }
    return result;
  };
  const left = index(leftRows);
  const right = index(rightRows);
  const mismatches = [];
  let matchingRowCount = 0;
  for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const leftGroup = left.get(key) ?? [];
    const rightGroup = right.get(key) ?? [];
    for (let occurrence = 0; occurrence < Math.max(leftGroup.length, rightGroup.length); occurrence += 1) {
      const leftRow = leftGroup[occurrence] ?? null;
      const rightRow = rightGroup[occurrence] ?? null;
      if (leftRow && rightRow
        && leftRow.matchCount === rightRow.matchCount
        && leftRow.winCount === rightRow.winCount) {
        matchingRowCount += 1;
      } else {
        const [requestedHeroId, bucket, heroId1, heroId2] = key.split('|').map(Number);
        mismatches.push({
          requestedHeroId,
          bucket,
          heroId1,
          heroId2,
          occurrence,
          left: leftRow,
          right: rightRow,
        });
      }
    }
  }
  return {
    matchingRowCount,
    mismatchingRowCount: mismatches.length,
    mismatches,
  };
}

function batchRows(input, heroId, buckets) {
  const chunks = chunksFromInput(input);
  const rows = [];
  const missingBuckets = [];
  for (const bucket of buckets) {
    const chunk = chunks.find((item) => item.chunkHeroIds.includes(heroId));
    const dryad = chunk?.response?.data?.heroStats?.[`w${bucket}`]
      ?.find((item) => item.heroId === heroId);
    if (!dryad) {
      missingBuckets.push(bucket);
      continue;
    }
    rows.push(...readResponseRows({
      data: { heroStats: { [`w${bucket}`]: [dryad] } },
    }, [bucket], [heroId]).rows);
  }
  return { rows: rows.sort(compareRowValues), missingBuckets };
}

function repeatabilityRows(evidence, passIndex, heroId, buckets) {
  const pass = evidence.passes?.[passIndex];
  const query = pass?.queries?.find((item) => item.heroId === heroId && item.status === 'VERIFIED');
  if (!query?.response) return { rows: [], missingBuckets: [...buckets] };
  const extracted = readResponseRows(query.response, buckets, [heroId]);
  return {
    rows: extracted.rows,
    missingBuckets: [
      ...extracted.missingBuckets,
      ...buckets.filter((bucket) =>
        !extracted.observedHeroIdsByBucket[bucket]?.includes(heroId)),
    ].sort((a, b) => a - b),
  };
}

function summarizeComparison(comparison) {
  return {
    status: comparison.mismatchingRowCount === 0 ? 'PASS' : 'FAIL',
    matchingRowCount: comparison.matchingRowCount,
    mismatchingRowCount: comparison.mismatchingRowCount,
    mismatches: comparison.mismatches,
  };
}

export function composeComparisons(
  plan,
  requestRecords,
  responseById,
  input,
  repeatability,
  buckets,
  matchedBatchControl = null,
) {
  const byId = new Map(requestRecords.map((record) => [record.requestId, record]));
  const resultsById = new Map();
  for (const request of plan.requests) {
    const response = responseById.get(request.requestId);
    resultsById.set(request.requestId, response
      ? readResponseRows(response, buckets, request.requestedHeroIds)
      : { rows: [], observedHeroIdsByBucket: {}, missingBuckets: [...buckets] });
  }
  const orderComparisons = [];
  const batchComparisons = [];
  const singleComparisons = [];
  const singleHeroBatchComparisons = [];
  const singleHeroMatchedBatchComparisons = [];
  const matchedBatchHistoricalComparisons = [];
  const repeatabilityComparisons = [];
  for (const pair of plan.pairs) {
    const forwardId = `pair-${pair.heroAId}-${pair.heroBId}-order-${pair.heroAId}-${pair.heroBId}`;
    const reverseId = `pair-${pair.heroAId}-${pair.heroBId}-order-${pair.heroBId}-${pair.heroAId}`;
    const forwardRows = resultsById.get(forwardId);
    const reverseRows = resultsById.get(reverseId);
    orderComparisons.push({
      canonicalPairId: pair.canonicalPairId,
      requestIds: [forwardId, reverseId],
      comparison: summarizeComparison(compareMatchupRows(
        forwardRows.rows,
        reverseRows.rows,
        [pair.heroAId, pair.heroBId],
      )),
      coverage: {
        forward: forwardRows.observedHeroIdsByBucket,
        reverse: reverseRows.observedHeroIdsByBucket,
      },
    });
    for (const requestId of [forwardId, reverseId]) {
      for (const heroId of [pair.heroAId, pair.heroBId]) {
        const pairRows = resultsById.get(requestId);
        const singleId = `single-${heroId}`;
        const singleRows = resultsById.get(singleId);
        const singleRecord = byId.get(singleId);
        const pairRecord = byId.get(requestId);
        const pairHeroRows = pairRows.rows.filter((row) => row.requestedHeroId === heroId);
        const oneHeroRows = singleRows.rows.filter((row) => row.requestedHeroId === heroId);
        singleComparisons.push({
          canonicalPairId: pair.canonicalPairId,
          requestedHeroId: heroId,
          requestId,
          singleHeroRequestId: singleId,
          status: pairRecord?.status === 'VERIFIED' && singleRecord?.status === 'VERIFIED'
            ? 'COMPARED' : 'INCOMPLETE',
          comparison: summarizeComparison(compareMatchupRows(pairHeroRows, oneHeroRows, [heroId])),
          pairOnlyCoverage: pairRows.observedHeroIdsByBucket,
          singleHeroCoverage: singleRows.observedHeroIdsByBucket,
        });
        const batched = batchRows(input, heroId, buckets);
        batchComparisons.push({
          canonicalPairId: pair.canonicalPairId,
          requestedHeroId: heroId,
          requestId,
          missingBatchBuckets: batched.missingBuckets,
          comparison: summarizeComparison(compareMatchupRows(pairHeroRows, batched.rows, [heroId])),
        });
        if (repeatability.diagnosticConfig?.targetHeroIds?.includes(heroId)) {
          for (const passIndex of [0, 1]) {
            const repeated = repeatabilityRows(repeatability, passIndex, heroId, buckets);
            repeatabilityComparisons.push({
              canonicalPairId: pair.canonicalPairId,
              requestedHeroId: heroId,
              passNumber: passIndex + 1,
              requestId,
              missingRepeatabilityBuckets: repeated.missingBuckets,
              comparison: summarizeComparison(compareMatchupRows(pairHeroRows, repeated.rows, [heroId])),
            });
          }
        }
      }
    }
  }
  for (const heroId of plan.uniqueHeroIds) {
    const requestId = `single-${heroId}`;
    const singleRows = resultsById.get(requestId);
    const requestRecord = byId.get(requestId);
    const batched = batchRows(input, heroId, buckets);
    singleHeroBatchComparisons.push({
      requestedHeroId: heroId,
      requestId,
      status: requestRecord?.status === 'VERIFIED'
        && singleRows.missingBuckets.length === 0
        && batched.missingBuckets.length === 0
        ? 'COMPARED' : 'INCOMPLETE',
      missingSingleBuckets: singleRows.missingBuckets,
      missingBatchBuckets: batched.missingBuckets,
      comparison: summarizeComparison(compareMatchupRows(singleRows.rows, batched.rows, [heroId])),
    });
    const sourceChunk = input.batchResults.chunks.find((chunk) =>
      chunk.chunkHeroIds.includes(heroId));
    const matchedBatchRequestId = sourceChunk
      ? `matched-fix9-chunk-${sourceChunk.chunkIndex}` : null;
    const matchedBatchRecord = matchedBatchControl?.records?.find((record) =>
      record.requestId === matchedBatchRequestId);
    const matchedResponse = matchedBatchControl?.responses?.get(matchedBatchRequestId);
    const matchedRows = matchedResponse
      ? readResponseRows(matchedResponse, buckets, [heroId])
      : { rows: [], missingBuckets: [...buckets] };
    const matchedStatus = matchedBatchRecord?.status === 'VERIFIED'
      && matchedRows.missingBuckets.length === 0;
    singleHeroMatchedBatchComparisons.push({
      requestedHeroId: heroId,
      singleHeroRequestId: requestId,
      matchedBatchRequestId,
      status: matchedStatus && requestRecord?.status === 'VERIFIED'
        ? 'COMPARED' : 'INCOMPLETE',
      missingMatchedBatchBuckets: matchedRows.missingBuckets,
      comparison: summarizeComparison(compareMatchupRows(singleRows.rows, matchedRows.rows, [heroId])),
    });
    matchedBatchHistoricalComparisons.push({
      requestedHeroId: heroId,
      matchedBatchRequestId,
      status: matchedStatus ? 'COMPARED' : 'INCOMPLETE',
      missingMatchedBatchBuckets: matchedRows.missingBuckets,
      missingFix9BatchBuckets: batched.missingBuckets,
      comparison: summarizeComparison(compareMatchupRows(matchedRows.rows, batched.rows, [heroId])),
    });
  }
  const uniqueMismatchRecords = (comparisons) => {
    const records = new Map();
    for (const item of comparisons) {
      for (const mismatch of item.comparison.mismatches) {
        const key = JSON.stringify([
          mismatch.requestedHeroId,
          mismatch.bucket,
          mismatch.heroId1,
          mismatch.heroId2,
          mismatch.left,
          mismatch.right,
        ]);
        if (!records.has(key)) records.set(key, mismatch);
      }
    }
    return [...records.values()].sort((a, b) =>
      a.bucket - b.bucket
      || a.requestedHeroId - b.requestedHeroId
      || a.heroId1 - b.heroId1
      || a.heroId2 - b.heroId2);
  };
  const pairOnlyBatchUniqueMismatches = uniqueMismatchRecords(batchComparisons);
  const singleHeroBatchUniqueMismatches = uniqueMismatchRecords(singleHeroBatchComparisons);
  const matchedBatchUniqueMismatches = uniqueMismatchRecords(matchedBatchHistoricalComparisons);
  const mismatchSignature = (mismatch) => JSON.stringify([
    mismatch.requestedHeroId,
    mismatch.bucket,
    mismatch.heroId1,
    mismatch.heroId2,
    mismatch.left,
    mismatch.right,
  ]);
  const singleHeroBatchSignatures = new Set(singleHeroBatchUniqueMismatches.map(mismatchSignature));
  const matchedBatchSignatures = new Set(matchedBatchUniqueMismatches.map(mismatchSignature));
  const matchedBatchComplete = plan.uniqueHeroIds.every((heroId) =>
    singleHeroMatchedBatchComparisons.find((item) =>
      item.requestedHeroId === heroId)?.status === 'COMPARED');
  const singleHeroMatchedBatchMismatchCount = singleHeroMatchedBatchComparisons.filter((item) =>
    item.comparison.mismatchingRowCount > 0).length;
  const historicalBatchMismatchSummary = {
    pairOnlyVsFix9BatchUniqueMismatchRowCount: pairOnlyBatchUniqueMismatches.length,
    singleHeroVsFix9BatchUniqueMismatchRowCount: singleHeroBatchUniqueMismatches.length,
    matchedBatchVsFix9BatchUniqueMismatchRowCount: matchedBatchUniqueMismatches.length,
    pairOnlyAndSingleHeroMismatchSetsEqual:
      pairOnlyBatchUniqueMismatches.length === singleHeroBatchUniqueMismatches.length
      && pairOnlyBatchUniqueMismatches.every((mismatch) =>
        singleHeroBatchSignatures.has(mismatchSignature(mismatch))),
    singleHeroAndMatchedBatchMismatchSetsEqual:
      singleHeroBatchUniqueMismatches.length === matchedBatchUniqueMismatches.length
      && singleHeroBatchUniqueMismatches.every((mismatch) =>
        matchedBatchSignatures.has(mismatchSignature(mismatch))),
    singleHeroMatchesCurrentMatchedBatch: singleHeroMatchedBatchMismatchCount === 0
      && matchedBatchComplete,
    temporalDifferenceSupported: singleHeroBatchUniqueMismatches.length > 0
      && matchedBatchUniqueMismatches.length > 0
      && singleHeroBatchUniqueMismatches.length === matchedBatchUniqueMismatches.length
      && singleHeroBatchUniqueMismatches.every((mismatch) =>
        matchedBatchSignatures.has(mismatchSignature(mismatch)))
      && singleHeroMatchedBatchMismatchCount === 0
      && matchedBatchComplete,
    singleHeroMismatchRowsByBucket: Object.fromEntries(
      [...new Set(singleHeroBatchUniqueMismatches.map((mismatch) => mismatch.bucket))]
        .sort((a, b) => a - b)
        .map((bucket) => [bucket, singleHeroBatchUniqueMismatches.filter((row) =>
          row.bucket === bucket).length]),
    ),
    singleHeroMatchCountIncreased: singleHeroBatchUniqueMismatches.filter((mismatch) =>
      mismatch.left && mismatch.right && mismatch.left.matchCount > mismatch.right.matchCount).length,
    singleHeroMatchCountDecreased: singleHeroBatchUniqueMismatches.filter((mismatch) =>
      mismatch.left && mismatch.right && mismatch.left.matchCount < mismatch.right.matchCount).length,
    singleHeroWinCountChanged: singleHeroBatchUniqueMismatches.filter((mismatch) =>
      mismatch.left && mismatch.right && mismatch.left.winCount !== mismatch.right.winCount).length,
    singleHeroMatchCountDeltaCounts: Object.fromEntries(
      [...new Set(singleHeroBatchUniqueMismatches
        .filter((mismatch) => mismatch.left && mismatch.right)
        .map((mismatch) => mismatch.left.matchCount - mismatch.right.matchCount))]
        .sort((a, b) => a - b)
        .map((delta) => [delta, singleHeroBatchUniqueMismatches.filter((mismatch) =>
          mismatch.left && mismatch.right
          && mismatch.left.matchCount - mismatch.right.matchCount === delta).length]),
    ),
    singleHeroWinCountDeltaCounts: Object.fromEntries(
      [...new Set(singleHeroBatchUniqueMismatches
        .filter((mismatch) => mismatch.left && mismatch.right)
        .map((mismatch) => mismatch.left.winCount - mismatch.right.winCount))]
        .sort((a, b) => a - b)
        .map((delta) => [delta, singleHeroBatchUniqueMismatches.filter((mismatch) =>
          mismatch.left && mismatch.right
          && mismatch.left.winCount - mismatch.right.winCount === delta).length]),
    ),
    singleHeroMismatchExamples: singleHeroBatchUniqueMismatches.slice(0, 10),
    matchedBatchMismatchRowsByBucket: Object.fromEntries(
      [...new Set(matchedBatchUniqueMismatches.map((mismatch) => mismatch.bucket))]
        .sort((a, b) => a - b)
        .map((bucket) => [bucket, matchedBatchUniqueMismatches.filter((row) =>
          row.bucket === bucket).length]),
    ),
  };
  return {
    orderComparisons,
    batchComparisons,
    pairOnlyVsFix9BatchComparisons: batchComparisons,
    pairOnlyVsSingleHeroComparisons: singleComparisons,
    singleHeroVsFix9BatchComparisons: singleHeroBatchComparisons,
    singleHeroVsMatchedBatchComparisons: singleHeroMatchedBatchComparisons,
    matchedBatchVsFix9BatchComparisons: matchedBatchHistoricalComparisons,
    pairOnlyVsFix10RepeatabilityComparisons: repeatabilityComparisons,
    historicalBatchComparison: {
      status: singleHeroBatchComparisons.some((item) => item.status !== 'COMPARED')
        || matchedBatchHistoricalComparisons.some((item) => item.status !== 'COMPARED')
        ? 'INCOMPLETE'
        : singleHeroBatchUniqueMismatches.length > 0
          || matchedBatchUniqueMismatches.length > 0 ? 'MISMATCH' : 'MATCH',
      summary: historicalBatchMismatchSummary,
    },
    summary: {
      orderComparisonCount: orderComparisons.length,
      orderMismatchCount: orderComparisons.filter((item) =>
        item.comparison.mismatchingRowCount > 0).length,
      batchComparisonCount: batchComparisons.length,
      batchMismatchCount: batchComparisons.filter((item) =>
        item.comparison.mismatchingRowCount > 0).length,
      pairOnlyVsSingleHeroComparisonCount: singleComparisons.length,
      pairOnlyVsSingleHeroMismatchCount: singleComparisons.filter((item) =>
        item.comparison.mismatchingRowCount > 0).length,
      fix10ComparisonCount: repeatabilityComparisons.length,
      fix10MismatchCount: repeatabilityComparisons.filter((item) =>
        item.comparison.mismatchingRowCount > 0).length,
      singleHeroVsFix9BatchComparisonCount: singleHeroBatchComparisons.length,
      singleHeroVsFix9BatchMismatchCount: singleHeroBatchComparisons.filter((item) =>
        item.comparison.mismatchingRowCount > 0).length,
      singleHeroVsMatchedBatchComparisonCount: singleHeroMatchedBatchComparisons.length,
      singleHeroVsMatchedBatchMismatchCount: singleHeroMatchedBatchMismatchCount,
      matchedBatchVsFix9BatchMismatchCount: matchedBatchHistoricalComparisons.filter((item) =>
        item.comparison.mismatchingRowCount > 0).length,
      historicalBatchMismatchCount: batchComparisons.filter((item) =>
        item.comparison.mismatchingRowCount > 0).length,
      historicalBatchUniqueMismatchRowCount: singleHeroBatchUniqueMismatches.length,
    },
  };
}

function makeSchemaIntrospectionQuery() {
  const typeRef = '{ kind name ofType { kind name ofType { kind name } } }';
  return `{
    queryRoot: __type(name: "DotaQuery") {
      name fields { name description type ${typeRef} }
    }
    heroStats: __type(name: "HeroStatsQuery") {
      name fields {
        name description type ${typeRef}
        args { name description type ${typeRef} }
      }
    }
    dryad: __type(name: "HeroDryadType") {
      name fields { name description type ${typeRef} }
    }
    matchup: __type(name: "HeroStatsHeroDryadType") {
      name fields { name description type ${typeRef} }
    }
  }`;
}

function graphqlTypeString(type) {
  if (!type) return null;
  if (type.kind === 'NON_NULL') return `${graphqlTypeString(type.ofType)}!`;
  if (type.kind === 'LIST') return `[${graphqlTypeString(type.ofType)}]`;
  return type.name;
}

function summarizeSchema(response) {
  const data = response?.data;
  const matchUp = data?.heroStats?.fields?.find((field) => field.name === 'matchUp');
  const fields = (type) => Object.fromEntries(
    (type?.fields ?? []).map((field) => [field.name, {
      type: graphqlTypeString(field.type),
      description: field.description ?? null,
    }]),
  );
  return {
    queryTypeName: data?.queryRoot?.name ?? null,
    heroStatsQueryTypeName: data?.heroStats?.name ?? null,
    matchUp: matchUp ? {
      returnType: graphqlTypeString(matchUp.type),
      description: matchUp.description ?? null,
      args: Object.fromEntries((matchUp.args ?? []).map((argument) => [
        argument.name,
        {
          type: graphqlTypeString(argument.type),
          description: argument.description ?? null,
        },
      ])),
    } : null,
    dryadTypeName: data?.dryad?.name ?? null,
    dryadFields: fields(data?.dryad),
    matchupTypeName: data?.matchup?.name ?? null,
    matchupFields: fields(data?.matchup),
  };
}

function apiSemanticReferences(schemaRecord, researchDocHash) {
  return {
    status: schemaRecord.status === 'VERIFIED' ? 'SCHEMA_INTROSPECTED' : 'UNVERIFIED',
    retrievedAt: schemaRecord.finishedAt,
    endpoint: 'https://api.stratz.com/graphql',
    schemaQueryHash: schemaRecord.requestHash,
    schemaResponseHash: schemaRecord.responseHash,
    fields: schemaRecord.status === 'VERIFIED'
      ? schemaRecord.summary
      : null,
    claims: [
      {
        field: 'heroId',
        contractFinding: 'The matchUp heroId argument is described as including the hero and excluding results that do not include it; its type is Short.',
        semanticStatus: 'QUERY_FILTER_CONFIRMED_RESULT_FIELD_SEMANTICS_NOT_DESCRIBED',
      },
      {
        field: 'heroId1 / heroId2',
        contractFinding: 'The schema places heroId1: Short and heroId2: Short on HeroStatsHeroDryadType; descriptions are null.',
        semanticStatus: 'FIELD_TYPES_CONFIRMED_SEMANTICS_NOT_DESCRIBED',
      },
      {
        field: 'matchCount',
        contractFinding: 'The schema declares matchCount: Long on HeroStatsHeroDryadType without a field description; matchUp.matchLimit is described as the minimum MatchCount required for a Duo to qualify.',
        semanticStatus: 'DUO_COUNT_INDICATED_REVERSE_EQUALITY_UNVERIFIED',
      },
      {
        field: 'winCount',
        contractFinding: 'The schema declares winCount: Long on HeroStatsHeroDryadType; description is null.',
        semanticStatus: 'FIELD_TYPE_CONFIRMED_WIN_SUBJECT_UNVERIFIED_BY_CONTRACT',
        empiricalReference: {
          path: 'docs/stratz-research.md',
          section: '§4 Puck experiment',
          reportedObservation: 'A prior 126-row Puck probe found heroId1=queried hero for all rows; summed winCount/matchCount aligned with winRateHeroId1, and the inverted reading did not.',
          researchDocSha256: researchDocHash,
        },
      },
      {
        field: 'week',
        contractFinding: 'The matchUp week argument is described as an epoch timestamp of the requested week; the result row week is Int and has no field description.',
        semanticStatus: 'QUERY_FILTER_CONFIRMED_RESULT_FIELD_UNIT_UNDOCUMENTED',
        observedProductionUse: `A bucket identifier is multiplied by BUCKET_SEC (${BUCKET_SEC} seconds) before being sent as week.`,
      },
      {
        field: 'bracketBasicIds',
        contractFinding: 'The matchUp bracketBasicIds argument is described as filtering to ranks 0-8; the result row field is an enum and has no field description.',
        semanticStatus: 'QUERY_FILTER_CONFIRMED_RESULT_FIELD_SEMANTICS_UNDOCUMENTED',
        observedProductionUse: `The query passes the production bracket set: ${BRACKETS.join(', ')}.`,
      },
      {
        field: 'reverse matchCount equality',
        contractFinding: 'No field description or schema-level invariant states that A→B and B→A matchCount must be equal.',
        observedFinding: 'The FIX9 anomaly rows contain unequal reverse-direction matchCount values.',
        semanticStatus: 'UNVERIFIED',
      },
    ],
    officialQueryExample: {
      source: 'Production buildChunkQuery',
      path: 'scripts/update-data-stratz.mjs',
      querySource: 'heroStats.matchUp(heroIds, week, bracketBasicIds, take: 200) { heroId vs { heroId1 heroId2 matchCount winCount } }',
      note: 'This is the project’s production query shape against the official STRATZ endpoint, not a STRATZ-published explanatory example.',
    },
    documentationAvailability: {
      attemptedUrl: 'https://docs.stratz.com/',
      result: 'NOT_AVAILABLE_HTTP_404',
      note: 'The official docs hostname returned 404 in this run; live schema introspection is the primary official source recorded here.',
    },
  };
}

export function buildRootCauseHypotheses(analysis, queryComposition, apiSemantics) {
  const compositionComplete = queryComposition?.status === 'PASS';
  const comparisons = queryComposition?.comparisons?.summary;
  const currentBatchAnalysis = queryComposition?.currentBatchAnalysis;
  const persistentPairs = currentBatchAnalysis?.baselineAggregateViolations?.filter((pair) =>
    pair.baselineAggregate.thresholdExceeded === true
    && pair.currentAggregate.thresholdExceeded === true) ?? [];
  const compositionMismatchCount = comparisons
    ? comparisons.orderMismatchCount
      + comparisons.pairOnlyVsSingleHeroMismatchCount
      + comparisons.fix10MismatchCount
    : null;
  return [
    {
      category: 'STRATZ_FIELD_SEMANTICS',
      status: apiSemantics?.claims?.some((claim) =>
        claim.field === 'reverse matchCount equality'
        && claim.semanticStatus === 'UNVERIFIED') ? 'UNVERIFIED' : 'NOT_ESTABLISHED',
      evidence: ['apiFieldSemantics.claims[reverse matchCount equality]'],
      conclusion: 'The schema does not specify a reverse-direction equality contract; field semantics alone do not explain the asymmetry.',
    },
    {
      category: 'QUERY_FILTER_DEPENDENCE',
      status: compositionMismatchCount == null ? 'NOT_RUN'
        : compositionMismatchCount === 0 && compositionComplete ? 'NOT_OBSERVED'
          : compositionMismatchCount > 0 ? 'OBSERVED_NEEDS_LOCALIZATION' : 'INCOMPLETE',
      evidence: ['queryComposition.comparisons'],
      conclusion: compositionMismatchCount === 0 && compositionComplete
        ? 'No query-order, pair-only/single-hero, single-hero/matched-batch, or overlapping FIX10 repeatability mismatch was observed in the tested rows. Differences from the older FIX9 batch are reported separately.'
        : 'Query composition cannot be ruled out until all planned comparisons are complete and equal.',
    },
    {
      category: 'HERO_ID_ORIENTATION',
      status: analysis.orientationAnalysis.rawRowsForAnomalyDirections > 0
        ? 'OBSERVED_NOT_CAUSAL'
        : 'UNVERIFIED',
      evidence: ['orientationAnalysis.rawRows'],
      conclusion: 'Orientation and win-count normalization are reported as observations; they do not by themselves establish why matchCount differs.',
    },
    {
      category: 'PERSISTENT_DIRECTIONAL_ASYMMETRY',
      status: currentBatchAnalysis?.status !== 'VERIFIED' ? 'INCOMPLETE'
        : persistentPairs.length > 0 ? 'OBSERVED_NOT_CAUSAL' : 'NOT_OBSERVED',
      evidence: ['queryComposition.currentBatchAnalysis.baselineAggregateViolations'],
      conclusion: persistentPairs.length > 0
        ? 'The FIX9 aggregate-violating pairs also exceed the unchanged threshold in the current production batch control; persistence is observed but does not explain the asymmetry.'
        : 'No FIX9 aggregate-violating pair remains above threshold in the current production batch control.',
    },
    {
      category: 'BUCKET_INGESTION',
      status: queryComposition?.comparisons?.historicalBatchComparison?.summary
        ?.temporalDifferenceSupported
        ? 'TEMPORAL_DIFFERENCES_OBSERVED_PROVENANCE_UNVERIFIED'
        : queryComposition?.comparisons?.historicalBatchComparison?.status === 'MISMATCH'
          ? 'HISTORICAL_DIFFERENCES_NOT_LOCALIZED' : 'UNRESOLVED',
      evidence: [
        'queryComposition.comparisons.historicalBatchComparison',
        'queryComposition.requests',
        'queryComposition.matchedBatchControl.requests',
      ],
      conclusion: 'Historical differences are treated as temporal evidence only when current single-hero and matched multi-hero results agree while both differ from FIX9; even then, ingestion provenance and the cause of reverse-direction asymmetry remain unverified.',
    },
    {
      category: 'AGGREGATION_ERROR',
      status: analysis.aggregateAttribution.aggregateGameSumsMatchAllBuckets
        ? 'NOT_OBSERVED_IN_RAW_RECOMPUTATION'
        : 'REQUIRES_INVESTIGATION',
      evidence: ['aggregateAttribution.pairs'],
      conclusion: 'Per-bucket game totals are summed independently and checked against production aggregation; this does not exclude upstream data defects.',
    },
    {
      category: 'BUCKET_SPECIFIC_DATA_ANOMALY',
      status: analysis.perBucket.pairWeekViolationCount > 0 ? 'OBSERVED_PATTERN_NOT_CAUSAL' : 'NOT_OBSERVED',
      evidence: ['perBucket.anomalyInventory', 'aggregateAttribution.pairs'],
      conclusion: 'Threshold failures occur in specific pair-weeks and may pass after aggregation; this is a descriptive pattern, not a proven root cause.',
    },
    {
      category: 'UNRESOLVED',
      status: 'RETAINED',
      evidence: ['all available evidence'],
      conclusion: 'No causal category is selected without a documented API contract or a controlled result that excludes alternatives.',
    },
  ];
}

function createRootCauseEvidence(sources, analysis, options = {}) {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const plan = createCompositionPlan(
    analysis.perBucket.anomalyInventory,
    sources.input.attemptedWindow.buckets,
  );
  const expectedCompositionRequests = plan.requests.length;
  const evidence = {
    schemaVersion: 1,
    createdAt,
    protectedSourceHashes: {
      fix9Input: {
        path: 'scripts/stratz-diagnostic-input.json',
        canonicalSha256: sources.input.inputSha256,
        fileSha256: sources.fileHashes.fix9Input,
      },
      fix10RepeatabilityEvidence: {
        path: 'research/data-quality/stratz-reverse-pair-repeatability-evidence.json',
        canonicalSha256: sources.repeatability.evidenceSha256,
        fileSha256: sources.fileHashes.fix10RepeatabilityEvidence,
      },
      fix10HistoricalReport: {
        path: 'research/data-quality/stratz-reverse-pair-asymmetry-report.json',
        canonicalSha256: null,
        fileSha256: sources.fileHashes.fix10HistoricalReport,
      },
      stratzResearchDoc: {
        path: 'docs/stratz-research.md',
        fileSha256: sources.fileHashes.stratzResearchDoc,
      },
      productionBefore: {
        heroes: sources.fileHashes.productionHeroes,
        matchups: sources.fileHashes.productionMatchups,
        meta: sources.fileHashes.productionMeta,
      },
    },
    windows: {
      productionPublishedBuckets: sources.historicalReport.productionPublishedWindow,
      diagnosticBuckets: sources.input.attemptedWindow.buckets,
      windowStartUtc: sources.input.attemptedWindow.windowStartUtc,
      windowEndUtcExclusive: sources.input.attemptedWindow.windowEndUtcExclusive,
      brackets: BRACKETS,
      take: 200,
      bucketSeconds: BUCKET_SEC,
    },
    anomalyAnalysis: analysis,
    queryComposition: {
      status: 'NOT_RUN',
      plan: {
        unorderedPairCount: plan.pairs.length,
        uniqueHeroCount: plan.uniqueHeroIds.length,
        uniqueHeroIds: plan.uniqueHeroIds,
        expectedRequestCount: expectedCompositionRequests,
        requests: plan.requests.map(({ requestId, kind, pairId, requestedHeroIds }) => ({
          requestId,
          kind,
          pairId: pairId ?? null,
          requestedHeroIds,
        })),
      },
      queryParameters: {
        builder: 'scripts/update-data-stratz.mjs:buildChunkQuery',
        transport: 'scripts/update-data-stratz.mjs:StratzTransport',
        tokenLoader: 'scripts/update-data-stratz.mjs:loadToken',
        buckets: sources.input.attemptedWindow.buckets,
        brackets: BRACKETS,
        take: 200,
      },
      requests: [],
      comparisons: null,
      rawResponseArtifact: null,
    },
    apiFieldSemantics: apiSemanticReferences(
      { status: 'NOT_RUN' },
      sources.fileHashes.stratzResearchDoc,
    ),
    rootCauseHypotheses: [],
    rootCause: {
      status: 'UNRESOLVED',
      category: 'UNRESOLVED',
      productionPublishAllowed: false,
      explanation: 'FIX11 research does not infer a cause from repeatability or threshold anomalies alone.',
    },
  };
  evidence.rootCauseHypotheses = buildRootCauseHypotheses(
    analysis,
    evidence.queryComposition,
    evidence.apiFieldSemantics,
  );
  return evidence;
}

function validateCompositionResponse(response, buckets, requestedHeroIds) {
  if (!response?.data?.heroStats || Array.isArray(response.errors)) {
    throw new Error('Response has no data.heroStats or contains GraphQL errors');
  }
  const observedHeroIdsByBucket = {};
  for (const bucket of buckets) {
    const dryads = response.data.heroStats[`w${bucket}`];
    if (!Array.isArray(dryads)) throw new Error(`Response is missing bucket w${bucket}`);
    const seen = new Set();
    for (const dryad of dryads) {
      if (!requestedHeroIds.includes(dryad.heroId) || seen.has(dryad.heroId)) {
        throw new Error(`Response has unexpected or duplicate dryad hero ${dryad.heroId} in w${bucket}`);
      }
      seen.add(dryad.heroId);
      if (!Array.isArray(dryad.vs)) throw new Error(`Response has invalid vs rows for hero ${dryad.heroId}`);
      for (const row of dryad.vs) {
        if (!Number.isSafeInteger(row.heroId1) || !Number.isSafeInteger(row.heroId2)
          || row.heroId1 <= 0 || row.heroId2 <= 0
          || row.heroId1 === row.heroId2
          || (row.heroId1 !== dryad.heroId && row.heroId2 !== dryad.heroId)
          || !Number.isSafeInteger(row.matchCount) || row.matchCount < 0
          || !Number.isSafeInteger(row.winCount) || row.winCount < 0
          || row.winCount > row.matchCount) {
          throw new Error(`Response has invalid matchup row for hero ${dryad.heroId} in w${bucket}`);
        }
      }
    }
    observedHeroIdsByBucket[bucket] = [...seen].sort((a, b) => a - b);
  }
  return observedHeroIdsByBucket;
}

function safeError(error, token) {
  let message = error instanceof Error ? error.message : String(error);
  if (token) message = message.split(token).join('<redacted-token>');
  return message.replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer <redacted>');
}

export async function runFreshQuery({
  query,
  requestedHeroIds,
  buckets,
  Transport,
  token,
  now,
}) {
  const record = {
    startedAt: now().toISOString(),
    finishedAt: null,
    status: 'FAILED',
    response: null,
    responseHash: null,
    observedHeroIdsByBucket: null,
    rowCount: null,
    transportCreated: false,
    transportClosed: false,
    error: null,
    closeError: null,
  };
  let transport;
  try {
    transport = new Transport(token);
    record.transportCreated = true;
    await transport.init();
    const response = await transport.query(query);
    record.response = response;
    record.responseHash = responseSha256(response);
    const observedHeroIdsByBucket = requestedHeroIds.length || buckets.length
      ? validateCompositionResponse(response, buckets, requestedHeroIds)
      : {};
    if (!response?.data || Array.isArray(response.errors)) {
      throw new Error('Response has no GraphQL data or contains GraphQL errors');
    }
    const extracted = requestedHeroIds.length || buckets.length
      ? readResponseRows(response, buckets, requestedHeroIds)
      : { rows: [] };
    record.observedHeroIdsByBucket = observedHeroIdsByBucket;
    record.rowCount = extracted.rows.length;
    record.status = 'VERIFIED';
  } catch (error) {
    record.error = safeError(error, token);
  } finally {
    if (transport) {
      try {
        await transport.close();
        record.transportClosed = true;
      } catch (error) {
        record.closeError = safeError(error, token);
        record.status = 'INCOMPLETE';
      }
    }
    record.finishedAt = now().toISOString();
  }
  return record;
}

function schemaTypeName(type) {
  return type?.name ?? (type?.ofType ? schemaTypeName(type.ofType) : null);
}

function assertNoToken(value, token, label) {
  if (token && JSON.stringify(value).includes(token)) {
    throw new Error(`${label} unexpectedly contains the STRATZ token`);
  }
}

function compileCompositionEvidence({
  evidence,
  sources,
  analysis,
  plan,
  requestRecords,
  schemaRecord,
  rawArtifact,
  rawBytes,
  write,
  writeRaw = true,
  rawPath,
  evidencePath,
  token,
}) {
  const buckets = sources.input.attemptedWindow.buckets;
  const matchedBatchControl = rawArtifact.matchedBatchControl ?? null;
  const matchedBatchRecords = matchedBatchControl?.records ?? [];
  const matchedBatchFailureCount = matchedBatchRecords.filter((record) =>
    record.status !== 'VERIFIED').length;
  const responseById = new Map(Object.entries(rawArtifact.queryResponses ?? {})
    .map(([id, value]) => [id, value.response]));
  const matchedBatchResponses = new Map(Object.entries(matchedBatchControl?.queryResponses ?? {})
    .map(([id, value]) => [id, value.response]));
  const comparisons = composeComparisons(
    plan,
    requestRecords,
    responseById,
    sources.input,
    sources.repeatability,
    buckets,
    {
      records: matchedBatchRecords,
      responses: matchedBatchResponses,
    },
  );
  const failedRequestCount = requestRecords.filter((record) =>
    record.status !== 'VERIFIED').length + matchedBatchFailureCount
    + Number(schemaRecord.status !== 'VERIFIED');
  const missingDryadCount = requestRecords.reduce((sum, record) => {
    if (!record.observedHeroIdsByBucket) return sum;
    return sum + buckets.reduce((count, bucket) =>
      count + record.requestedHeroIds.filter((heroId) =>
        !record.observedHeroIdsByBucket[bucket]?.includes(heroId)).length, 0);
  }, 0) + matchedBatchRecords.reduce((sum, record) => {
    if (!record.observedHeroIdsByBucket) return sum;
    return sum + buckets.reduce((count, bucket) =>
      count + record.requestedHeroIds.filter((heroId) =>
        !record.observedHeroIdsByBucket[bucket]?.includes(heroId)).length, 0);
  }, 0);
  const directMismatchCount = comparisons.summary.orderMismatchCount
    + comparisons.summary.pairOnlyVsSingleHeroMismatchCount
    + comparisons.summary.singleHeroVsMatchedBatchMismatchCount
    + comparisons.summary.fix10MismatchCount;
  const queryCompositionStatus = failedRequestCount > 0 || missingDryadCount > 0
    || matchedBatchRecords.length !== sources.input.batchResults.chunks.length
    ? 'INCOMPLETE'
    : directMismatchCount > 0 ? 'FAIL' : 'PASS';
  const finishedAt = rawArtifact.createdAt ?? schemaRecord.finishedAt;
  const currentBatchAnalysis = currentBatchPairAnalysis(sources.input, analysis, rawArtifact);
  evidence.queryComposition = {
    ...evidence.queryComposition,
    status: queryCompositionStatus,
    startedAt: schemaRecord.startedAt,
    finishedAt,
    schemaIntrospection: {
      ...schemaRecord,
      endpoint: undefined,
      query: undefined,
    },
    queryParameters: {
      ...evidence.queryComposition.queryParameters,
      endpoint: 'https://api.stratz.com/graphql',
      transport: 'production StratzTransport',
      tokenLoader: 'production loadToken',
      queryBuilder: 'production buildChunkQuery',
    },
    requests: requestRecords,
    currentBatchAnalysis,
    matchedBatchControl: matchedBatchRecords.length > 0 ? {
      selection: 'FIX9 source chunk heroIds, queried independently with production buildChunkQuery',
      buckets,
      brackets: BRACKETS,
      take: 200,
      requests: matchedBatchRecords,
    } : null,
    summary: {
      plannedRequestCount: plan.requests.length,
      verifiedRequestCount: requestRecords.filter((record) =>
        record.status === 'VERIFIED').length,
      matchedBatchControlRequestCount: matchedBatchRecords.length,
      verifiedMatchedBatchControlRequestCount: matchedBatchRecords.filter((record) =>
        record.status === 'VERIFIED').length,
      failedRequestCount,
      missingRequestedDryadCount: missingDryadCount,
      mismatchCount: directMismatchCount,
      directCompositionMismatchCount: directMismatchCount,
      historicalFix9BatchMismatchCount: comparisons.summary.batchMismatchCount,
      historicalFix9BatchUniqueMismatchRowCount:
        comparisons.summary.historicalBatchUniqueMismatchRowCount,
      transportInstancesCreated: requestRecords.filter((record) =>
        record.transportCreated).length + matchedBatchRecords.filter((record) =>
        record.transportCreated).length + Number(schemaRecord.transportCreated),
      transportsClosed: requestRecords.filter((record) =>
        record.transportClosed).length + matchedBatchRecords.filter((record) =>
        record.transportClosed).length + Number(schemaRecord.transportClosed),
    },
    comparisons,
    rawResponseArtifact: {
      path: path.relative(ROOT, rawPath),
      responseCount: Object.keys(rawArtifact.queryResponses ?? {}).length,
      matchedBatchResponseCount: Object.keys(matchedBatchControl?.queryResponses ?? {}).length,
      schemaResponseIncluded: Boolean(rawArtifact.schemaIntrospection?.response),
      sha256: sha256(rawBytes),
      canonicalSha256: canonicalJsonSha256(rawArtifact),
    },
  };
  evidence.apiFieldSemantics = apiSemanticReferences(
    {
      status: schemaRecord.status,
      requestHash: schemaRecord.requestHash,
      responseHash: schemaRecord.responseHash,
      finishedAt: schemaRecord.finishedAt,
      summary: schemaRecord.summary,
    },
    sources.fileHashes.stratzResearchDoc,
  );
  evidence.rootCauseHypotheses = buildRootCauseHypotheses(
    analysis,
    evidence.queryComposition,
    evidence.apiFieldSemantics,
  );
  evidence.rootCause = {
    status: 'UNRESOLVED',
    category: 'UNRESOLVED',
    productionPublishAllowed: false,
    evidence: [
      {
        id: 'fix9-raw-anomaly-recomputation',
        result: 'REPRODUCED',
        directedViolations: analysis.perBucket.directedViolationCount,
        pairWeeks: analysis.perBucket.pairWeekViolationCount,
        uniquePairs: analysis.perBucket.uniquePairCount,
      },
      {
        id: 'current-query-composition-controls',
        result: queryCompositionStatus,
        orderMismatches: comparisons.summary.orderMismatchCount,
        pairOnlyVsSingleMismatches: comparisons.summary.pairOnlyVsSingleHeroMismatchCount,
        singleHeroVsMatchedBatchMismatches:
          comparisons.summary.singleHeroVsMatchedBatchMismatchCount,
        fix10RepeatabilityMismatches: comparisons.summary.fix10MismatchCount,
      },
      {
        id: 'historical-fix9-batch-comparison',
        result: comparisons.historicalBatchComparison.summary.temporalDifferenceSupported
          ? 'TEMPORAL_DIFFERENCES_SUPPORTED_NOT_CAUSAL'
          : comparisons.historicalBatchComparison.status,
        uniqueRows: comparisons.historicalBatchComparison.summary
          .singleHeroVsFix9BatchUniqueMismatchRowCount,
        buckets: comparisons.historicalBatchComparison.summary.singleHeroMismatchRowsByBucket,
        note: 'Current matched-batch and single-hero outputs agree with each other and have identical differences from FIX9; this does not explain the suspected reverse-direction asymmetry.',
      },
      {
        id: 'persistent-current-directional-asymmetry',
        result: evidence.rootCauseHypotheses.find((item) =>
          item.category === 'PERSISTENT_DIRECTIONAL_ASYMMETRY')?.status ?? 'UNVERIFIED',
        pairWeekComparison: currentBatchAnalysis.pairWeekComparisonToFix9,
        pairs: currentBatchAnalysis.baselineAggregateViolations,
      },
      {
        id: 'reverse-matchcount-equality-contract',
        result: evidence.apiFieldSemantics.claims.find((claim) =>
          claim.field === 'reverse matchCount equality')?.semanticStatus ?? 'UNVERIFIED',
        note: 'The available schema does not specify that reverse-direction matchCount values must be equal.',
      },
    ],
    explanation: queryCompositionStatus === 'PASS'
      ? 'Pair order, pair-only versus single-hero, and single-hero versus matched production batch controls agree. Historical FIX9 differences are separately attributed only as temporal change evidence when both current query shapes agree; this does not establish why reverse counts differ or a schema equality invariant.'
      : 'The available evidence does not establish a single cause; direct query-composition checks are incomplete or have mismatches requiring follow-up.',
  };
  evidence.evidenceSha256 = canonicalJsonSha256(evidence, 'evidenceSha256');
  assertNoToken(rawArtifact, token, 'Raw response artifact');
  assertNoToken(evidence, token, 'Root cause evidence');
  if (writeRaw) write(rawPath, rawBytes);
  write(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

export async function runCompositionResearch(deps = {}) {
  const sources = sourceFiles(deps);
  const analysis = analyzeFix9Raw(sources.input, { heroNames: sources.heroNames });
  const evidence = createRootCauseEvidence(sources, analysis, {
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
  });
  const buckets = sources.input.attemptedWindow.buckets;
  const plan = createCompositionPlan(analysis.perBucket.anomalyInventory, buckets);
  const token = (deps.loadToken ?? loadToken)();
  const Transport = deps.StratzTransport ?? StratzTransport;
  const now = deps.now ?? (() => new Date());
  const delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const requestRecords = [];
  const rawResponses = {};
  const schemaQuery = makeSchemaIntrospectionQuery();
  const schemaRecord = {
    requestId: 'official-schema-introspection',
    kind: 'schema-introspection',
    endpoint: 'https://api.stratz.com/graphql',
    requestHash: sha256(schemaQuery),
    startedAt: now().toISOString(),
    finishedAt: null,
    status: 'FAILED',
    transportCreated: false,
    transportClosed: false,
    responseHash: null,
    summary: null,
    error: null,
  };
  const schemaResult = await runFreshQuery({
    query: schemaQuery,
    requestedHeroIds: [],
    buckets: [],
    Transport,
    token,
    now,
  });
  schemaRecord.startedAt = schemaResult.startedAt;
  schemaRecord.finishedAt = schemaResult.finishedAt;
  schemaRecord.status = schemaResult.status;
  schemaRecord.transportCreated = schemaResult.transportCreated;
  schemaRecord.transportClosed = schemaResult.transportClosed;
  schemaRecord.responseHash = schemaResult.responseHash;
  schemaRecord.error = schemaResult.error ?? schemaResult.closeError;
  if (schemaResult.response) {
    schemaRecord.summary = summarizeSchema(schemaResult.response);
    rawResponses[schemaRecord.requestId] = {
      query: schemaQuery,
      response: schemaResult.response,
      responseSha256: schemaResult.responseHash,
    };
  }
  for (let index = 0; index < plan.requests.length; index += 1) {
    const request = plan.requests[index];
    const query = buildChunkQuery(request.requestedHeroIds, buckets);
    const result = await runFreshQuery({
      query,
      requestedHeroIds: request.requestedHeroIds,
      buckets,
      Transport,
      token,
      now,
    });
    const record = {
      requestId: request.requestId,
      kind: request.kind,
      pairId: request.pairId ?? null,
      requestedHeroIds: request.requestedHeroIds,
      requestHash: sha256(query),
      responseHash: result.responseHash,
      status: result.status,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      observedHeroIdsByBucket: result.observedHeroIdsByBucket,
      rowCount: result.rowCount,
      error: result.error,
      closeError: result.closeError,
      transportCreated: result.transportCreated,
      transportClosed: result.transportClosed,
      rawResponseId: result.response ? request.requestId : null,
    };
    requestRecords.push(record);
    if (result.response) {
      rawResponses[request.requestId] = {
        query,
        response: result.response,
        responseSha256: result.responseHash,
      };
    }
    if (index + 1 < plan.requests.length) await delay(deps.delayMs ?? 100);
  }
  const rawArtifact = {
    schemaVersion: 1,
    source: 'STRATZ production GraphQL via StratzTransport',
    createdAt: now().toISOString(),
    tokenPersisted: false,
    schemaIntrospection: {
      query: schemaQuery,
      response: rawResponses[schemaRecord.requestId]?.response ?? null,
      responseSha256: schemaRecord.responseHash,
    },
    queryResponses: Object.fromEntries(
      requestRecords
        .filter((record) => rawResponses[record.requestId])
        .map((record) => [record.requestId, rawResponses[record.requestId]]),
    ),
  };
  rawArtifact.createdAt = now().toISOString();
  const rawJson = `${JSON.stringify(rawArtifact, null, 2)}\n`;
  const rawBytes = Buffer.from(rawJson);
  const write = deps.writeFileSync ?? writeFileSync;
  return compileCompositionEvidence({
    evidence,
    sources,
    analysis,
    plan,
    requestRecords,
    schemaRecord,
    rawArtifact,
    rawBytes,
    write,
    rawPath: deps.rawPath ?? ROOT_CAUSE_RAW_PATH,
    evidencePath: deps.evidencePath ?? ROOT_CAUSE_EVIDENCE_PATH,
    token,
  });
}

export async function refreshCompositionEvidenceFromSavedResponses(deps = {}) {
  const read = deps.readFileSync ?? readFileSync;
  const sources = sourceFiles(deps);
  const evidencePath = deps.evidencePath ?? ROOT_CAUSE_EVIDENCE_PATH;
  const rawPath = deps.rawPath ?? ROOT_CAUSE_RAW_PATH;
  const evidence = parseJson(evidencePath, read);
  const rawBytes = read(rawPath);
  const rawArtifact = JSON.parse(rawBytes.toString('utf8'));
  if (evidence.queryComposition.rawResponseArtifact?.sha256 !== sha256(rawBytes)) {
    throw new Error('Saved raw response artifact hash does not match the existing FIX11 evidence');
  }
  const analysis = analyzeFix9Raw(sources.input, { heroNames: sources.heroNames });
  const plan = createCompositionPlan(
    analysis.perBucket.anomalyInventory,
    sources.input.attemptedWindow.buckets,
  );
  return compileCompositionEvidence({
    evidence,
    sources,
    analysis,
    plan,
    requestRecords: evidence.queryComposition.requests,
    schemaRecord: evidence.queryComposition.schemaIntrospection,
    rawArtifact,
    rawBytes,
    write: deps.writeFileSync ?? writeFileSync,
    writeRaw: false,
    rawPath,
    evidencePath,
  });
}

export async function runMatchedBatchControl(deps = {}) {
  const sources = sourceFiles(deps);
  const read = deps.readFileSync ?? readFileSync;
  const evidencePath = deps.evidencePath ?? ROOT_CAUSE_EVIDENCE_PATH;
  const rawPath = deps.rawPath ?? ROOT_CAUSE_RAW_PATH;
  const evidence = parseJson(evidencePath, read);
  const rawBytesBefore = read(rawPath);
  const rawArtifact = JSON.parse(rawBytesBefore.toString('utf8'));
  if (evidence.queryComposition.rawResponseArtifact?.sha256 !== sha256(rawBytesBefore)) {
    throw new Error('Saved raw response artifact hash does not match the existing FIX11 evidence');
  }
  if (rawArtifact.matchedBatchControl) {
    throw new Error('A matched FIX9 batch control is already saved; refusing to overwrite its raw responses');
  }
  const token = (deps.loadToken ?? loadToken)();
  const Transport = deps.StratzTransport ?? StratzTransport;
  const now = deps.now ?? (() => new Date());
  const delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const buckets = sources.input.attemptedWindow.buckets;
  const records = [];
  const queryResponses = {};
  const chunks = chunksFromInput(sources.input);
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const requestId = `matched-fix9-chunk-${chunk.chunkIndex}`;
    const query = buildChunkQuery(chunk.chunkHeroIds, buckets);
    const result = await runFreshQuery({
      query,
      requestedHeroIds: chunk.chunkHeroIds,
      buckets,
      Transport,
      token,
      now,
    });
    const missingRequestedHeroIdsByBucket = Object.fromEntries(buckets.map((bucket) => [
      bucket,
      chunk.chunkHeroIds.filter((heroId) =>
        !result.observedHeroIdsByBucket?.[bucket]?.includes(heroId)),
    ]));
    const missingRequestedHeroes = Object.values(missingRequestedHeroIdsByBucket)
      .some((heroIds) => heroIds.length > 0);
    records.push({
      requestId,
      kind: 'matched-fix9-batch-control',
      chunkIndex: chunk.chunkIndex,
      requestedHeroIds: chunk.chunkHeroIds,
      requestHash: sha256(query),
      responseHash: result.responseHash,
      status: result.status === 'VERIFIED' && missingRequestedHeroes
        ? 'INCOMPLETE' : result.status,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      observedHeroIdsByBucket: result.observedHeroIdsByBucket,
      missingRequestedHeroIdsByBucket,
      rowCount: result.rowCount,
      error: result.error ?? (missingRequestedHeroes
        ? 'Response omitted one or more requested hero rows' : null),
      closeError: result.closeError,
      transportCreated: result.transportCreated,
      transportClosed: result.transportClosed,
      rawResponseId: result.response ? requestId : null,
    });
    if (result.response) {
      queryResponses[requestId] = {
        query,
        response: result.response,
        responseSha256: result.responseHash,
      };
    }
    if (index + 1 < chunks.length) await delay(deps.delayMs ?? 100);
  }
  rawArtifact.matchedBatchControl = {
    selection: 'FIX9 source chunks queried using production buildChunkQuery',
    startedAt: records[0]?.startedAt ?? now().toISOString(),
    finishedAt: records.at(-1)?.finishedAt ?? now().toISOString(),
    queryParameters: {
      endpoint: 'https://api.stratz.com/graphql',
      transport: 'production StratzTransport',
      tokenLoader: 'production loadToken',
      queryBuilder: 'production buildChunkQuery',
      buckets,
      brackets: BRACKETS,
      take: 200,
    },
    records,
    queryResponses,
  };
  rawArtifact.createdAt = rawArtifact.matchedBatchControl.finishedAt;
  const rawBytes = Buffer.from(`${JSON.stringify(rawArtifact, null, 2)}\n`);
  const analysis = analyzeFix9Raw(sources.input, { heroNames: sources.heroNames });
  const plan = createCompositionPlan(analysis.perBucket.anomalyInventory, buckets);
  return compileCompositionEvidence({
    evidence,
    sources,
    analysis,
    plan,
    requestRecords: evidence.queryComposition.requests,
    schemaRecord: evidence.queryComposition.schemaIntrospection,
    rawArtifact,
    rawBytes,
    write: deps.writeFileSync ?? writeFileSync,
    rawPath,
    evidencePath,
    token,
  });
}

export function verifyRootCauseEvidence(evidence, rawArtifact, sources) {
  if (evidence.protectedSourceHashes.fix9Input.canonicalSha256 !== sources.input.inputSha256
    || evidence.protectedSourceHashes.fix10RepeatabilityEvidence.canonicalSha256
      !== sources.repeatability.evidenceSha256) {
    throw new Error('Root cause evidence does not reference the protected FIX9/FIX10 hashes');
  }
  if (evidence.protectedSourceHashes.fix9Input.fileSha256 !== sources.fileHashes.fix9Input
    || evidence.protectedSourceHashes.fix10RepeatabilityEvidence.fileSha256
      !== sources.fileHashes.fix10RepeatabilityEvidence
    || evidence.protectedSourceHashes.fix10HistoricalReport.fileSha256
      !== sources.fileHashes.fix10HistoricalReport
    || evidence.protectedSourceHashes.productionBefore.heroes !== sources.fileHashes.productionHeroes
    || evidence.protectedSourceHashes.productionBefore.matchups !== sources.fileHashes.productionMatchups
    || evidence.protectedSourceHashes.productionBefore.meta !== sources.fileHashes.productionMeta) {
    throw new Error('A protected source file hash differs from the value recorded in FIX11 evidence');
  }
  if (evidence.evidenceSha256 !== canonicalJsonSha256(evidence, 'evidenceSha256')) {
    throw new Error('Root cause evidence canonical hash mismatch');
  }
  if (evidence.rootCause.status !== 'UNRESOLVED'
    || evidence.rootCause.productionPublishAllowed !== false) {
    throw new Error('Root cause must remain UNRESOLVED and production publish disabled');
  }
  if (rawArtifact && evidence.queryComposition.rawResponseArtifact?.canonicalSha256
    !== canonicalJsonSha256(rawArtifact)) {
    throw new Error('Raw response artifact canonical hash mismatch');
  }
  return { status: 'PASS', evidenceSha256: evidence.evidenceSha256 };
}

export async function runOfflineAnalysis(deps = {}) {
  const sources = sourceFiles(deps);
  const analysis = analyzeFix9Raw(sources.input, { heroNames: sources.heroNames });
  const evidence = createRootCauseEvidence(sources, analysis, {
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
  });
  evidence.evidenceSha256 = canonicalJsonSha256(evidence, 'evidenceSha256');
  (deps.writeFileSync ?? writeFileSync)(
    deps.evidencePath ?? ROOT_CAUSE_EVIDENCE_PATH,
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  return evidence;
}

export async function runResearchCheck(deps = {}) {
  const sources = sourceFiles(deps);
  const evidence = parseJson(deps.evidencePath ?? ROOT_CAUSE_EVIDENCE_PATH, deps.readFileSync ?? readFileSync);
  const rawPath = deps.rawPath ?? ROOT_CAUSE_RAW_PATH;
  let rawArtifact = null;
  let rawBytes = null;
  if (evidence.queryComposition.status !== 'NOT_RUN') {
    rawBytes = (deps.readFileSync ?? readFileSync)(rawPath);
    rawArtifact = JSON.parse(rawBytes.toString('utf8'));
    if (evidence.queryComposition.rawResponseArtifact?.sha256
      !== sha256File(rawPath, deps.readFileSync ?? readFileSync)) {
      throw new Error('Raw response artifact file SHA-256 mismatch');
    }
  }
  const checked = verifyRootCauseEvidence(evidence, rawArtifact, sources);
  const expectedAnalysis = analyzeFix9Raw(sources.input, { heroNames: sources.heroNames });
  if (JSON.stringify(canonicalize(expectedAnalysis))
    !== JSON.stringify(canonicalize(evidence.anomalyAnalysis))) {
    throw new Error('FIX11 anomaly analysis does not reproduce from protected FIX9 raw responses');
  }
  if (evidence.anomalyAnalysis.perBucket.directedViolationCount !== 62
    || evidence.anomalyAnalysis.perBucket.pairWeekViolationCount !== 34
    || evidence.anomalyAnalysis.perBucket.uniquePairCount !== 30) {
    throw new Error('FIX11 anomaly inventory does not match the raw FIX9 control counts');
  }
  if (evidence.queryComposition.status === 'PASS'
    && evidence.queryComposition.summary.directCompositionMismatchCount !== 0) {
    throw new Error('Query composition is PASS with mismatches');
  }
  if (rawArtifact) {
    const expectedEvidence = compileCompositionEvidence({
      evidence: JSON.parse(JSON.stringify(evidence)),
      sources,
      analysis: expectedAnalysis,
      plan: createCompositionPlan(
        expectedAnalysis.perBucket.anomalyInventory,
        sources.input.attemptedWindow.buckets,
      ),
      requestRecords: evidence.queryComposition.requests,
      schemaRecord: evidence.queryComposition.schemaIntrospection,
      rawArtifact,
      rawBytes,
      write: () => {},
      writeRaw: false,
      rawPath,
      evidencePath: deps.evidencePath ?? ROOT_CAUSE_EVIDENCE_PATH,
    });
    if (JSON.stringify(canonicalize(expectedEvidence))
      !== JSON.stringify(canonicalize(evidence))) {
      throw new Error('FIX11 query comparisons do not reproduce from saved raw responses');
    }
  }
  return {
    ...checked,
    queryCompositionStatus: evidence.queryComposition.status,
    anomalyCounts: {
      directed: evidence.anomalyAnalysis.perBucket.directedViolationCount,
      pairWeeks: evidence.anomalyAnalysis.perBucket.pairWeekViolationCount,
      uniquePairs: evidence.anomalyAnalysis.perBucket.uniquePairCount,
    },
    historicalBatchComparison:
      evidence.queryComposition.comparisons?.historicalBatchComparison ?? null,
    currentBatchAnalysisStatus: evidence.queryComposition.currentBatchAnalysis?.status ?? null,
  };
}

async function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  if (command === 'analyze') {
    const evidence = await runOfflineAnalysis();
    console.log(JSON.stringify({
      status: 'PASS',
      anomalyCounts: {
        directed: evidence.anomalyAnalysis.perBucket.directedViolationCount,
        pairWeeks: evidence.anomalyAnalysis.perBucket.pairWeekViolationCount,
        uniquePairs: evidence.anomalyAnalysis.perBucket.uniquePairCount,
      },
      evidence: ROOT_CAUSE_EVIDENCE_PATH,
      queryComposition: evidence.queryComposition.status,
    }, null, 2));
    return;
  }
  if (command === 'compose') {
    const evidence = await runCompositionResearch();
    console.log(JSON.stringify({
      status: evidence.queryComposition.status,
      summary: evidence.queryComposition.summary,
      evidence: ROOT_CAUSE_EVIDENCE_PATH,
      rawResponses: ROOT_CAUSE_RAW_PATH,
      rootCause: evidence.rootCause,
    }, null, 2));
    return;
  }
  if (command === 'reconcile') {
    const evidence = await refreshCompositionEvidenceFromSavedResponses();
    console.log(JSON.stringify({
      status: evidence.queryComposition.status,
      summary: evidence.queryComposition.summary,
      historicalBatchComparison: evidence.queryComposition.comparisons.historicalBatchComparison,
      evidence: ROOT_CAUSE_EVIDENCE_PATH,
      rawResponses: ROOT_CAUSE_RAW_PATH,
      rootCause: evidence.rootCause,
    }, null, 2));
    return;
  }
  if (command === 'batch-control') {
    const evidence = await runMatchedBatchControl();
    console.log(JSON.stringify({
      status: evidence.queryComposition.status,
      summary: evidence.queryComposition.summary,
      matchedBatchControl: evidence.queryComposition.matchedBatchControl,
      historicalBatchComparison: evidence.queryComposition.comparisons.historicalBatchComparison,
      evidence: ROOT_CAUSE_EVIDENCE_PATH,
      rawResponses: ROOT_CAUSE_RAW_PATH,
      rootCause: evidence.rootCause,
    }, null, 2));
    return;
  }
  if (command === 'check') {
    console.log(JSON.stringify(await runResearchCheck(), null, 2));
    return;
  }
  throw new Error('Usage: node scripts/stratz-matchup-root-cause-research.mjs <analyze|compose|reconcile|batch-control|check>');
}

if (process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[STRATZ root-cause research] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
