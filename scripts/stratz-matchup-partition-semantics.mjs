#!/usr/bin/env node
// TZ #76-FIX13: production bracket partition proof & matchup win-rate semantics.
//
// Fully offline. Re-analyses the FIX12 raw STRATZ responses that are already on
// disk; it never creates a transport and never issues a network request. All
// FIX9–FIX12 artifacts and production datasets are read-only inputs whose
// physical SHA-256 is verified before and after the analysis.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Production configuration is the single source of the bracket groups.
import { BRACKETS } from './update-data-stratz.mjs';
import { diagnosePair } from './stratz-matchup-asymmetry-lib.mjs';
import { canonicalJsonSha256 } from './stratz-matchup-root-cause-research.mjs';
import { normalizedResponseSha256 } from './stratz-matchup-bracket-semantics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PARTITION_EVIDENCE_PATH = path.join(
  ROOT,
  'research/data-quality/stratz-reverse-pair-partition-semantics-evidence.json',
);

/** The four production bracket groups, taken from production configuration. */
export const PRODUCTION_BRACKETS = Object.freeze([...BRACKETS]);

export const FIX13_FOCUS_PAIRS = Object.freeze([
  '58:61',
  '61:79',
  '47:89',
  '59:89',
  '58:83',
]);

export const PARTITION_FIELDS = Object.freeze([
  'matchCountAtoB',
  'matchCountBtoA',
  'winCountAtoB',
  'winCountBtoA',
]);

const SOURCE_PATHS = Object.freeze({
  fix9Input: 'scripts/stratz-diagnostic-input.json',
  fix10Repeatability: 'research/data-quality/stratz-reverse-pair-repeatability-evidence.json',
  fix10Report: 'research/data-quality/stratz-reverse-pair-asymmetry-report.json',
  fix11Evidence: 'research/data-quality/stratz-reverse-pair-root-cause-evidence.json',
  fix11Raw: 'research/data-quality/stratz-reverse-pair-root-cause-raw-responses.json',
  fix12Evidence: 'research/data-quality/stratz-reverse-pair-bracket-semantics-evidence.json',
  fix12Raw: 'research/data-quality/stratz-reverse-pair-bracket-raw-responses.json',
  productionHeroes: 'public/data/heroes.json',
  productionMatchups: 'public/data/matchups.json',
  productionMeta: 'public/data/meta.json',
});

export const EXPECTED_PHYSICAL_SHA256 = Object.freeze({
  fix9Input: '291350d18a0195dfa9b2292b08a832267234dac6b8b16b8f045c71cd5afba002',
  fix10Repeatability: '278c740c10747da0c91642cd02efb5ebaca741c8b935a6d6b8b771420d89978e',
  fix10Report: 'ef5e27a1ca55cb1876d210027ff58c2f4a11f7f35ca3c24f9754ad71f584cf95',
  fix11Evidence: '7ed6d5daac42dbcc19995caf5518518ccac3ef6de42a4fd62c7468af7363494b',
  fix11Raw: '0e426ac478489e23e1d35cd1336fe2487ab101364ff8b041f433714c1ccf6e7b',
  fix12Evidence: '0a1953f079b6a94fbade6cbad77a16d6423fe829af1a003440b5b8f9ecc9a0be',
  fix12Raw: '5db0fed846569d45b7c55f4cd5a8cbcc6de2c3e2963b2c098de723b3e5542a74',
  productionHeroes: '59ecc2bc9b55a62232bf7d40b85c1d4c306602e89addda6d3faa9ed38a2c061d',
  productionMatchups: '0a9e54aaa925494f7ad876c992e782cfd45d297b3952c8afefb8decc3ad02e8b',
  productionMeta: '9db099dedf5c5f0d052590d98d194807e2580a16694fc562ae9ffbf1d144857e',
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// ---------------------------------------------------------------------------
// Source protection
// ---------------------------------------------------------------------------

export function captureSourceHashes(read = readFileSync, root = ROOT) {
  return Object.fromEntries(Object.entries(SOURCE_PATHS).map(([name, relative]) => [
    name,
    { path: relative, physicalSha256: sha256(read(path.join(root, relative))) },
  ]));
}

export function verifySourceHashes(hashes, expected = EXPECTED_PHYSICAL_SHA256) {
  const mismatches = Object.entries(expected)
    .filter(([name, sha]) => hashes[name]?.physicalSha256 !== sha)
    .map(([name]) => name);
  if (mismatches.length) {
    throw new Error(`Protected source hash mismatch: ${mismatches.join(', ')}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Raw response extraction
// ---------------------------------------------------------------------------

export const individualFilterId = (bracket) => `individual:${bracket}`;

/**
 * Extract the directed pair rows for every bucket. A direction is `null` when
 * absent; duplicated directions are reported and never silently collapsed.
 */
export function extractDirectionRows(response, pair, buckets) {
  return buckets.map((bucket) => {
    const dryads = response?.data?.heroStats?.[`w${bucket}`];
    const pick = (heroId1, heroId2) => {
      if (!Array.isArray(dryads)) return { row: null, duplicateCount: 0 };
      const rows = dryads
        .filter((dryad) => dryad.heroId === heroId1)
        .flatMap((dryad) => dryad.vs ?? [])
        .filter((row) => row.heroId1 === heroId1 && row.heroId2 === heroId2);
      return { row: rows.length === 1 ? rows[0] : null, duplicateCount: rows.length };
    };
    const a = pick(pair.heroAId, pair.heroBId);
    const b = pick(pair.heroBId, pair.heroAId);
    return {
      bucket,
      bucketPresent: Array.isArray(dryads),
      AtoB: a.row,
      BtoA: b.row,
      duplicateAtoB: a.duplicateCount > 1,
      duplicateBtoA: b.duplicateCount > 1,
    };
  });
}

// ---------------------------------------------------------------------------
// §3 Production bracket partition verification
// ---------------------------------------------------------------------------

const FIELD_SOURCE = Object.freeze({
  matchCountAtoB: ['AtoB', 'matchCount'],
  matchCountBtoA: ['BtoA', 'matchCount'],
  winCountAtoB: ['AtoB', 'winCount'],
  winCountBtoA: ['BtoA', 'winCount'],
});

const integerOrNull = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

function fieldValue(directions, field) {
  const [direction, key] = FIELD_SOURCE[field];
  return integerOrNull(directions?.[direction]?.[key]);
}

/**
 * Compare the production result against the sum of the individual production
 * bracket groups for one pair-week. Missing values are never treated as zero.
 *
 * @param {{AtoB:object|null,BtoA:object|null}|null} production
 * @param {Record<string,{AtoB:object|null,BtoA:object|null}|null>} groups keyed by bracket
 * @param {string[]} brackets
 */
export function verifyPairWeekPartition(production, groups, brackets = PRODUCTION_BRACKETS) {
  const fields = {};
  const missing = [];
  for (const field of PARTITION_FIELDS) {
    const productionValue = fieldValue(production, field);
    const groupValues = brackets.map((bracket) => ({
      bracket,
      value: fieldValue(groups?.[bracket], field),
    }));
    if (productionValue === null) missing.push({ source: 'production', field });
    for (const item of groupValues) {
      if (item.value === null) missing.push({ source: item.bracket, field });
    }
    const complete = productionValue !== null && groupValues.every((item) => item.value !== null);
    const sum = complete ? groupValues.reduce((total, item) => total + item.value, 0) : null;
    fields[field] = {
      production: productionValue,
      groups: groupValues,
      groupSum: sum,
      difference: complete ? sum - productionValue : null,
      status: !complete ? 'INCOMPLETE' : sum === productionValue ? 'PASS' : 'FAILED',
    };
  }
  const statuses = Object.values(fields).map((item) => item.status);
  return {
    status: statuses.includes('FAILED') ? 'FAILED'
      : statuses.includes('INCOMPLETE') ? 'INCOMPLETE' : 'PASS',
    fields,
    missing,
  };
}

export function summarizePartition(rows) {
  const complete = rows.filter((row) => row.status !== 'INCOMPLETE');
  const matching = (field) => rows.filter((row) => row.fields[field].status === 'PASS').length;
  const pairs = new Set(rows.map((row) => row.canonicalPairId));
  const buckets = new Set(rows.map((row) => row.bucket));
  const failed = rows.filter((row) => row.status === 'FAILED').length;
  const incomplete = rows.length - complete.length;
  return {
    status: rows.length === 0 ? 'UNVERIFIED'
      : failed > 0 ? 'FAILED'
        : incomplete > 0 ? 'INCOMPLETE'
          : 'PROVEN_ON_SAMPLE',
    statusMeaning: 'PROVEN_ON_SAMPLE means empirical additivity of the production bracket groups in this sample only; it is not a general STRATZ API contract.',
    pairCount: pairs.size,
    bucketCount: buckets.size,
    pairWeekObservations: rows.length,
    completePairBucketCount: complete.length,
    incompletePairBucketCount: incomplete,
    failedPairBucketCount: failed,
    matchingGamesAtoB: matching('matchCountAtoB'),
    matchingGamesBtoA: matching('matchCountBtoA'),
    matchingWinsAtoB: matching('winCountAtoB'),
    matchingWinsBtoA: matching('winCountBtoA'),
  };
}

// ---------------------------------------------------------------------------
// §4 winsAverage vs winCount / matchCount
// ---------------------------------------------------------------------------

/** Number of decimal places in the shortest round-trip representation. */
export function decimalPlaces(value) {
  const text = String(value).toLowerCase();
  const [mantissa, exponentText] = text.split('e');
  return Math.max(0, (mantissa.split('.')[1]?.length ?? 0) - Number(exponentText ?? 0));
}

function parseDecimal(value) {
  if (value === null || value === undefined) return { kind: 'MISSING' };
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { kind: 'OK', value, text: String(value) } : { kind: 'NON_NUMERIC' };
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return { kind: 'OK', value: Number(value), text: value.trim() };
  }
  return { kind: 'NON_NUMERIC' };
}

/**
 * Compare a reported winsAverage with winCount / matchCount. Tolerance is
 * derived from the decimal precision actually present on the reported value,
 * i.e. half a unit in its last reported decimal place (scaled for 0–100).
 */
export function compareWinsAverage(row) {
  const matchCount = parseDecimal(row?.matchCount);
  const winCount = parseDecimal(row?.winCount);
  const average = parseDecimal(row?.winsAverage);
  const base = {
    matchCount: matchCount.value ?? row?.matchCount ?? null,
    winCount: winCount.value ?? row?.winCount ?? null,
    winsAverage: average.value ?? row?.winsAverage ?? null,
    computedWinRatio: null,
    absoluteDifference: null,
    roundingTolerance: null,
    decimalPlaces: null,
    scale: null,
    matches: null,
  };
  const invalid = (validity) => ({ ...base, validity });
  if ([matchCount, winCount, average].some((item) => item.kind === 'MISSING')) {
    return invalid('MISSING_VALUE');
  }
  if ([matchCount, winCount, average].some((item) => item.kind === 'NON_NUMERIC')) {
    return invalid('NON_NUMERIC');
  }
  if (matchCount.value < 0 || winCount.value < 0 || average.value < 0) {
    return invalid('INVALID_NEGATIVE');
  }
  if (!Number.isInteger(matchCount.value) || !Number.isInteger(winCount.value)) {
    return invalid('NON_INTEGER_COUNT');
  }
  if (matchCount.value === 0) return invalid('ZERO_MATCH_COUNT');
  if (winCount.value > matchCount.value) return invalid('WIN_COUNT_EXCEEDS_MATCH_COUNT');
  if (average.value > 100) return invalid('OUT_OF_RANGE');
  const scale = average.value <= 1 ? '0-1' : '0-100';
  const places = decimalPlaces(average.text);
  const normalized = scale === '0-100' ? average.value / 100 : average.value;
  const computed = winCount.value / matchCount.value;
  const tolerance = (0.5 * (10 ** -places)) / (scale === '0-100' ? 100 : 1);
  const difference = Math.abs(normalized - computed);
  return {
    ...base,
    computedWinRatio: computed,
    absoluteDifference: difference,
    roundingTolerance: tolerance,
    decimalPlaces: places,
    scale,
    // Small epsilon only absorbs binary floating-point representation error.
    matches: difference <= tolerance + 1e-12,
    validity: 'VALID',
  };
}

const countBy = (items, key) => {
  const result = {};
  for (const item of items) {
    const value = String(key(item));
    result[value] = (result[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) =>
    a.localeCompare(b, undefined, { numeric: true })));
};

export function summarizeWinsAverage(comparisons) {
  const valid = comparisons.filter((item) => item.validity === 'VALID');
  const invalid = comparisons.filter((item) => item.validity !== 'VALID');
  const matching = valid.filter((item) => item.matches);
  const mismatching = valid.filter((item) => !item.matches);
  const fieldPrecision = valid.length ? Math.max(...valid.map((item) => item.decimalPlaces)) : null;
  const status = valid.length === 0 ? 'UNVERIFIED'
    : mismatching.length > 0 ? 'CONTRADICTED'
      : invalid.length > 0 ? 'SUPPORTED'
        : 'EMPIRICALLY_CONFIRMED_AS_WIN_RATIO_ON_SAMPLE';
  return {
    status,
    statusMeaning: {
      EMPIRICALLY_CONFIRMED_AS_WIN_RATIO_ON_SAMPLE: 'Every relevant row is valid and matches winCount / matchCount within its reported rounding.',
      SUPPORTED: 'All valid rows match, but some relevant rows could not be checked.',
      CONTRADICTED: 'At least one valid row differs from winCount / matchCount beyond its reported rounding.',
      UNVERIFIED: 'No valid row was available.',
    }[status],
    schemaContract: 'NOT_ESTABLISHED — GraphQL description for winsAverage is null.',
    relevantRows: comparisons.length,
    validRows: valid.length,
    invalidRows: invalid.length,
    invalidReasons: countBy(invalid, (item) => item.validity),
    matchingWinRatioRows: matching.length,
    mismatchingRows: mismatching.length,
    precisionDistribution: countBy(valid, (item) => item.decimalPlaces),
    scaleDistribution: countBy(valid, (item) => item.scale),
    inferredFieldPrecision: fieldPrecision,
    rowsBelowFieldPrecision: fieldPrecision === null ? 0
      : valid.filter((item) => item.decimalPlaces < fieldPrecision).length,
    rowsBelowFieldPrecisionNote: 'A value such as 0.46 may be a 3-decimal 0.460 with the trailing zero dropped by JSON; it is checked against its own (looser) reported precision and also against the field precision below.',
    matchingAtFieldPrecision: fieldPrecision === null ? 0
      : valid.filter((item) => item.absoluteDifference
        <= ((0.5 * 10 ** -fieldPrecision) / (item.scale === '0-100' ? 100 : 1)) + 1e-12).length,
    maximumRoundingDifference: valid.length
      ? Math.max(...valid.map((item) => item.absoluteDifference)) : null,
    maximumAllowedRoundingError: valid.length
      ? Math.max(...valid.map((item) => item.roundingTolerance)) : null,
    mismatches: mismatching,
  };
}

// ---------------------------------------------------------------------------
// §5 Rate field alignment (each field separately)
// ---------------------------------------------------------------------------

function rateAgainst(rate, expected) {
  const parsed = parseDecimal(rate);
  if (parsed.kind !== 'OK' || parsed.value < 0 || parsed.value > 100) return null;
  const scale = parsed.value <= 1 ? '0-1' : '0-100';
  const normalized = scale === '0-100' ? parsed.value / 100 : parsed.value;
  const tolerance = (0.5 * 10 ** -decimalPlaces(parsed.text)) / (scale === '0-100' ? 100 : 1);
  return Math.abs(normalized - expected) <= tolerance + 1e-12;
}

export function rateFieldAlignment(rows, field) {
  let compared = 0;
  let winRatio = 0;
  let complement = 0;
  for (const row of rows) {
    const { matchCount, winCount } = row;
    if (!Number.isSafeInteger(matchCount) || matchCount <= 0 || !Number.isSafeInteger(winCount)) continue;
    const vsRatio = rateAgainst(row[field], winCount / matchCount);
    const vsComplement = rateAgainst(row[field], (matchCount - winCount) / matchCount);
    if (vsRatio === null || vsComplement === null) continue;
    compared += 1;
    if (vsRatio) winRatio += 1;
    if (vsComplement) complement += 1;
  }
  const classify = (count) => (compared === 0 ? 'UNVERIFIED'
    : count === compared ? 'ALIGNED_ON_SAMPLE'
      : count === 0 ? 'NOT_ALIGNED_ON_SAMPLE' : 'NOT_ALIGNED_ON_SAMPLE_INCIDENTAL_MATCHES');
  return {
    field,
    comparedRows: compared,
    alignedWithWinRatio: { matches: winRatio, status: classify(winRatio) },
    alignedWithComplementRatio: { matches: complement, status: classify(complement) },
  };
}

/**
 * Descriptive check of whether a rate field is constant for a given hero within
 * one response bucket, irrespective of the opponent (i.e. behaves like a
 * hero-level rather than pair-level value).
 */
export function rateConstancyByHero(responses, field, heroKey) {
  let groups = 0;
  let constant = 0;
  let multiRowGroups = 0;
  let multiRowConstant = 0;
  for (const { response } of responses) {
    for (const [bucket, dryads] of Object.entries(response?.data?.heroStats ?? {})) {
      const values = new Map();
      for (const row of (Array.isArray(dryads) ? dryads : []).flatMap((dryad) => dryad.vs ?? [])) {
        const key = row[heroKey];
        if (!values.has(key)) values.set(key, []);
        values.get(key).push(row[field]);
      }
      for (const list of values.values()) {
        groups += 1;
        const isConstant = new Set(list).size === 1;
        if (isConstant) constant += 1;
        if (list.length > 1) {
          multiRowGroups += 1;
          if (isConstant) multiRowConstant += 1;
        }
      }
    }
  }
  return {
    field,
    groupedBy: `${heroKey} within one response bucket`,
    groups,
    constantGroups: constant,
    groupsWithMultipleRows: multiRowGroups,
    constantGroupsWithMultipleRows: multiRowConstant,
  };
}

/** Does winRateHeroId2 on row A→B equal winRateHeroId1 on row B→A? */
export function reverseRateCorrespondence(directionPairs) {
  let compared = 0;
  let equal = 0;
  for (const { AtoB, BtoA } of directionPairs) {
    if (!AtoB || !BtoA) continue;
    for (const [left, right] of [[AtoB, BtoA], [BtoA, AtoB]]) {
      if (left.winRateHeroId2 === undefined || right.winRateHeroId1 === undefined) continue;
      compared += 1;
      if (left.winRateHeroId2 === right.winRateHeroId1) equal += 1;
    }
  }
  return { comparedDirectedRows: compared, winRateHeroId2EqualsReverseWinRateHeroId1: equal };
}

// ---------------------------------------------------------------------------
// §6 Rank-level asymmetry contribution
// ---------------------------------------------------------------------------

const sign = (value) => (value > 0 ? 1 : value < 0 ? -1 : 0);

function directionStats(pair, directions) {
  const gamesAtoB = integerOrNull(directions?.AtoB?.matchCount);
  const gamesBtoA = integerOrNull(directions?.BtoA?.matchCount);
  const winsAtoB = integerOrNull(directions?.AtoB?.winCount);
  const winsBtoA = integerOrNull(directions?.BtoA?.winCount);
  if ([gamesAtoB, gamesBtoA, winsAtoB, winsBtoA].includes(null)) {
    return {
      status: 'INCOMPLETE',
      gamesAtoB,
      gamesBtoA,
      winsAtoB,
      winsBtoA,
      signedDelta: null,
      absoluteDelta: null,
      relativeDeltaA: null,
      relativeDeltaB: null,
      directionSign: null,
      thresholdExceeded: null,
    };
  }
  // Production threshold formula, unchanged (stratz-matchup-asymmetry-lib diagnosePair).
  const diagnosis = diagnosePair(pair.heroAId, pair.heroBId, gamesAtoB, winsAtoB, gamesBtoA, winsBtoA);
  const signedDelta = gamesAtoB - gamesBtoA;
  return {
    status: 'COMPLETE',
    gamesAtoB,
    gamesBtoA,
    winsAtoB,
    winsBtoA,
    signedDelta,
    absoluteDelta: diagnosis.absoluteGamesDelta,
    relativeDeltaA: diagnosis.relativeDeltaA,
    relativeDeltaB: diagnosis.relativeDeltaB,
    directionSign: sign(signedDelta),
    thresholdExceeded: diagnosis.thresholdExceeded,
  };
}

export function rankContributionForPairWeek(pair, bucket, production, groups, brackets = PRODUCTION_BRACKETS) {
  const productionStats = directionStats(pair, production);
  const groupStats = brackets.map((bracket) => ({
    bracket,
    ...directionStats(pair, groups?.[bracket]),
  }));
  const complete = productionStats.status === 'COMPLETE'
    && groupStats.every((item) => item.status === 'COMPLETE');
  const base = {
    canonicalPairId: pair.canonicalPairId,
    heroAId: pair.heroAId,
    heroBId: pair.heroBId,
    bucket,
    fix11AnomalyBucket: (pair.anomalyBuckets ?? []).includes(bucket),
    production: productionStats,
    groups: groupStats,
  };
  if (!complete) {
    return {
      ...base,
      status: 'INCOMPLETE',
      groupSignedDeltaSum: null,
      decompositionMatchesProduction: null,
      direction: null,
    };
  }
  const groupSum = groupStats.reduce((total, item) => total + item.signedDelta, 0);
  const signs = groupStats.map((item) => item.directionSign);
  const nonZero = signs.filter((value) => value !== 0);
  const mixed = nonZero.includes(1) && nonZero.includes(-1);
  const absoluteSum = groupStats.reduce((total, item) => total + Math.abs(item.signedDelta), 0);
  const productionSign = productionStats.directionSign;
  const withShares = groupStats.map((item) => ({
    ...item,
    shareOfProductionSignedDelta: productionStats.signedDelta === 0 ? null
      : item.signedDelta / productionStats.signedDelta,
    opposesProductionDirection: productionSign !== 0 && item.directionSign === -productionSign,
  }));
  const maxAbs = Math.max(...groupStats.map((item) => Math.abs(item.signedDelta)));
  const groupsExceeding = groupStats.filter((item) => item.thresholdExceeded).map((item) => item.bracket);
  return {
    ...base,
    groups: withShares,
    status: 'COMPLETE',
    groupSignedDeltaSum: groupSum,
    decompositionMatchesProduction: groupSum === productionStats.signedDelta,
    direction: {
      groupSigns: Object.fromEntries(groupStats.map((item) => [item.bracket, item.directionSign])),
      allGroupsSameNonZeroSign: nonZero.length === groupStats.length && !mixed,
      mixedSigns: mixed,
      zeroDeltaGroups: groupStats.filter((item) => item.directionSign === 0).map((item) => item.bracket),
      groupsOpposingProduction: withShares.filter((item) => item.opposesProductionDirection)
        .map((item) => item.bracket),
      largestAbsoluteContributors: groupStats.filter((item) => Math.abs(item.signedDelta) === maxAbs)
        .map((item) => item.bracket),
      // Magnitude cancelled when group deltas of opposite sign are summed.
      compensatedMagnitude: absoluteSum - Math.abs(groupSum),
      compensationObserved: absoluteSum - Math.abs(groupSum) > 0,
    },
    thresholds: {
      productionThresholdExceeded: productionStats.thresholdExceeded,
      groupsExceedingThreshold: groupsExceeding,
      aggregatePassesWhileGroupFails: !productionStats.thresholdExceeded && groupsExceeding.length > 0,
      aggregateFailsWhileNoGroupFails: productionStats.thresholdExceeded && groupsExceeding.length === 0,
    },
  };
}

export function summarizeDirectionConsistency(rows, brackets = PRODUCTION_BRACKETS) {
  const complete = rows.filter((row) => row.status === 'COMPLETE');
  const perGroup = Object.fromEntries(brackets.map((bracket) => {
    const items = complete.map((row) => row.groups.find((group) => group.bracket === bracket));
    return [bracket, {
      totalSignedDelta: items.reduce((total, item) => total + item.signedDelta, 0),
      totalAbsoluteDelta: items.reduce((total, item) => total + item.absoluteDelta, 0),
      positiveWeeks: items.filter((item) => item.directionSign > 0).length,
      negativeWeeks: items.filter((item) => item.directionSign < 0).length,
      zeroWeeks: items.filter((item) => item.directionSign === 0).length,
      largestContributorWeeks: complete.filter((row) =>
        row.direction.largestAbsoluteContributors.includes(bracket)).length,
      opposesProductionWeeks: complete.filter((row) =>
        row.direction.groupsOpposingProduction.includes(bracket)).length,
      thresholdExceededWeeks: items.filter((item) => item.thresholdExceeded).length,
    }];
  }));
  const ids = (predicate) => complete.filter(predicate).map((row) => `${row.canonicalPairId}@${row.bucket}`);
  return {
    pairWeekRows: rows.length,
    completePairWeekRows: complete.length,
    incompletePairWeekRows: rows.length - complete.length,
    decompositionMatchesProduction: complete.filter((row) => row.decompositionMatchesProduction).length,
    allGroupsSameNonZeroSign: ids((row) => row.direction.allGroupsSameNonZeroSign).length,
    mixedSignPairWeeks: ids((row) => row.direction.mixedSigns),
    pairWeeksWithZeroDeltaGroup: ids((row) => row.direction.zeroDeltaGroups.length > 0),
    compensationPairWeeks: ids((row) => row.direction.compensationObserved),
    productionThresholdExceeded: ids((row) => row.thresholds.productionThresholdExceeded),
    aggregatePassesWhileGroupFails: ids((row) => row.thresholds.aggregatePassesWhileGroupFails),
    aggregateFailsWhileNoGroupFails: ids((row) => row.thresholds.aggregateFailsWhileNoGroupFails),
    fix11AnomalyPairWeeks: {
      total: complete.filter((row) => row.fix11AnomalyBucket).length,
      allGroupsSameNonZeroSign: complete.filter((row) =>
        row.fix11AnomalyBucket && row.direction.allGroupsSameNonZeroSign).length,
      mixedSigns: complete.filter((row) => row.fix11AnomalyBucket && row.direction.mixedSigns).length,
    },
    perGroup,
    note: 'Descriptive contribution analysis only. Rank-group decomposition does not establish the cause of the reverse-pair asymmetry.',
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const comparePairIds = (a, b) => a.localeCompare(b, undefined, { numeric: true });

/** Rebuild the per-pair, per-filter extracted rows from the FIX12 raw archive. */
export function loadFix12Observations(fix12Evidence, fix12Raw) {
  const buckets = fix12Evidence.productionParameters.buckets;
  const pairs = fix12Evidence.selectedPairs.map((pair) => ({
    canonicalPairId: pair.canonicalPairId,
    heroAId: pair.heroAId,
    heroBId: pair.heroBId,
    heroA: pair.heroA,
    heroB: pair.heroB,
    anomalyBuckets: pair.buckets,
  }));
  const filterOrder = fix12Evidence.filterConfigurations.map((config) => config.id);
  const requests = fix12Evidence.querySummary.requests.filter((request) => request.filterId);
  const results = [];
  const references = [];
  for (const request of requests) {
    const saved = fix12Raw.queryResponses[request.requestId];
    const pair = pairs.find((item) => item.canonicalPairId === request.canonicalPairId);
    const queryHashVerified = saved ? sha256(saved.query) === request.requestHash : false;
    const responseHashVerified = saved
      ? normalizedResponseSha256(saved.response) === request.responseHash
        && saved.responseSha256 === request.responseHash
      : false;
    references.push({
      requestId: request.requestId,
      canonicalPairId: request.canonicalPairId,
      filterId: request.filterId,
      brackets: request.brackets,
      requestStatus: request.status,
      queryHash: request.requestHash,
      responseHash: request.responseHash,
      presentInRawArtifact: Boolean(saved),
      queryHashVerified,
      responseHashVerified,
    });
    if (!saved || !pair) continue;
    if (!queryHashVerified || !responseHashVerified) {
      throw new Error(`FIX12 raw response hash mismatch: ${request.requestId}`);
    }
    results.push({
      canonicalPairId: pair.canonicalPairId,
      filterId: request.filterId,
      requestId: request.requestId,
      response: saved.response,
      perBucket: extractDirectionRows(saved.response, pair, buckets),
    });
  }
  results.sort((a, b) => comparePairIds(a.canonicalPairId, b.canonicalPairId)
    || filterOrder.indexOf(a.filterId) - filterOrder.indexOf(b.filterId));
  references.sort((a, b) => comparePairIds(a.canonicalPairId, b.canonicalPairId)
    || filterOrder.indexOf(a.filterId) - filterOrder.indexOf(b.filterId));
  return { buckets, pairs, results, references, filterOrder };
}

const bucketRows = (results, pairId, filterId, bucket) => {
  const result = results.find((item) => item.canonicalPairId === pairId && item.filterId === filterId);
  const entry = result?.perBucket.find((item) => item.bucket === bucket);
  if (!entry) return null;
  return {
    AtoB: entry.duplicateAtoB ? null : entry.AtoB,
    BtoA: entry.duplicateBtoA ? null : entry.BtoA,
  };
};

/** The same pair-specific row set FIX12 used (all filters, present non-duplicate directions). */
export function pairSpecificRows(observations) {
  const rows = [];
  for (const result of observations.results) {
    const pair = observations.pairs.find((item) => item.canonicalPairId === result.canonicalPairId);
    for (const entry of result.perBucket) {
      for (const [direction, heroId1, heroId2, row, duplicate] of [
        ['AtoB', pair.heroAId, pair.heroBId, entry.AtoB, entry.duplicateAtoB],
        ['BtoA', pair.heroBId, pair.heroAId, entry.BtoA, entry.duplicateBtoA],
      ]) {
        if (!row || duplicate) continue;
        rows.push({
          canonicalPairId: pair.canonicalPairId,
          filterId: result.filterId,
          bucket: entry.bucket,
          direction,
          heroId1,
          heroId2,
          matchCount: row.matchCount,
          winCount: row.winCount,
          winsAverage: row.winsAverage,
          winRateHeroId1: row.winRateHeroId1,
          winRateHeroId2: row.winRateHeroId2,
        });
      }
    }
  }
  return rows;
}

function specialEnumObservations(observations) {
  const rows = [];
  const pairs = [...observations.pairs].sort((a, b) => comparePairIds(a.canonicalPairId, b.canonicalPairId));
  for (const pair of pairs) {
    for (const bucket of observations.buckets) {
      const production = bucketRows(observations.results, pair.canonicalPairId, 'production', bucket);
      const entry = { canonicalPairId: pair.canonicalPairId, bucket };
      for (const filterId of observations.filterOrder.filter((id) =>
        id !== 'production' && !PRODUCTION_BRACKETS.map(individualFilterId).includes(id))) {
        const rowsForFilter = bucketRows(observations.results, pair.canonicalPairId, filterId, bucket);
        const present = Boolean(rowsForFilter?.AtoB && rowsForFilter?.BtoA);
        entry[filterId] = {
          bothDirectionsPresent: present,
          equalsProductionCounts: present && Boolean(production?.AtoB && production?.BtoA)
            ? rowsForFilter.AtoB.matchCount === production.AtoB.matchCount
              && rowsForFilter.BtoA.matchCount === production.BtoA.matchCount
              && rowsForFilter.AtoB.winCount === production.AtoB.winCount
              && rowsForFilter.BtoA.winCount === production.BtoA.winCount
            : null,
        };
      }
      rows.push(entry);
    }
  }
  const filterIds = Object.keys(rows[0] ?? {}).filter((key) => key !== 'canonicalPairId' && key !== 'bucket');
  return Object.fromEntries(filterIds.map((filterId) => [filterId, {
    pairWeeks: rows.length,
    bothDirectionsPresent: rows.filter((row) => row[filterId].bothDirectionsPresent).length,
    equalsProductionCounts: rows.filter((row) => row[filterId].equalsProductionCounts === true).length,
    missingPairWeeks: rows.filter((row) => !row[filterId].bothDirectionsPresent)
      .map((row) => `${row.canonicalPairId}@${row.bucket}`),
  }]));
}

function range(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length ? { min: Math.min(...finite), max: Math.max(...finite) } : null;
}

export function buildPartitionSemanticsEvidence({ fix12Evidence, fix12Raw, sourceHashes }) {
  if (fix12Evidence.rootCause?.status !== 'UNRESOLVED'
    || fix12Evidence.rootCause?.productionPublishAllowed !== false) {
    throw new Error('FIX12 evidence is not the protected unresolved record');
  }
  if (canonicalJsonSha256(fix12Evidence, 'evidenceSha256') !== fix12Evidence.evidenceSha256) {
    throw new Error('FIX12 evidence canonical hash mismatch');
  }
  const observations = loadFix12Observations(fix12Evidence, fix12Raw);
  const { pairs, buckets, results } = observations;
  const orderedPairs = [...pairs].sort((a, b) => comparePairIds(a.canonicalPairId, b.canonicalPairId));

  // §3 Partition
  const partitionRows = [];
  const contributionRows = [];
  for (const pair of orderedPairs) {
    for (const bucket of buckets) {
      const production = bucketRows(results, pair.canonicalPairId, 'production', bucket);
      const groups = Object.fromEntries(PRODUCTION_BRACKETS.map((bracket) => [
        bracket,
        bucketRows(results, pair.canonicalPairId, individualFilterId(bracket), bucket),
      ]));
      partitionRows.push({
        canonicalPairId: pair.canonicalPairId,
        bucket,
        ...verifyPairWeekPartition(production, groups),
      });
      contributionRows.push(rankContributionForPairWeek(pair, bucket, production, groups));
    }
  }
  const partitionSummary = summarizePartition(partitionRows);

  // §4 winsAverage
  const rateRows = pairSpecificRows(observations);
  const winsAverageComparisons = rateRows.map((row) => ({
    canonicalPairId: row.canonicalPairId,
    filterId: row.filterId,
    bucket: row.bucket,
    direction: row.direction,
    ...compareWinsAverage(row),
  }));
  const winsAverageSummary = summarizeWinsAverage(winsAverageComparisons);
  const uniqueRowKeys = new Set(rateRows.map((row) => [
    row.canonicalPairId, row.bucket, row.direction, row.matchCount, row.winCount, row.winsAverage,
  ].join('|')));

  // §5 Field semantics
  const productionResponses = results.filter((item) => item.filterId === 'production');
  const productionDirections = productionResponses.flatMap((item) => item.perBucket);
  const schemaFields = fix12Evidence.schemaIntrospection.schema.matchupRow.fields;
  const completeProduction = contributionRows.filter((row) => row.production.status === 'COMPLETE');
  const winSumRows = completeProduction.map((row) => {
    const { gamesAtoB, gamesBtoA, winsAtoB, winsBtoA } = row.production;
    return winsAtoB + winsBtoA - (gamesAtoB + gamesBtoA) / 2;
  });
  const hero1 = rateFieldAlignment(rateRows, 'winRateHeroId1');
  const hero2 = rateFieldAlignment(rateRows, 'winRateHeroId2');
  const fix12RankPartition = fix12Evidence.rankPartitionCheck;
  const fieldSemantics = {
    matchCount: {
      graphqlType: schemaFields.matchCount?.graphqlType ?? null,
      schemaDescription: schemaFields.matchCount?.description ?? null,
      reverseDirectionConsistency: {
        productionPairWeeks: completeProduction.length,
        equalReverseCounts: completeProduction.filter((row) => row.production.signedDelta === 0).length,
        productionThresholdExceeded: completeProduction.filter((row) =>
          row.production.thresholdExceeded).length,
        status: 'NOT_SYMMETRIC_ON_SAMPLE',
        note: 'No schema-level invariant requires reverse-direction equality (FIX12).',
      },
      bracketPartitionBehaviour: {
        productionGroupsAtoB: `${partitionSummary.matchingGamesAtoB}/${partitionSummary.pairWeekObservations}`,
        productionGroupsBtoA: `${partitionSummary.matchingGamesBtoA}/${partitionSummary.pairWeekObservations}`,
        status: partitionSummary.status,
      },
      knownLimitations: [
        'Schema description is null; meaning is inferred only from the matchLimit argument description.',
        'Additivity is empirical for 8 pairs × 4 weeks and production brackets only.',
      ],
    },
    winCount: {
      graphqlType: schemaFields.winCount?.graphqlType ?? null,
      schemaDescription: schemaFields.winCount?.description ?? null,
      observedRange: range(rateRows.map((row) => row.winCount)),
      observedMatchCountRange: range(rateRows.map((row) => row.matchCount)),
      winCountNeverExceedsMatchCount: rateRows.every((row) => row.winCount <= row.matchCount),
      relationToWinsAverage: {
        status: winsAverageSummary.status,
        matching: `${winsAverageSummary.matchingWinRatioRows}/${winsAverageSummary.relevantRows}`,
      },
      rateFieldAlignment: {
        winRateHeroId1VsWinRatio: hero1.alignedWithWinRatio,
        winRateHeroId2VsComplementRatio: hero2.alignedWithComplementRatio,
      },
      productionReverseWinSum: {
        description: 'winsAtoB + winsBtoA − mean(gamesAtoB, gamesBtoA) on production rows; 0 if winCount is heroId1 wins and both directions count the same matches.',
        pairWeeks: winSumRows.length,
        range: range(winSumRows),
        exactZero: winSumRows.filter((value) => value === 0).length,
      },
      semanticStatus: 'UNVERIFIED',
      semanticNote: 'winCount is the numerator of winsAverage on every sampled row, and reverse-direction wins approximately complement each other, which is consistent with "heroId1 wins". This is not exact and the schema gives no description, so the semantics remain unverified.',
    },
    winRateHeroId1: {
      graphqlType: schemaFields.winRateHeroId1?.graphqlType ?? null,
      schemaDescription: schemaFields.winRateHeroId1?.description ?? null,
      ...hero1,
      constancy: rateConstancyByHero(productionResponses, 'winRateHeroId1', 'heroId1'),
      semanticStatus: 'NOT_A_PAIR_WIN_RATIO_ON_SAMPLE',
      semanticNote: 'Does not track the pair-specific win ratio. It is observed to be constant per heroId1 across opponents within a response bucket, consistent with a hero-level aggregate; that reading is not confirmed by the schema.',
    },
    winRateHeroId2: {
      graphqlType: schemaFields.winRateHeroId2?.graphqlType ?? null,
      schemaDescription: schemaFields.winRateHeroId2?.description ?? null,
      ...hero2,
      constancy: rateConstancyByHero(productionResponses, 'winRateHeroId2', 'heroId2'),
      reverseCorrespondence: reverseRateCorrespondence(productionDirections),
      semanticStatus: 'NOT_A_PAIR_COMPLEMENT_RATIO_ON_SAMPLE',
      semanticNote: 'Does not track the pair-specific complement ratio. Observed relationships to winRateHeroId1 are descriptive only.',
    },
    winsAverage: {
      graphqlType: schemaFields.winsAverage?.graphqlType ?? null,
      schemaDescription: schemaFields.winsAverage?.description ?? null,
      semanticStatus: winsAverageSummary.status,
    },
  };

  // §6 Contribution
  const directionConsistencySummary = summarizeDirectionConsistency(contributionRows);

  // §7 Conclusions
  const specialEnums = specialEnumObservations(observations);
  const anyGroupNonZero = contributionRows.some((row) => row.status === 'COMPLETE'
    && row.groups.some((group) => group.signedDelta !== 0));
  const thresholdOutcomeDiffers = contributionRows.some((row) => row.status === 'COMPLETE'
    && row.groups.some((group) => group.thresholdExceeded !== row.production.thresholdExceeded));
  const conclusions = [
    {
      category: 'PRODUCTION_PARTITION_CONFIRMED_ON_SAMPLE',
      applies: partitionSummary.status === 'PROVEN_ON_SAMPLE',
      basis: `Partition status ${partitionSummary.status}: ${partitionSummary.completePairBucketCount}/${partitionSummary.pairWeekObservations} complete pair-weeks; all four fields compared separately.`,
    },
    {
      category: 'RANK_GROUP_DIRECTIONAL_DIFFERENCES_OBSERVED',
      applies: anyGroupNonZero,
      basis: `${directionConsistencySummary.mixedSignPairWeeks.length} pair-weeks have rank groups with opposite signed deltas; ${directionConsistencySummary.allGroupsSameNonZeroSign} have all four groups with the same non-zero sign.`,
    },
    {
      category: 'BRACKET_FILTER_EFFECT_OBSERVED',
      applies: thresholdOutcomeDiffers,
      basis: 'Individual bracket filters produce different deltas and threshold outcomes than the production aggregate. This describes filter dependence, not a cause.',
    },
    {
      category: 'UNKNOWN_RANK_CONTRIBUTION_UNVERIFIED',
      applies: true,
      basis: `individual:UNCALIBRATED returned pair rows for ${specialEnums['individual:UNCALIBRATED']?.bothDirectionsPresent ?? 0} pair-weeks. Empty results are not evidence that unknown-rank matches contribute zero to production.`,
    },
    {
      category: 'SPECIAL_ENUM_VALUES_UNVERIFIED',
      applies: true,
      basis: `FILTERED and ALL returned pair rows for ${specialEnums['individual:FILTERED']?.bothDirectionsPresent ?? 0} and ${specialEnums['individual:ALL']?.bothDirectionsPresent ?? 0} pair-weeks. The all-ranks filter equalled production counts in ${specialEnums['all-ranks']?.equalsProductionCounts ?? 0} pair-weeks; that is not proof that ALL equals the union of the production groups.`,
    },
    {
      category: 'UNRESOLVED',
      applies: true,
      basis: 'Reverse-direction matchCount differences exist inside individual rank groups as well as in the production aggregate, and the groups sum exactly to production. Nothing here identifies the mechanism that makes A→B and B→A counts differ.',
    },
  ];

  const evidence = {
    schemaVersion: 1,
    diagnostic: 'TZ #76-FIX13 production bracket partition proof and matchup win-rate semantics',
    networkRequests: 0,
    sourceHashes,
    upstreamEvidence: {
      fix12EvidenceSha256: fix12Evidence.evidenceSha256,
      fix12RawCanonicalSha256: fix12Evidence.rawResponseArtifact.canonicalSha256,
      fix12RawPhysicalSha256: fix12Evidence.rawResponseArtifact.sha256,
      fix12CreatedAt: fix12Evidence.createdAt,
      fix12RootCauseStatus: fix12Evidence.rootCause.status,
      fix12ProductionPublishAllowed: fix12Evidence.rootCause.productionPublishAllowed,
    },
    productionBracketValues: [...PRODUCTION_BRACKETS],
    productionBracketSource: 'scripts/update-data-stratz.mjs:BRACKETS',
    buckets,
    pairs: orderedPairs.map((pair) => ({
      canonicalPairId: pair.canonicalPairId,
      heroAId: pair.heroAId,
      heroBId: pair.heroBId,
      heroA: pair.heroA,
      heroB: pair.heroB,
      fix11AnomalyBuckets: pair.anomalyBuckets,
      focusPair: FIX13_FOCUS_PAIRS.includes(pair.canonicalPairId),
    })),
    partitionVerification: {
      ...partitionSummary,
      fields: [...PARTITION_FIELDS],
      rows: partitionRows,
    },
    allEnumPartitionCheckFix12: {
      status: fix12RankPartition.status,
      comparedDirectionBuckets: fix12RankPartition.comparedDirectionBuckets,
      note: 'Historical FIX12 all-enum check (UNCALIBRATED/FILTERED/ALL included), kept separate and unchanged.',
    },
    specialFilterObservations: specialEnums,
    winsAverageSemantics: {
      ...winsAverageSummary,
      uniqueObservationRows: uniqueRowKeys.size,
      rowSetNote: 'Same pair-specific row set as FIX12 winCountSemantics: every present, non-duplicate directed row across all 10 filters. Identical responses from different filters are counted per filter.',
      rows: winsAverageComparisons,
    },
    rankAsymmetryContribution: {
      pairWeekRows: contributionRows,
      directionConsistencySummary,
    },
    fieldSemantics,
    conclusions,
    rawEvidenceReferences: {
      path: SOURCE_PATHS.fix12Raw,
      responsesReferenced: observations.references.length,
      queries: observations.references,
    },
    rootCause: {
      status: 'UNRESOLVED',
      productionPublishAllowed: false,
      explanation: 'FIX13 establishes empirical additivity of the four production bracket groups and the winsAverage ≈ winCount/matchCount relation on the sample. Neither identifies why reverse-direction matchCount differs; the STRATZ API contract for these fields remains undocumented.',
    },
    evidenceSha256: '',
  };
  evidence.evidenceSha256 = canonicalJsonSha256(evidence, 'evidenceSha256');
  return evidence;
}

export function runFix13(deps = {}) {
  const read = deps.readFileSync ?? readFileSync;
  const root = deps.root ?? ROOT;
  const before = captureSourceHashes(read, root);
  verifySourceHashes(before);
  const fix12Evidence = JSON.parse(read(path.join(root, SOURCE_PATHS.fix12Evidence), 'utf8'));
  const fix12Raw = JSON.parse(read(path.join(root, SOURCE_PATHS.fix12Raw), 'utf8'));
  const evidence = buildPartitionSemanticsEvidence({ fix12Evidence, fix12Raw, sourceHashes: before });
  const after = captureSourceHashes(read, root);
  verifySourceHashes(after);
  return evidence;
}

function writeEvidence(evidence, deps = {}) {
  const target = deps.evidencePath ?? PARTITION_EVIDENCE_PATH;
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  if ((deps.existsSync ?? existsSync)(target)) {
    const existing = (deps.readFileSync ?? readFileSync)(target, 'utf8');
    if (existing === body) return { written: false, identical: true };
    throw new Error('FIX13 evidence already exists with different content; refusing to overwrite');
  }
  (deps.writeFileSync ?? writeFileSync)(target, body, { flag: 'wx' });
  return { written: true, identical: false };
}

async function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  if (command !== 'run' && command !== 'check') {
    throw new Error('Usage: node scripts/stratz-matchup-partition-semantics.mjs <run|check>');
  }
  const evidence = runFix13();
  if (command === 'run') {
    const result = writeEvidence(evidence);
    console.log(JSON.stringify({ ...result, evidenceSha256: evidence.evidenceSha256 }, null, 2));
    return;
  }
  const saved = JSON.parse(readFileSync(PARTITION_EVIDENCE_PATH, 'utf8'));
  if (saved.evidenceSha256 !== canonicalJsonSha256(saved, 'evidenceSha256')
    || saved.evidenceSha256 !== evidence.evidenceSha256) {
    throw new Error('FIX13 evidence does not reproduce from FIX12 raw responses');
  }
  console.log(JSON.stringify({
    status: 'PASS',
    evidenceSha256: saved.evidenceSha256,
    partition: saved.partitionVerification.status,
    winsAverage: saved.winsAverageSemantics.status,
    rootCause: saved.rootCause.status,
    productionPublishAllowed: saved.rootCause.productionPublishAllowed,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[STRATZ FIX13] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
