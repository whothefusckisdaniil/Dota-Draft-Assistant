#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  StratzTransport,
  loadToken,
  buildChunkQuery,
  BUCKET_SEC,
  BRACKETS,
} from './update-data-stratz.mjs';
import { diagnosePair } from './stratz-matchup-asymmetry-lib.mjs';
import {
  canonicalJsonSha256,
} from './stratz-matchup-root-cause-research.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BRACKET_EVIDENCE_PATH = path.join(
  ROOT,
  'research/data-quality/stratz-reverse-pair-bracket-semantics-evidence.json',
);
export const BRACKET_RAW_PATH = path.join(
  ROOT,
  'research/data-quality/stratz-reverse-pair-bracket-raw-responses.json',
);

export const FIX12_REQUIRED_PAIRS = Object.freeze([
  '58:61',
  '61:79',
  '47:89',
  '59:89',
  '58:83',
]);
export const FIX12_PAIR_SAMPLE_SIZE = 8;

const SOURCE_PATHS = Object.freeze({
  fix9Input: path.join(ROOT, 'scripts/stratz-diagnostic-input.json'),
  fix10Repeatability: path.join(
    ROOT,
    'research/data-quality/stratz-reverse-pair-repeatability-evidence.json',
  ),
  fix10Report: path.join(
    ROOT,
    'research/data-quality/stratz-reverse-pair-asymmetry-report.json',
  ),
  fix11Evidence: path.join(
    ROOT,
    'research/data-quality/stratz-reverse-pair-root-cause-evidence.json',
  ),
  fix11Raw: path.join(
    ROOT,
    'research/data-quality/stratz-reverse-pair-root-cause-raw-responses.json',
  ),
  productionHeroes: path.join(ROOT, 'public/data/heroes.json'),
  productionMatchups: path.join(ROOT, 'public/data/matchups.json'),
  productionMeta: path.join(ROOT, 'public/data/meta.json'),
});

const EXPECTED_SOURCE_HASHES = Object.freeze({
  fix9Input: {
    physicalSha256: '291350d18a0195dfa9b2292b08a832267234dac6b8b16b8f045c71cd5afba002',
    canonicalSha256: '59e46634e94bb7e0e3db180c2ddbefd4dd6be422bbd026539d4ccff84e217ef1',
  },
  fix10Repeatability: {
    physicalSha256: '278c740c10747da0c91642cd02efb5ebaca741c8b935a6d6b8b771420d89978e',
    canonicalSha256: '44d728edd96411c81213824d9d4d8ad65be39c5286ff884f5dade4175c2d028c',
  },
  fix10Report: {
    physicalSha256: 'ef5e27a1ca55cb1876d210027ff58c2f4a11f7f35ca3c24f9754ad71f584cf95',
  },
  fix11Evidence: {
    physicalSha256: '7ed6d5daac42dbcc19995caf5518518ccac3ef6de42a4fd62c7468af7363494b',
    canonicalSha256: '71deb1ccb7ef05cf86e1954824e2582fa4004abcf8001c188c7988e37fb086c8',
  },
  fix11Raw: {
    physicalSha256: '0e426ac478489e23e1d35cd1336fe2487ab101364ff8b041f433714c1ccf6e7b',
    canonicalSha256: '1a5e27ab8b066eff681ba5be860ae916d2751f8abe1d5020e286ee9215014b14',
  },
  productionHeroes: {
    physicalSha256: '59ecc2bc9b55a62232bf7d40b85c1d4c306602e89addda6d3faa9ed38a2c061d',
  },
  productionMatchups: {
    physicalSha256: '0a9e54aaa925494f7ad876c992e782cfd45d297b3952c8afefb8decc3ad02e8b',
  },
  productionMeta: {
    physicalSha256: '9db099dedf5c5f0d052590d98d194807e2580a16694fc562ae9ffbf1d144857e',
  },
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
};

function parseJson(filePath, read = readFileSync) {
  return JSON.parse(read(filePath, 'utf8'));
}

function physicalSha256(filePath, read = readFileSync) {
  return sha256(read(filePath));
}

function fileCanonicalSha256(filePath, omittedKey, read = readFileSync) {
  const parsed = parseJson(filePath, read);
  if (omittedKey) delete parsed[omittedKey];
  return sha256(JSON.stringify(canonicalize(parsed)));
}

export function captureSourceHashes(read = readFileSync) {
  const result = {};
  for (const [name, filePath] of Object.entries(SOURCE_PATHS)) {
    result[name] = {
      path: path.relative(ROOT, filePath),
      physicalSha256: physicalSha256(filePath, read),
    };
    const omittedKey = name === 'fix9Input' ? 'inputSha256'
      : name === 'fix10Repeatability' || name === 'fix11Evidence' ? 'evidenceSha256'
        : null;
    if (omittedKey) {
      result[name].canonicalSha256 = fileCanonicalSha256(filePath, omittedKey, read);
    } else if (name === 'fix11Raw') {
      result[name].canonicalSha256 = fileCanonicalSha256(filePath, null, read);
    }
  }
  return result;
}

export function verifyProtectedSourceHashes(hashes, read = readFileSync) {
  for (const [name, expected] of Object.entries(EXPECTED_SOURCE_HASHES)) {
    const actual = hashes[name];
    if (!actual || actual.physicalSha256 !== expected.physicalSha256
      || (expected.canonicalSha256
        && actual.canonicalSha256 !== expected.canonicalSha256)) {
      throw new Error(`Protected FIX12 source hash mismatch: ${name}`);
    }
  }
  const input = parseJson(SOURCE_PATHS.fix9Input, read);
  const repeatability = parseJson(SOURCE_PATHS.fix10Repeatability, read);
  const fix11 = parseJson(SOURCE_PATHS.fix11Evidence, read);
  if (input.inputSha256 !== EXPECTED_SOURCE_HASHES.fix9Input.canonicalSha256
    || repeatability.evidenceSha256 !== EXPECTED_SOURCE_HASHES.fix10Repeatability.canonicalSha256
    || fix11.evidenceSha256 !== EXPECTED_SOURCE_HASHES.fix11Evidence.canonicalSha256
    || fix11.rootCause?.status !== 'UNRESOLVED'
    || fix11.rootCause?.productionPublishAllowed !== false) {
    throw new Error('FIX9–FIX11 source records are not the protected unresolved evidence');
  }
  return { input, repeatability, fix11 };
}

function typeString(type) {
  if (!type) return null;
  if (type.kind === 'NON_NULL') return `${typeString(type.ofType)}!`;
  if (type.kind === 'LIST') return `[${typeString(type.ofType)}]`;
  return type.name;
}

export function makeRankSchemaIntrospectionQuery() {
  const typeRef = '{ kind name ofType { kind name ofType { kind name ofType { kind name } } } }';
  return `{
    rankBracketBasicEnum: __type(name: "RankBracketBasicEnum") {
      name kind
      enumValues(includeDeprecated: true) { name description isDeprecated }
    }
    heroStatsQuery: __type(name: "HeroStatsQuery") {
      name
      fields {
        name
        args { name description type ${typeRef} }
      }
    }
    matchupRow: __type(name: "HeroStatsHeroDryadType") {
      name
      fields { name description type ${typeRef} }
    }
  }`;
}

export function summarizeRankSchema(response) {
  const data = response?.data;
  const queryType = data?.heroStatsQuery;
  const matchUp = queryType?.fields?.find((field) => field.name === 'matchUp');
  const args = Object.fromEntries((matchUp?.args ?? []).map((arg) => [
    arg.name,
    {
      graphqlType: typeString(arg.type),
      nullable: arg.type?.kind !== 'NON_NULL',
      description: arg.description ?? null,
    },
  ]));
  const rowFields = Object.fromEntries((data?.matchupRow?.fields ?? []).map((field) => [
    field.name,
    {
      graphqlType: typeString(field.type),
      description: field.description ?? null,
    },
  ]));
  const enumType = data?.rankBracketBasicEnum;
  return {
    enum: {
      name: enumType?.name ?? null,
      kind: enumType?.kind ?? null,
      values: (enumType?.enumValues ?? []).map((entry) => ({
        name: entry.name,
        description: entry.description ?? null,
        isDeprecated: entry.isDeprecated === true,
        semanticStatus: entry.description ? 'SCHEMA_DESCRIPTION_AVAILABLE' : 'UNVERIFIED',
      })),
    },
    matchUp: {
      returnType: typeString(matchUp?.type),
      arguments: args,
      bracketBasicIdsNullable: args.bracketBasicIds?.nullable ?? false,
    },
    matchupRow: {
      name: data?.matchupRow?.name ?? null,
      fields: rowFields,
    },
  };
}

export function isUnknownRankValue(value) {
  return /unknown/i.test(`${value?.name ?? ''} ${value?.description ?? ''}`);
}

export function mapProductionBrackets(enumValues, productionBrackets) {
  const byName = new Map(enumValues.map((value) => [value.name, value]));
  const unknownValues = enumValues.filter(isUnknownRankValue);
  const productionSet = new Set(productionBrackets);
  const productionValues = productionBrackets.map((name) => {
    const value = byName.get(name);
    return {
      productionValue: name,
      enumValue: value?.name ?? null,
      description: value?.description ?? null,
      isDeprecated: value?.isDeprecated ?? null,
      status: !value ? 'UNKNOWN_ENUM_VALUE'
        : value.isDeprecated ? 'DEPRECATED' : 'EXACT_ENUM_MATCH',
      semanticStatus: value?.description ? 'SCHEMA_DESCRIPTION_AVAILABLE' : 'UNVERIFIED',
    };
  });
  const nonUnknownValues = enumValues.filter((value) => !isUnknownRankValue(value));
  const missingNonUnknownValues = nonUnknownValues
    .filter((value) => !productionSet.has(value.name))
    .map((value) => value.name);
  const unknownIncludedInProduction = unknownValues.some((value) =>
    productionSet.has(value.name));
  const deprecatedProductionValues = productionValues
    .filter((entry) => entry.isDeprecated === true)
    .map((entry) => entry.productionValue);
  return {
    productionBrackets: [...productionBrackets],
    productionValues,
    enumValues: enumValues.map((value) => ({
      name: value.name,
      description: value.description ?? null,
      isDeprecated: value.isDeprecated === true,
      includedInProduction: productionSet.has(value.name),
      semanticStatus: value.description ? 'SCHEMA_DESCRIPTION_AVAILABLE' : 'UNVERIFIED',
    })),
    unknownValues: unknownValues.map((value) => value.name),
    unknownIncludedInProduction,
    missingNonUnknownValues,
    deprecatedProductionValues,
    allNonUnknownEnumsCovered: missingNonUnknownValues.length === 0
      && productionValues.every((entry) => entry.status === 'EXACT_ENUM_MATCH'),
    intendedRankRangeStatus: productionValues.every((entry) => entry.description)
      && enumValues.every((value) => value.description)
      ? 'REVIEW_DESCRIPTIONS'
      : 'UNVERIFIED',
    mappingStatus: productionValues.some((entry) => entry.status !== 'EXACT_ENUM_MATCH')
      ? 'INVALID_OR_DEPRECATED_PRODUCTION_VALUE'
      : unknownIncludedInProduction ? 'UNKNOWN_INCLUDED_IN_PRODUCTION'
        : 'ENUM_VALUES_MATCH',
  };
}

export function createBracketFilterConfigurations(
  enumValues,
  productionBrackets,
  bracketArgumentNullable,
) {
  const known = new Set(enumValues.map((entry) => entry.name));
  if (productionBrackets.some((value) => !known.has(value))) {
    throw new Error('Production BRACKETS contains a value absent from the schema enum');
  }
  const unknownValues = enumValues.filter(isUnknownRankValue);
  const rawConfigurations = [
    { id: 'production', brackets: [...productionBrackets], meaning: 'Production filter' },
    { id: 'all-ranks', brackets: enumValues.map((entry) => entry.name), meaning: 'All schema enum values' },
    ...unknownValues.map((entry) => ({
      id: 'unknown-only',
      brackets: [entry.name],
      meaning: 'Unknown-only',
    })),
    ...(bracketArgumentNullable
      ? [{ id: 'no-bracket-filter', brackets: null, meaning: 'Argument omitted' }]
      : []),
    ...enumValues.map((entry) => ({
      id: `individual:${entry.name}`,
      brackets: [entry.name],
      meaning: `Individual enum value ${entry.name}`,
    })),
  ];
  const unique = new Map();
  for (const configuration of rawConfigurations) {
    const key = configuration.brackets === null
      ? 'NO_FILTER'
      : [...configuration.brackets].sort().join('|');
    const existing = unique.get(key);
    if (existing) {
      existing.aliases.push(configuration.id);
      continue;
    }
    unique.set(key, {
      ...configuration,
      aliases: [configuration.id],
    });
  }
  return [...unique.values()];
}

export function normalizeRankFilter(values, enumValues) {
  if (values === null) return null;
  if (!Array.isArray(values)) throw new TypeError('Bracket filter must be an array or null');
  const order = new Map(enumValues.map((entry, index) => [entry.name, index]));
  const unique = [...new Set(values)];
  const unknown = unique.filter((value) => !order.has(value));
  if (unknown.length) throw new Error(`Unknown bracket enum value(s): ${unknown.join(', ')}`);
  return unique.sort((left, right) => order.get(left) - order.get(right));
}

export function buildDiagnosticPairQuery({
  heroIds,
  buckets,
  bracketFilter,
  bracketArgumentNullable = false,
  buildQuery = buildChunkQuery,
}) {
  if (!Array.isArray(heroIds) || heroIds.length !== 2
    || new Set(heroIds).size !== 2) {
    throw new Error('Diagnostic pair query requires exactly two distinct hero IDs');
  }
  if (!Array.isArray(buckets) || buckets.length === 0) {
    throw new Error('Diagnostic pair query requires at least one bucket');
  }
  if (bracketFilter === null && !bracketArgumentNullable) {
    throw new Error('The schema does not allow omitting bracketBasicIds');
  }
  const productionQuery = buildQuery(heroIds, buckets);
  const bracketPattern = /bracketBasicIds:\s*\[[^\]]*\]/g;
  const bracketMatches = productionQuery.match(bracketPattern) ?? [];
  if (bracketMatches.length !== buckets.length) {
    throw new Error('Production query bracket argument count differs from requested buckets');
  }
  let query = bracketFilter === null
    ? productionQuery.replace(/,\s*bracketBasicIds:\s*\[[^\]]*\]/g, '')
    : productionQuery.replace(
      bracketPattern,
      `bracketBasicIds: [${bracketFilter.join(', ')}]`,
    );
  const selectionPattern = /heroId1 heroId2 matchCount winCount/g;
  const selectionMatches = query.match(selectionPattern) ?? [];
  if (selectionMatches.length !== buckets.length) {
    throw new Error('Production query matchup selection count differs from requested buckets');
  }
  query = query.replace(
    selectionPattern,
    'heroId1 heroId2 matchCount winCount winRateHeroId1 winRateHeroId2 winsAverage',
  );
  return { query, productionQuery };
}

function enumMeaningHasExplicitOverlap(enumValues) {
  return enumValues.some((value) =>
    /\boverlap(?:s|ping)?\b/i.test(value.description ?? ''));
}

export function selectStratifiedPairs(
  anomalyInventory,
  requiredPairIds = FIX12_REQUIRED_PAIRS,
  sampleSize = FIX12_PAIR_SAMPLE_SIZE,
) {
  const grouped = new Map();
  for (const row of anomalyInventory) {
    if (!grouped.has(row.canonicalPairId)) {
      grouped.set(row.canonicalPairId, {
        canonicalPairId: row.canonicalPairId,
        heroAId: row.heroAId,
        heroBId: row.heroBId,
        heroA: row.heroA,
        heroB: row.heroB,
        buckets: [],
        signedDeltas: [],
        pairWeeks: [],
      });
    }
    const item = grouped.get(row.canonicalPairId);
    item.buckets.push(row.bucket);
    item.signedDeltas.push(row.gamesA - row.gamesB);
    item.pairWeeks.push(row);
  }
  const candidates = [...grouped.values()].sort((a, b) =>
    a.canonicalPairId.localeCompare(b.canonicalPairId, undefined, { numeric: true }));
  const byId = new Map(candidates.map((candidate) => [
    candidate.canonicalPairId,
    candidate,
  ]));
  const missingRequired = requiredPairIds.filter((pairId) => !byId.has(pairId));
  if (missingRequired.length) {
    throw new Error(`Required FIX11 anomaly pairs are missing: ${missingRequired.join(', ')}`);
  }
  if (sampleSize < requiredPairIds.length || sampleSize > candidates.length) {
    throw new Error('Pair sample size cannot satisfy required pairs or exceeds the inventory');
  }
  const selected = requiredPairIds.map((pairId) => byId.get(pairId));
  const heroFrequencies = new Map();
  for (const candidate of candidates) {
    for (const heroId of [candidate.heroAId, candidate.heroBId]) {
      heroFrequencies.set(heroId, (heroFrequencies.get(heroId) ?? 0) + candidate.pairWeeks.length);
    }
  }
  const topHeroes = [...heroFrequencies.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 6)
    .map(([heroId]) => heroId);
  const features = (candidate) => [
    ...new Set([
      ...candidate.buckets.map((bucket) => `bucket:${bucket}`),
      ...candidate.signedDeltas.map((delta) => `sign:${Math.sign(delta)}`),
      candidate.buckets.length > 1 ? 'multi-bucket' : 'single-bucket',
      ...[candidate.heroAId, candidate.heroBId]
        .filter((heroId) => topHeroes.includes(heroId))
        .map((heroId) => `frequent-hero:${heroId}`),
    ]),
  ];
  const covered = new Set(selected.flatMap(features));
  while (selected.length < sampleSize) {
    const remaining = candidates.filter((candidate) =>
      !selected.some((item) => item.canonicalPairId === candidate.canonicalPairId));
    const ranked = remaining.map((candidate) => ({
      candidate,
      score: features(candidate).filter((feature) => !covered.has(feature)).length,
    })).sort((a, b) => b.score - a.score
      || a.candidate.canonicalPairId.localeCompare(
        b.candidate.canonicalPairId,
        undefined,
        { numeric: true },
      ));
    const next = ranked[0]?.candidate;
    if (!next) break;
    selected.push(next);
    for (const feature of features(next)) covered.add(feature);
  }
  return selected.map((candidate) => ({
    ...candidate,
    buckets: [...new Set(candidate.buckets)].sort((a, b) => a - b),
    signedDeltaSigns: [...new Set(candidate.signedDeltas.map(Math.sign))].sort((a, b) => a - b),
    selectionRationale: [
      requiredPairIds.includes(candidate.canonicalPairId) ? 'REQUIRED_PAIR' : 'STRATIFIED_COVERAGE',
      candidate.buckets.length > 1 ? 'MULTI_BUCKET' : 'SINGLE_BUCKET',
      ...[...new Set(candidate.signedDeltas.map(Math.sign))].map((sign) =>
        sign > 0 ? 'HERO_A_GAMES_GREATER' : 'HERO_B_GAMES_GREATER'),
    ],
  }));
}

function numericValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeRate(rate) {
  const value = numericValue(rate);
  if (value === null) return null;
  const text = String(rate).toLowerCase();
  const [mantissa, exponentText] = text.split('e');
  const decimalPlaces = Math.max(
    0,
    (mantissa.split('.')[1]?.length ?? 0) - Number(exponentText ?? 0),
  );
  if (value >= 0 && value <= 1) {
    return { value, scale: '0-1', decimalPlaces };
  }
  if (value >= 0 && value <= 100) {
    return { value: value / 100, scale: '0-100', decimalPlaces };
  }
  return null;
}

export function compareRate(candidateRate, expectedRate, tolerance = null) {
  const normalized = normalizeRate(candidateRate);
  if (!normalized || !Number.isFinite(expectedRate)) return null;
  const roundingTolerance = 0.5 * (10 ** -normalized.decimalPlaces)
    / (normalized.scale === '0-100' ? 100 : 1);
  const usedTolerance = tolerance ?? Math.max(roundingTolerance, Number.EPSILON * 16);
  const difference = Math.abs(normalized.value - expectedRate);
  return {
    matches: difference <= usedTolerance,
    normalizedRate: normalized.value,
    scale: normalized.scale,
    absoluteDifference: difference,
    tolerance: usedTolerance,
  };
}

export function comparePairDirections(pair, rowsByBucket, filterId) {
  const perBucket = [...rowsByBucket].sort((a, b) => a.bucket - b.bucket)
    .map(({ bucket, directionAtoB, directionBtoA }) => {
    if (directionAtoB?.duplicateCount > 1 || directionBtoA?.duplicateCount > 1) {
      return {
        bucket,
        status: 'DUPLICATE_DIRECTION',
        heroAtoB: directionAtoB,
        heroBtoA: directionBtoA,
        absoluteGamesDelta: null,
        relativeDeltaA: null,
        relativeDeltaB: null,
        thresholdExceeded: null,
        validationStatus: 'DUPLICATE_DIRECTION',
      };
    }
    if (!directionAtoB || !directionBtoA) {
      return {
        bucket,
        status: !directionAtoB && !directionBtoA ? 'MISSING_BOTH_DIRECTIONS'
          : !directionAtoB ? 'MISSING_A_TO_B' : 'MISSING_B_TO_A',
        heroAtoB: directionAtoB,
        heroBtoA: directionBtoA,
        absoluteGamesDelta: null,
        relativeDeltaA: null,
        relativeDeltaB: null,
        thresholdExceeded: null,
      };
    }
    const diagnosis = diagnosePair(
      pair.heroAId,
      pair.heroBId,
      directionAtoB.matchCount,
      directionAtoB.winCount,
      directionBtoA.matchCount,
      directionBtoA.winCount,
    );
    return {
      bucket,
      status: directionAtoB.duplicateCount > 1 || directionBtoA.duplicateCount > 1
        ? 'DUPLICATE_DIRECTION' : 'COMPARED',
      heroAtoB: directionAtoB,
      heroBtoA: directionBtoA,
      absoluteGamesDelta: diagnosis.absoluteGamesDelta,
      relativeDeltaA: diagnosis.relativeDeltaA,
      relativeDeltaB: diagnosis.relativeDeltaB,
      thresholdExceeded: directionAtoB.duplicateCount > 1 || directionBtoA.duplicateCount > 1
        ? null : diagnosis.thresholdExceeded,
      validationStatus: directionAtoB.duplicateCount > 1 || directionBtoA.duplicateCount > 1
        ? 'DUPLICATE_DIRECTION' : diagnosis.validationStatus,
    };
    });
  const allPresent = perBucket.every((item) =>
    item.status === 'COMPARED'
    && item.heroAtoB && item.heroBtoA);
  const aggregate = allPresent ? {
    gamesA: perBucket.reduce((sum, item) => sum + item.heroAtoB.matchCount, 0),
    gamesB: perBucket.reduce((sum, item) => sum + item.heroBtoA.matchCount, 0),
    winsA: perBucket.reduce((sum, item) => sum + item.heroAtoB.winCount, 0),
    winsB: perBucket.reduce((sum, item) => sum + item.heroBtoA.winCount, 0),
  } : null;
  let aggregateDiagnosis = null;
  if (aggregate) {
    aggregateDiagnosis = diagnosePair(
      pair.heroAId,
      pair.heroBId,
      aggregate.gamesA,
      aggregate.winsA,
      aggregate.gamesB,
      aggregate.winsB,
    );
  }
  return {
    canonicalPairId: pair.canonicalPairId,
    filterId,
    perBucket,
    aggregate,
    aggregateDiagnosis,
    missingBuckets: perBucket.filter((item) => item.status !== 'COMPARED')
      .map((item) => item.bucket),
  };
}

function extractPairRows(response, pair, buckets) {
  const perBucket = [];
  const orientationIssues = [];
  for (const bucket of buckets) {
    const dryads = response?.data?.heroStats?.[`w${bucket}`];
    if (!Array.isArray(dryads)) {
      perBucket.push({ bucket, directionAtoB: null, directionBtoA: null });
      continue;
    }
    const directions = [];
    for (const heroId of [pair.heroAId, pair.heroBId]) {
      const dryad = dryads.find((item) => item.heroId === heroId);
      const opponentId = heroId === pair.heroAId ? pair.heroBId : pair.heroAId;
      const found = (dryad?.vs ?? []).filter((row) =>
        (row.heroId1 === pair.heroAId && row.heroId2 === pair.heroBId)
        || (row.heroId1 === pair.heroBId && row.heroId2 === pair.heroAId));
      for (const row of found) {
        if (row.heroId1 !== heroId) {
          orientationIssues.push({
            bucket,
            queriedHeroId: heroId,
            heroId1: row.heroId1,
            heroId2: row.heroId2,
          });
        }
      }
      const oriented = found.filter((row) => row.heroId1 === heroId && row.heroId2 === opponentId);
      const row = oriented.length === 1 ? oriented[0] : null;
      directions.push(row ? {
        matchCount: row.matchCount,
        winCount: row.winCount,
        winRateHeroId1: row.winRateHeroId1,
        winRateHeroId2: row.winRateHeroId2,
        winsAverage: row.winsAverage,
        duplicateCount: oriented.length,
      } : oriented.length > 1 ? {
        duplicateCount: oriented.length,
        duplicateRows: oriented,
      } : null);
    }
    perBucket.push({
      bucket,
      directionAtoB: directions[0],
      directionBtoA: directions[1],
    });
  }
  return { perBucket, orientationIssues };
}

export function validateDiagnosticResponse(response, heroIds, buckets, requiredFields) {
  if (!response?.data?.heroStats || Array.isArray(response.errors)) {
    throw new Error('Response does not contain valid data.heroStats');
  }
  const observedHeroIdsByBucket = {};
  let rowCount = 0;
  for (const bucket of buckets) {
    const dryads = response.data.heroStats[`w${bucket}`];
    if (!Array.isArray(dryads)) throw new Error(`Response is missing bucket w${bucket}`);
    const seenHeroIds = new Set();
    observedHeroIdsByBucket[bucket] = dryads.map((dryad) => dryad.heroId)
      .filter((id) => heroIds.includes(id))
      .sort((a, b) => a - b);
    for (const dryad of dryads) {
      if (!heroIds.includes(dryad.heroId) || seenHeroIds.has(dryad.heroId)
        || !Array.isArray(dryad.vs)) {
        throw new Error(`Invalid dryad response for hero ${dryad.heroId} in bucket ${bucket}`);
      }
      seenHeroIds.add(dryad.heroId);
      for (const row of dryad.vs) {
        rowCount += 1;
        if (!Number.isSafeInteger(row.heroId1)
          || !Number.isSafeInteger(row.heroId2)
          || !Number.isSafeInteger(row.matchCount)
          || !Number.isSafeInteger(row.winCount)
          || row.matchCount < 0
          || row.winCount < 0
          || row.winCount > row.matchCount) {
          throw new Error(`Invalid matchup counts in bucket ${bucket}`);
        }
        for (const field of requiredFields) {
          if (!Object.hasOwn(row, field)) {
            throw new Error(`Missing diagnostic field ${field} in bucket ${bucket}`);
          }
        }
      }
    }
  }
  return { observedHeroIdsByBucket, rowCount };
}

function redactError(error, token) {
  let message = error instanceof Error ? error.message : String(error);
  if (token) message = message.split(token).join('<redacted-token>');
  return message.replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer <redacted>');
}

export async function executeDiagnosticQuery({
  requestId,
  query,
  requestedHeroIds = [],
  buckets = [],
  validate,
  Transport = StratzTransport,
  token,
  now = () => new Date(),
}) {
  const record = {
    requestId,
    startedAt: now().toISOString(),
    finishedAt: null,
    status: 'FAILED',
    requestHash: sha256(query),
    responseHash: null,
    transportCreated: false,
    transportClosed: false,
    error: null,
    closeError: null,
    observedHeroIdsByBucket: null,
    rowCount: null,
  };
  let transport;
  let validatedResponse = null;
  try {
    transport = new Transport(token);
    record.transportCreated = true;
    await transport.init();
    const response = await transport.query(query);
    const validation = validate(response);
    record.responseHash = normalizedResponseSha256(response);
    record.observedHeroIdsByBucket = validation?.observedHeroIdsByBucket ?? null;
    record.rowCount = validation?.rowCount ?? null;
    record.status = 'VERIFIED';
    validatedResponse = response;
  } catch (error) {
    record.error = redactError(error, token);
  } finally {
    if (transport) {
      try {
        await transport.close();
        record.transportClosed = true;
      } catch (error) {
        record.closeError = redactError(error, token);
        record.status = 'INCOMPLETE';
      }
    }
    record.finishedAt = now().toISOString();
  }
  return {
    record,
    response: validatedResponse && record.status === 'VERIFIED'
      ? validatedResponse : null,
  };
}

export function queryRateEvidence(rows) {
  const stats = {
    rowCount: rows.length,
    ratesAvailableCount: 0,
    directHero1Matches: 0,
    inverseHero2Matches: 0,
    hero1AgainstInverseRateMatches: 0,
    hero2AgainstInverseRateMatches: 0,
    scaleCounts: { '0-1': 0, '0-100': 0 },
    winsAverageMatchesRateMean: 0,
    winsAverageMatchesWinCount: 0,
    winsAverageAvailableCount: 0,
    rateToleranceMax: 0,
    rateMismatches: [],
  };
  for (const item of rows) {
    const matchCount = numericValue(item.matchCount);
    const winCount = numericValue(item.winCount);
    const rate1 = normalizeRate(item.winRateHeroId1);
    const rate2 = normalizeRate(item.winRateHeroId2);
    const average = numericValue(item.winsAverage);
    if (matchCount === null || matchCount <= 0 || winCount === null || !rate1 || !rate2) continue;
    stats.ratesAvailableCount += 1;
    stats.scaleCounts[rate1.scale] += 1;
    stats.scaleCounts[rate2.scale] += 1;
    const direct = compareRate(item.winRateHeroId1, winCount / matchCount);
    const inverse = compareRate(item.winRateHeroId2, (matchCount - winCount) / matchCount);
    const hero1Inverse = compareRate(item.winRateHeroId1, (matchCount - winCount) / matchCount);
    const hero2Direct = compareRate(item.winRateHeroId2, winCount / matchCount);
    if (direct?.matches) stats.directHero1Matches += 1;
    if (inverse?.matches) stats.inverseHero2Matches += 1;
    if (hero1Inverse?.matches) stats.hero1AgainstInverseRateMatches += 1;
    if (hero2Direct?.matches) stats.hero2AgainstInverseRateMatches += 1;
    stats.rateToleranceMax = Math.max(
      stats.rateToleranceMax,
      direct?.tolerance ?? 0,
      inverse?.tolerance ?? 0,
    );
    if (average !== null) {
      stats.winsAverageAvailableCount += 1;
      const averageVsMean = compareRate(average, (rate1.value + rate2.value) / 2);
      if (averageVsMean?.matches) {
        stats.winsAverageMatchesRateMean += 1;
      }
      if (average === winCount) stats.winsAverageMatchesWinCount += 1;
    }
    if (!direct?.matches || !inverse?.matches) {
      stats.rateMismatches.push({
        canonicalPairId: item.canonicalPairId,
        bucket: item.bucket,
        heroId1: item.heroId1,
        heroId2: item.heroId2,
        matchCount,
        winCount,
        winRateHeroId1: item.winRateHeroId1,
        winRateHeroId2: item.winRateHeroId2,
        directDifference: direct?.absoluteDifference ?? null,
        inverseDifference: inverse?.absoluteDifference ?? null,
      });
    }
  }
  const complete = stats.rowCount > 0 && stats.ratesAvailableCount === stats.rowCount;
  const allDirect = complete && stats.directHero1Matches === stats.rowCount
    && stats.inverseHero2Matches === stats.rowCount;
  const inverseOnly = complete
    && stats.hero1AgainstInverseRateMatches === stats.rowCount
    && stats.hero2AgainstInverseRateMatches === stats.rowCount;
  stats.winCountInterpretation = allDirect && !inverseOnly ? 'EMPIRICALLY_CONFIRMED'
    : inverseOnly && !allDirect ? 'CONTRADICTED'
      : allDirect && inverseOnly ? 'SUPPORTED'
        : 'UNVERIFIED';
  stats.winCountInterpretationNote = allDirect
    ? 'Within the sampled rows, winCount/matchCount aligns with winRateHeroId1 and its complement aligns with winRateHeroId2.'
    : inverseOnly
      ? 'The observed rate alignment supports the inverse reading rather than winCount as heroId1 wins.'
      : 'The available sampled rates are incomplete or do not uniquely identify winCount semantics.';
  stats.winsAverageSemantics = stats.winsAverageAvailableCount === 0
    ? 'UNVERIFIED'
    : stats.winsAverageMatchesRateMean === stats.winsAverageAvailableCount
      ? 'SUPPORTED_AS_MEAN_OF_REPORTED_RATES_IN_SAMPLE'
      : 'UNVERIFIED';
  return stats;
}

function buildWinRateRows(pairs, resultRows) {
  const rows = [];
  for (const pair of pairs) {
    for (const filterRows of resultRows.filter((item) =>
      item.canonicalPairId === pair.canonicalPairId)) {
      for (const bucket of filterRows.perBucket) {
        for (const [heroId1, heroId2, row] of [
          [pair.heroAId, pair.heroBId, bucket.heroAtoB],
          [pair.heroBId, pair.heroAId, bucket.heroBtoA],
        ]) {
          if (!row) continue;
          rows.push({
            canonicalPairId: pair.canonicalPairId,
            bucket: bucket.bucket,
            heroId1,
            heroId2,
            ...row,
          });
        }
      }
    }
  }
  return rows;
}

function mapDirectionPair(pairComparison) {
  return {
    AtoB: pairComparison.aggregate?.gamesA ?? null,
    BtoA: pairComparison.aggregate?.gamesB ?? null,
    winsAtoB: pairComparison.aggregate?.winsA ?? null,
    winsBtoA: pairComparison.aggregate?.winsB ?? null,
    aggregateAbsoluteGamesDelta:
      pairComparison.aggregateDiagnosis?.absoluteGamesDelta ?? null,
    aggregateThresholdExceeded:
      pairComparison.aggregateDiagnosis?.thresholdExceeded ?? null,
    missingBuckets: pairComparison.missingBuckets,
    perBucket: pairComparison.perBucket.map((bucket) => ({
      bucket: bucket.bucket,
      status: bucket.status,
      AtoB: bucket.heroAtoB?.matchCount ?? null,
      BtoA: bucket.heroBtoA?.matchCount ?? null,
      winsAtoB: bucket.heroAtoB?.winCount ?? null,
      winsBtoA: bucket.heroBtoA?.winCount ?? null,
      absoluteGamesDelta: bucket.absoluteGamesDelta,
      relativeDeltaA: bucket.relativeDeltaA,
      relativeDeltaB: bucket.relativeDeltaB,
      thresholdExceeded: bucket.thresholdExceeded,
    })),
  };
}

export function compileFilterAnalysis(pairs, configurations, queryResults, enumValues, buckets) {
  const comparisons = [];
  for (const pair of pairs) {
    const baseConfig = configurations.find((config) =>
      config.aliases.includes('production'));
    const production = queryResults.find((result) =>
      result.canonicalPairId === pair.canonicalPairId
      && result.filterId === baseConfig?.id);
    for (const config of configurations) {
      const result = queryResults.find((item) =>
        item.canonicalPairId === pair.canonicalPairId
        && item.filterId === config.id);
      if (!result) {
        comparisons.push({
          canonicalPairId: pair.canonicalPairId,
          filterId: config.id,
          status: config.status ?? 'NOT_RUN',
          aliasConfigurations: config.aliases,
          missingRows: [],
          comparisonToProduction: null,
        });
        continue;
      }
      const prodByBucket = new Map((production?.perBucket ?? []).map((bucket) =>
        [bucket.bucket, bucket]));
      comparisons.push({
        canonicalPairId: pair.canonicalPairId,
        filterId: config.id,
        status: result.missingBuckets.length > 0 ? 'INCOMPLETE' : 'COMPARED',
        aliasConfigurations: config.aliases,
        result: mapDirectionPair(result),
        missingRows: result.perBucket.filter((bucket) =>
          !bucket.heroAtoB || !bucket.heroBtoA
          || bucket.status === 'DUPLICATE_DIRECTION')
          .map((bucket) => ({
            bucket: bucket.bucket,
            missingAtoB: !bucket.heroAtoB,
            missingBtoA: !bucket.heroBtoA,
            status: bucket.status,
          })),
        comparisonToProduction: result.perBucket.map((bucket) => {
          const baseline = prodByBucket.get(bucket.bucket);
          if (!baseline?.heroAtoB || !baseline?.heroBtoA
            || !bucket.heroAtoB || !bucket.heroBtoA) {
            return {
              bucket: bucket.bucket,
              status: 'INCOMPLETE',
              directionalCountsChanged: null,
              asymmetryChanged: null,
              thresholdChanged: null,
            };
          }
          const baseDelta = Math.abs(
            baseline.heroAtoB.matchCount - baseline.heroBtoA.matchCount,
          );
          const currentDelta = Math.abs(
            bucket.heroAtoB.matchCount - bucket.heroBtoA.matchCount,
          );
          const baseThreshold = baseline.thresholdExceeded;
          const currentThreshold = bucket.thresholdExceeded;
          return {
            bucket: bucket.bucket,
            status: 'COMPARED',
            directionalCountsChanged:
              baseline.heroAtoB.matchCount !== bucket.heroAtoB.matchCount
              || baseline.heroBtoA.matchCount !== bucket.heroBtoA.matchCount,
            directionalWinCountsChanged:
              baseline.heroAtoB.winCount !== bucket.heroAtoB.winCount
              || baseline.heroBtoA.winCount !== bucket.heroBtoA.winCount,
            baselineAbsoluteGamesDelta: baseDelta,
            filterAbsoluteGamesDelta: currentDelta,
            asymmetryChanged: baseDelta !== currentDelta,
            baselineThresholdExceeded: baseThreshold,
            filterThresholdExceeded: currentThreshold,
            thresholdChanged: baseThreshold !== currentThreshold,
          };
        }),
      });
    }
  }
  const productionConfig = configurations.find((config) =>
    config.aliases.includes('production'));
  const allConfig = configurations.find((config) =>
    config.aliases.includes('all-ranks'));
  const unknownConfig = configurations.find((config) =>
    config.aliases.includes('unknown-only'));
  const individualConfigs = configurations.filter((config) =>
    config.aliases.some((alias) => alias.startsWith('individual:')));
  const prodAllRankRows = [];
  const individualSumRows = [];
  let anyAsymmetryChanged = false;
  let allFilterResultsComplete = true;
  for (const entry of comparisons) {
    if (entry.status !== 'COMPARED') allFilterResultsComplete = false;
    if (entry.comparisonToProduction?.some((item) =>
      item.status === 'COMPARED' && item.asymmetryChanged)) anyAsymmetryChanged = true;
  }
  for (const pair of pairs) {
    const allRanks = queryResults.find((result) =>
      result.canonicalPairId === pair.canonicalPairId
      && result.filterId === allConfig?.id);
    const prod = queryResults.find((result) =>
      result.canonicalPairId === pair.canonicalPairId
      && result.filterId === productionConfig?.id);
    const unknown = queryResults.find((result) =>
      result.canonicalPairId === pair.canonicalPairId
      && result.filterId === unknownConfig?.id);
    for (const bucket of buckets ?? pair.buckets) {
      const allBucket = allRanks?.perBucket.find((item) => item.bucket === bucket);
      const prodBucket = prod?.perBucket.find((item) => item.bucket === bucket);
      const unknownBucket = unknown?.perBucket.find((item) => item.bucket === bucket);
      for (const direction of ['heroAtoB', 'heroBtoA']) {
        const allCount = allBucket?.[direction]?.matchCount ?? null;
        const prodCount = prodBucket?.[direction]?.matchCount ?? null;
        const unknownCount = unknownBucket?.[direction]?.matchCount ?? null;
        prodAllRankRows.push({
          canonicalPairId: pair.canonicalPairId,
          bucket,
          direction,
          productionMatchCount: prodCount,
          allRankMatchCount: allCount,
          unknownOnlyMatchCount: unknownCount,
          allRankAddedUnknownOrOtherCount: allCount !== null && prodCount !== null
            ? allCount - prodCount : null,
          unknownOnlyAvailable: unknownCount !== null,
        });
        const individualRows = individualConfigs.map((config) => ({
          config,
          result: queryResults.find((result) =>
            result.canonicalPairId === pair.canonicalPairId
            && result.filterId === config.id),
        }));
        const observedCounts = individualRows.map(({ result }) =>
          result?.perBucket.find((item) => item.bucket === bucket)?.[direction]?.matchCount
          ?? null);
        const complete = allCount !== null
          && observedCounts.length > 0
          && observedCounts.every((value) => value !== null);
        const sum = complete ? observedCounts.reduce((total, value) => total + value, 0) : null;
        individualSumRows.push({
          canonicalPairId: pair.canonicalPairId,
          bucket,
          direction,
          allRankMatchCount: allCount,
          individualRankCounts: individualRows.map(({ config }, index) => ({
            filterId: config.id,
            value: observedCounts[index],
          })),
          individualRankSum: sum,
          additiveForThisSample: sum === null ? null : sum === allCount,
          status: enumMeaningHasExplicitOverlap(enumValues)
            ? 'NOT_SUMMED_SCHEMA_OVERLAP_INDICATED'
            : complete ? 'EMPIRICAL_ADDITIVITY_CHECK' : 'INCOMPLETE',
        });
      }
    }
  }
  const additiveRows = individualSumRows.filter((row) =>
    row.additiveForThisSample !== null);
  const rankPartitionStatus = enumMeaningHasExplicitOverlap(enumValues)
    ? 'OVERLAP_INDICATED_NO_SUM_INFERENCE'
    : additiveRows.length > 0 && additiveRows.every((row) => row.additiveForThisSample)
      ? 'EMPIRICALLY_ADDITIVE_FOR_SAMPLE_SCHEMA_MUTUAL_EXCLUSIVITY_UNVERIFIED'
      : additiveRows.length > 0 ? 'NOT_ADDITIVE_FOR_SAMPLE' : 'UNVERIFIED';
  return {
    comparisons,
    productionVsAllRankAndUnknown: prodAllRankRows,
    allRankVsIndividualSum: {
      status: rankPartitionStatus,
      schemaMutualExclusivity: enumMeaningHasExplicitOverlap(enumValues)
        ? 'OVERLAP_INDICATED'
        : 'UNVERIFIED',
      comparedDirectionBuckets: additiveRows.length,
      matchingDirectionBuckets: additiveRows.filter((row) =>
        row.additiveForThisSample).length,
      rows: individualSumRows,
    },
    bracketFilterEffect: {
      status: !allFilterResultsComplete ? 'UNRESOLVED'
        : anyAsymmetryChanged ? 'BRACKET_FILTER_EFFECT_CONFIRMED'
          : 'BRACKET_FILTER_EFFECT_NOT_OBSERVED',
      comparedAgainst: 'production',
      pairFilterComparisonCount: comparisons.length,
      asymmetryChangedInAtLeastOneComparedBucket: anyAsymmetryChanged,
      note: 'Count changes alone do not prove an asymmetry effect; the status is based on a change in absolute reverse-direction matchCount delta.',
    },
    configurationsRun: configurations.map((configuration) => ({
      id: configuration.id,
      aliases: configuration.aliases,
      brackets: configuration.brackets,
    })),
    unknownFilterAvailable: Boolean(unknownConfig),
  };
}

function schemaClaims(schema, mapping) {
  const fields = schema.matchupRow.fields;
  const descriptions = (field) => fields[field]?.description ?? null;
  const semanticStatus = (field) => descriptions(field)
    ? 'SCHEMA_DESCRIPTION_AVAILABLE' : 'UNVERIFIED';
  return {
    matchCount: {
      graphqlType: fields.matchCount?.graphqlType ?? null,
      description: descriptions('matchCount'),
      semanticStatus: descriptions('matchCount') ? 'SCHEMA_DESCRIPTION_AVAILABLE'
        : 'SUPPORTED_BY_MATCHLIMIT_ARGUMENT_DESCRIPTION',
      evidence: schema.matchUp.arguments.matchLimit?.description ?? null,
    },
    winCount: {
      graphqlType: fields.winCount?.graphqlType ?? null,
      description: descriptions('winCount'),
      semanticStatus: semanticStatus('winCount'),
    },
    winRateHeroId1: {
      graphqlType: fields.winRateHeroId1?.graphqlType ?? null,
      description: descriptions('winRateHeroId1'),
      semanticStatus: semanticStatus('winRateHeroId1'),
    },
    winRateHeroId2: {
      graphqlType: fields.winRateHeroId2?.graphqlType ?? null,
      description: descriptions('winRateHeroId2'),
      semanticStatus: semanticStatus('winRateHeroId2'),
    },
    winsAverage: {
      graphqlType: fields.winsAverage?.graphqlType ?? null,
      description: descriptions('winsAverage'),
      semanticStatus: semanticStatus('winsAverage'),
    },
    reverseMatchCountEquality: {
      status: 'UNVERIFIED',
      reason: 'Introspection exposes no schema-level invariant requiring reverse-direction matchCount equality.',
    },
    bracketMapping: mapping,
  };
}

function rawPairObservations(pairs, queryResults) {
  return pairs.map((pair) => ({
    canonicalPairId: pair.canonicalPairId,
    heroAId: pair.heroAId,
    heroBId: pair.heroBId,
    heroA: pair.heroA,
    heroB: pair.heroB,
    filters: queryResults.filter((result) =>
      result.canonicalPairId === pair.canonicalPairId).map((result) => ({
      filterId: result.filterId,
      brackets: result.brackets,
      requestId: result.requestId,
      queryHash: result.queryHash,
      responseHash: result.responseHash,
      status: result.status,
      orientationStatus: result.orientationIssues.length === 0
        ? 'VERIFIED' : 'ORIENTATION_MISMATCH',
      orientationIssues: result.orientationIssues,
      missingBuckets: result.missingBuckets,
      perBucket: result.perBucket,
      aggregate: result.aggregate,
      aggregateDiagnosis: result.aggregateDiagnosis,
    })),
  }));
}

export function makeRootCauseAssessment(filterAnalysis, semantics, samplePairs) {
  const effect = filterAnalysis.bracketFilterEffect.status;
  const temporalHold = semantics.reverseMatchCountEquality.status === 'UNVERIFIED';
  return {
    status: 'UNRESOLVED',
    category: 'UNRESOLVED',
    productionPublishAllowed: false,
    hypotheses: [
      {
        category: 'BRACKET_FILTER_EFFECT',
        status: effect,
        evidence: filterAnalysis.bracketFilterEffect,
      },
      {
        category: 'UNKNOWN_RANK_CONTRIBUTION',
        status: filterAnalysis.unknownFilterAvailable
          ? 'MEASURED_SEE_PER_PAIR_RESULTS' : 'NOT_AVAILABLE_IN_SCHEMA',
        evidence: filterAnalysis.productionVsAllRankAndUnknown,
      },
      {
        category: 'BRACKET_FILTER_SEMANTICS',
        status: semantics.bracketMapping?.intendedRankRangeStatus ?? 'UNVERIFIED',
        evidence: semantics.bracketMapping ?? null,
      },
      {
        category: 'PERSISTENT_DIRECTIONAL_ASYMMETRY',
        status: samplePairs.some((pair) => pair.filters.some((filter) =>
          filter.aggregateDiagnosis?.thresholdExceeded === true))
          ? 'OBSERVED_NOT_CAUSAL' : 'NOT_OBSERVED_IN_SAMPLE',
        evidence: samplePairs,
      },
      {
        category: 'WINCOUNT_SEMANTICS',
        status: semantics.winCount?.empirical?.winCountInterpretation ?? 'UNVERIFIED',
        evidence: semantics.winCount,
      },
    ],
    explanation: temporalHold
      ? 'FIX12 measures filter-dependent counts and sampled rate alignments, but schema semantics do not define reverse-direction equality or all rank value meanings. A filter effect, even if observed, does not by itself establish the complete root cause.'
      : 'Available comparisons do not establish a single causal explanation for the reverse-pair asymmetry.',
  };
}

export function normalizeResponseForHash(response) {
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

export function normalizedResponseSha256(response) {
  return sha256(JSON.stringify(normalizeResponseForHash(response)));
}

export async function runFix12Research(deps = {}) {
  const read = deps.readFileSync ?? readFileSync;
  const sourcesBefore = captureSourceHashes(read);
  const protectedSources = verifyProtectedSourceHashes(sourcesBefore, read);
  const input = protectedSources.input;
  const fix11 = protectedSources.fix11;
  const buckets = input.attemptedWindow.buckets;
  const heroesData = parseJson(SOURCE_PATHS.productionHeroes, read);
  const heroRows = Array.isArray(heroesData) ? heroesData : heroesData.heroes ?? [];
  const heroNames = new Map(heroRows.map((hero) => [
    Number(hero.id ?? hero.hero_id),
    hero.localized_name ?? hero.name ?? `Hero ${hero.id ?? hero.hero_id}`,
  ]));
  const pairs = selectStratifiedPairs(
    fix11.anomalyAnalysis.perBucket.anomalyInventory,
  ).map((pair) => ({
    ...pair,
    heroA: heroNames.get(pair.heroAId) ?? `Hero ${pair.heroAId}`,
    heroB: heroNames.get(pair.heroBId) ?? `Hero ${pair.heroBId}`,
  }));
  const now = deps.now ?? (() => new Date());
  const token = (deps.loadToken ?? loadToken)();
  const Transport = deps.StratzTransport ?? StratzTransport;
  const introspectionQuery = makeRankSchemaIntrospectionQuery();
  const introspectionResult = await executeDiagnosticQuery({
    requestId: 'fix12-rank-schema-introspection',
    query: introspectionQuery,
    Transport,
    token,
    now,
    validate: (response) => {
      if (!response?.data?.rankBracketBasicEnum
        || !response?.data?.heroStatsQuery
        || !response?.data?.matchupRow) {
        throw new Error('Rank enum or matchup schema introspection result is incomplete');
      }
      const summary = summarizeRankSchema(response);
      if (!summary.enum.values.length) throw new Error('RankBracketBasicEnum returned no values');
      return { summary };
    },
  });
  const rawArtifact = {
    schemaVersion: 1,
    source: 'STRATZ production GraphQL via production StratzTransport',
    tokenPersisted: false,
    createdAt: now().toISOString(),
    schemaIntrospection: {
      query: introspectionQuery,
      requestHash: introspectionResult.record.requestHash,
      responseHash: introspectionResult.record.responseHash,
      status: introspectionResult.record.status,
      summary: introspectionResult.response
        ? summarizeRankSchema(introspectionResult.response) : null,
      response: introspectionResult.response,
      error: introspectionResult.record.error,
      transportCreated: introspectionResult.record.transportCreated,
      transportClosed: introspectionResult.record.transportClosed,
    },
    queryResponses: {},
  };
  const queryRecords = [];
  const queryResults = [];
  let mapping = null;
  let filterConfigurations = [];
  let schema = null;
  if (introspectionResult.response) {
    schema = summarizeRankSchema(introspectionResult.response);
    mapping = mapProductionBrackets(schema.enum.values, BRACKETS);
    const bracketArgument = schema.matchUp.arguments.bracketBasicIds;
    filterConfigurations = createBracketFilterConfigurations(
      schema.enum.values,
      BRACKETS,
      bracketArgument?.nullable === true,
    );
    const requiredFields = ['winRateHeroId1', 'winRateHeroId2', 'winsAverage'];
    const missingFields = requiredFields.filter((field) =>
      !schema.matchupRow.fields[field]);
    if (missingFields.length) {
      queryRecords.push({
        requestId: 'diagnostic-field-selection',
        status: 'NOT_RUN',
        error: `Schema does not expose diagnostic fields: ${missingFields.join(', ')}`,
      });
    } else {
      const delay = deps.delay ?? ((ms) =>
        new Promise((resolve) => setTimeout(resolve, ms)));
      const total = pairs.length * filterConfigurations.length;
      let completed = 0;
      for (const pair of pairs) {
        for (const configuration of filterConfigurations) {
          const requestId = `pair-${pair.canonicalPairId.replace(':', '-')}-filter-${configuration.id.replace(/[^A-Za-z0-9-]/g, '-')}`;
          const { query, productionQuery } = buildDiagnosticPairQuery({
            heroIds: [pair.heroAId, pair.heroBId],
            buckets,
            bracketFilter: configuration.brackets,
            bracketArgumentNullable: bracketArgument?.nullable === true,
            buildQuery: deps.buildChunkQuery ?? buildChunkQuery,
          });
          const result = await executeDiagnosticQuery({
            requestId,
            query,
            requestedHeroIds: [pair.heroAId, pair.heroBId],
            buckets,
            Transport,
            token,
            now,
            validate: (response) => validateDiagnosticResponse(
              response,
              [pair.heroAId, pair.heroBId],
              buckets,
              requiredFields,
            ),
          });
          const record = {
            ...result.record,
            canonicalPairId: pair.canonicalPairId,
            heroIds: [pair.heroAId, pair.heroBId],
            filterId: configuration.id,
            filterAliases: configuration.aliases,
            brackets: configuration.brackets,
            buckets,
            take: 200,
            bucketSeconds: BUCKET_SEC,
            productionQueryHash: sha256(productionQuery),
            diagnosticSelectionFields: [
              'heroId1',
              'heroId2',
              'matchCount',
              'winCount',
              'winRateHeroId1',
              'winRateHeroId2',
              'winsAverage',
            ],
          };
          queryRecords.push(record);
          if (result.response) {
            rawArtifact.queryResponses[requestId] = {
              query,
              response: result.response,
              responseSha256: result.record.responseHash,
            };
            const extracted = extractPairRows(result.response, pair, buckets);
            const comparison = comparePairDirections(
              pair,
              extracted.perBucket,
              configuration.id,
            );
            queryResults.push({
              canonicalPairId: pair.canonicalPairId,
              heroAId: pair.heroAId,
              heroBId: pair.heroBId,
              filterId: configuration.id,
              brackets: configuration.brackets,
              requestId,
              queryHash: result.record.requestHash,
              responseHash: result.record.responseHash,
              status: result.record.status,
              ...comparison,
              orientationIssues: extracted.orientationIssues,
            });
          }
          completed += 1;
          if (completed < total) await delay(deps.delayMs ?? 100);
        }
      }
    }
  }
  const filterAnalysis = schema && mapping
    ? compileFilterAnalysis(pairs, filterConfigurations, queryResults, schema.enum.values, buckets)
    : {
      comparisons: [],
      productionVsAllRankAndUnknown: [],
      allRankVsIndividualSum: { status: 'UNVERIFIED', rows: [] },
      bracketFilterEffect: { status: 'UNRESOLVED' },
      configurationsRun: [],
      unknownFilterAvailable: false,
    };
  const winRows = buildWinRateRows(pairs, queryResults);
  const winCountSemantics = queryRateEvidence(winRows);
  const semantics = {
    ...(schema ? schemaClaims(schema, mapping) : {}),
    winCount: {
      ...(schema ? schemaClaims(schema, mapping).winCount : {}),
      empirical: winCountSemantics,
    },
    winRateHeroId1: {
      ...(schema ? schemaClaims(schema, mapping).winRateHeroId1 : {}),
      empirical: {
        matchingDirectRatioCount: winCountSemantics.directHero1Matches,
        comparedRows: winCountSemantics.ratesAvailableCount,
        maximumObservedTolerance: winCountSemantics.rateToleranceMax,
      },
    },
    winRateHeroId2: {
      ...(schema ? schemaClaims(schema, mapping).winRateHeroId2 : {}),
      empirical: {
        matchingComplementRatioCount: winCountSemantics.inverseHero2Matches,
        comparedRows: winCountSemantics.ratesAvailableCount,
        maximumObservedTolerance: winCountSemantics.rateToleranceMax,
      },
    },
    winsAverage: {
      ...(schema ? schemaClaims(schema, mapping).winsAverage : {}),
      empirical: {
        status: winCountSemantics.winsAverageSemantics,
        availableRows: winCountSemantics.winsAverageAvailableCount,
        matchesRateMean: winCountSemantics.winsAverageMatchesRateMean,
        matchesWinCount: winCountSemantics.winsAverageMatchesWinCount,
      },
    },
  };
  const sampleComparisons = rawPairObservations(pairs, queryResults);
  const rootCause = makeRootCauseAssessment(filterAnalysis, semantics, sampleComparisons);
  const sourcesAfter = captureSourceHashes(read);
  const sourceHashesUnchanged = Object.keys(sourcesBefore).every((name) =>
    sourcesBefore[name].physicalSha256 === sourcesAfter[name].physicalSha256
    && sourcesBefore[name].canonicalSha256 === sourcesAfter[name].canonicalSha256);
  if (!sourceHashesUnchanged) {
    throw new Error('One or more protected FIX9–FIX11 or production source files changed during FIX12');
  }
  rawArtifact.createdAt = now().toISOString();
  const rawBytes = Buffer.from(`${JSON.stringify(rawArtifact, null, 2)}\n`);
  const evidence = {
    schemaVersion: 1,
    diagnostic: 'TZ #76-FIX12 STRATZ bracket filter and matchup field semantics',
    createdAt: rawArtifact.createdAt,
    productionParameters: {
      builder: 'scripts/update-data-stratz.mjs:buildChunkQuery',
      transport: 'scripts/update-data-stratz.mjs:StratzTransport',
      tokenLoader: 'scripts/update-data-stratz.mjs:loadToken',
      buckets,
      bucketSeconds: BUCKET_SEC,
      brackets: BRACKETS,
      take: 200,
      productionQueryUnmodified: true,
    },
    sourceHashes: {
      before: sourcesBefore,
      after: sourcesAfter,
      unchanged: sourceHashesUnchanged,
    },
    upstreamEvidence: {
      fix9CanonicalSha256: input.inputSha256,
      fix10CanonicalSha256: protectedSources.repeatability.evidenceSha256,
      fix11CanonicalSha256: fix11.evidenceSha256,
      fix11RootCauseStatus: fix11.rootCause.status,
      fix11ProductionPublishAllowed: fix11.rootCause.productionPublishAllowed,
    },
    schemaIntrospection: {
      status: introspectionResult.record.status,
      queryHash: introspectionResult.record.requestHash,
      responseHash: introspectionResult.record.responseHash,
      schema,
      bracketMapping: mapping,
      noBracketFilterAllowed: schema?.matchUp.bracketBasicIdsNullable ?? false,
    },
    selectedPairs: pairs.map((pair) => ({
      canonicalPairId: pair.canonicalPairId,
      heroAId: pair.heroAId,
      heroBId: pair.heroBId,
      heroA: pair.heroA,
      heroB: pair.heroB,
      buckets: pair.buckets,
      signedDeltaSigns: pair.signedDeltaSigns,
      selectionRationale: pair.selectionRationale,
    })),
    filterConfigurations: filterAnalysis.configurationsRun,
    querySummary: {
      plannedPairFilterRequests: pairs.length * filterConfigurations.length,
      completedPairFilterRequests: queryRecords.filter((record) =>
        record.filterId && record.status === 'VERIFIED').length,
      failedPairFilterRequests: queryRecords.filter((record) =>
        record.filterId && record.status !== 'VERIFIED').length,
      queryCountIncludingIntrospection: queryRecords.filter((record) =>
        record.filterId).length + 1,
      transportsCreated: queryRecords.filter((record) =>
        record.transportCreated).length + Number(introspectionResult.record.transportCreated),
      transportsClosed: queryRecords.filter((record) =>
        record.transportClosed).length + Number(introspectionResult.record.transportClosed),
      requests: queryRecords,
    },
    pairFilterComparisons: filterAnalysis.comparisons,
    productionVsAllRankAndUnknown: filterAnalysis.productionVsAllRankAndUnknown,
    rankPartitionCheck: filterAnalysis.allRankVsIndividualSum,
    bracketFilterEffect: filterAnalysis.bracketFilterEffect,
    winCountSemantics,
    fieldSemantics: semantics,
    rootCauseHypotheses: rootCause.hypotheses,
    rootCause,
    rawResponseArtifact: {
      path: path.relative(ROOT, BRACKET_RAW_PATH),
      responseCount: Object.keys(rawArtifact.queryResponses).length,
      sha256: sha256(rawBytes),
      canonicalSha256: canonicalJsonSha256(rawArtifact),
    },
    evidenceSha256: null,
  };
  evidence.evidenceSha256 = canonicalJsonSha256(evidence, 'evidenceSha256');
  const tokenString = JSON.stringify([rawArtifact, evidence]);
  if (token && tokenString.includes(token)) {
    throw new Error('FIX12 evidence unexpectedly contains the STRATZ token');
  }
  if ((deps.existsSync ?? existsSync)(deps.evidencePath ?? BRACKET_EVIDENCE_PATH)
    || (deps.existsSync ?? existsSync)(deps.rawPath ?? BRACKET_RAW_PATH)) {
    throw new Error('FIX12 output already exists; refusing to overwrite saved evidence');
  }
  const write = deps.writeFileSync ?? writeFileSync;
  write(deps.rawPath ?? BRACKET_RAW_PATH, rawBytes, { flag: 'wx' });
  write(deps.evidencePath ?? BRACKET_EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  return evidence;
}

export function verifyFix12Evidence(evidence, rawArtifact, sourcesBefore, sourcesAfter) {
  if (evidence.evidenceSha256 !== canonicalJsonSha256(evidence, 'evidenceSha256')) {
    throw new Error('FIX12 evidence canonical hash mismatch');
  }
  if (evidence.rawResponseArtifact.canonicalSha256 !== canonicalJsonSha256(rawArtifact)) {
    throw new Error('FIX12 raw response canonical hash mismatch');
  }
  if (!evidence.sourceHashes.unchanged
    || JSON.stringify(canonicalize(sourcesBefore)) !== JSON.stringify(canonicalize(sourcesAfter))
    || JSON.stringify(canonicalize(evidence.sourceHashes.before))
      !== JSON.stringify(canonicalize(sourcesBefore))
    || JSON.stringify(canonicalize(evidence.sourceHashes.after))
      !== JSON.stringify(canonicalize(sourcesAfter))
    || !evidence.rootCause
    || evidence.rootCause.status !== 'UNRESOLVED'
    || evidence.rootCause.productionPublishAllowed !== false) {
    throw new Error('FIX12 source protection or unresolved root-cause invariant failed');
  }
  return { status: 'PASS', evidenceSha256: evidence.evidenceSha256 };
}

function containsSensitiveHeaderKey(value) {
  if (Array.isArray(value)) return value.some(containsSensitiveHeaderKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    /^(authorization|cookie|set-cookie)$/i.test(key)
    || containsSensitiveHeaderKey(child));
}

export function runFix12Check(deps = {}) {
  const read = deps.readFileSync ?? readFileSync;
  const evidencePath = deps.evidencePath ?? BRACKET_EVIDENCE_PATH;
  const rawPath = deps.rawPath ?? BRACKET_RAW_PATH;
  const evidence = parseJson(evidencePath, read);
  const rawBytes = read(rawPath);
  const rawArtifact = JSON.parse(rawBytes.toString('utf8'));
  if (sha256(rawBytes) !== evidence.rawResponseArtifact.sha256) {
    throw new Error('FIX12 raw response physical SHA-256 mismatch');
  }
  if (containsSensitiveHeaderKey(rawArtifact) || containsSensitiveHeaderKey(evidence)) {
    throw new Error('FIX12 artifact contains an authorization or cookie header');
  }
  const sourcesBefore = captureSourceHashes(read);
  verifyProtectedSourceHashes(sourcesBefore, read);
  const sourcesAfter = captureSourceHashes(read);
  const verified = verifyFix12Evidence(evidence, rawArtifact, sourcesBefore, sourcesAfter);
  for (const request of evidence.querySummary.requests.filter((item) => item.filterId)) {
    const saved = rawArtifact.queryResponses[request.requestId];
    if (request.status === 'VERIFIED' && !saved) {
      throw new Error(`Validated response is missing from raw archive: ${request.requestId}`);
    }
    if (saved && (sha256(saved.query) !== request.requestHash
      || normalizedResponseSha256(saved.response) !== request.responseHash
      || saved.responseSha256 !== request.responseHash)) {
      throw new Error(`FIX12 query or response hash mismatch: ${request.requestId}`);
    }
  }
  if (evidence.schemaIntrospection.status === 'VERIFIED'
    && (!rawArtifact.schemaIntrospection.response
      || normalizedResponseSha256(rawArtifact.schemaIntrospection.response)
        !== evidence.schemaIntrospection.responseHash)) {
    throw new Error('FIX12 schema introspection response hash mismatch');
  }
  return {
    ...verified,
    queryCount: evidence.querySummary.queryCountIncludingIntrospection,
    rawResponseCount: Object.keys(rawArtifact.queryResponses).length,
    productionPublishAllowed: evidence.rootCause.productionPublishAllowed,
    rootCause: evidence.rootCause.status,
  };
}

async function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  if (command === 'run') {
    const evidence = await runFix12Research();
    console.log(JSON.stringify({
      status: 'PASS',
      evidence: BRACKET_EVIDENCE_PATH,
      rawResponses: BRACKET_RAW_PATH,
      querySummary: evidence.querySummary,
      bracketFilterEffect: evidence.bracketFilterEffect,
      winCountSemantics: evidence.winCountSemantics,
      rootCause: evidence.rootCause,
    }, null, 2));
    return;
  }
  if (command === 'check') {
    console.log(JSON.stringify(runFix12Check(), null, 2));
    return;
  }
  throw new Error('Usage: node scripts/stratz-matchup-bracket-semantics.mjs <run|check>');
}

if (process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[STRATZ FIX12] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
