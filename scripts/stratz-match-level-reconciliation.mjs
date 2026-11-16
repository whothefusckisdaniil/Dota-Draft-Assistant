#!/usr/bin/env node
// TZ #76-FIX14: STRATZ match-level reverse-pair reconciliation.
//
// 1. Full GraphQL schema introspection through the production StratzTransport.
// 2. Generic discovery of match-level capabilities from the introspected schema
//    (no field or endpoint name is assumed to exist).
// 3. Match-ID collection only if the schema exposes an unscoped endpoint that
//    can enumerate matches by hero pair, week and rank bracket. Otherwise the
//    result is MATCH_LEVEL_EVIDENCE_UNAVAILABLE and no substitute is simulated.
// 4. Offline cross-check of aggregate counts across FIX9–FIX13 archives.
//
// FIX9–FIX13 artifacts and production data are read-only and hash-verified.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRACKETS, BUCKET_SEC, StratzTransport, loadToken } from './update-data-stratz.mjs';
import { canonicalJsonSha256 } from './stratz-matchup-root-cause-research.mjs';
import { executeDiagnosticQuery } from './stratz-matchup-bracket-semantics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MATCH_LEVEL_EVIDENCE_PATH = path.join(
  ROOT, 'research/data-quality/stratz-reverse-pair-match-level-evidence.json',
);
export const MATCH_LEVEL_RAW_PATH = path.join(
  ROOT, 'research/data-quality/stratz-reverse-pair-match-level-raw-responses.json',
);

const SOURCE_PATHS = Object.freeze({
  fix9Input: 'scripts/stratz-diagnostic-input.json',
  fix10Repeatability: 'research/data-quality/stratz-reverse-pair-repeatability-evidence.json',
  fix10Report: 'research/data-quality/stratz-reverse-pair-asymmetry-report.json',
  fix11Evidence: 'research/data-quality/stratz-reverse-pair-root-cause-evidence.json',
  fix11Raw: 'research/data-quality/stratz-reverse-pair-root-cause-raw-responses.json',
  fix12Evidence: 'research/data-quality/stratz-reverse-pair-bracket-semantics-evidence.json',
  fix12Raw: 'research/data-quality/stratz-reverse-pair-bracket-raw-responses.json',
  fix13Evidence: 'research/data-quality/stratz-reverse-pair-partition-semantics-evidence.json',
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
  fix13Evidence: '7166a0d95b4429076c7b387198928a0e885ca413c85d886d3134dee4a660f9fe',
  productionHeroes: '59ecc2bc9b55a62232bf7d40b85c1d4c306602e89addda6d3faa9ed38a2c061d',
  productionMatchups: '0a9e54aaa925494f7ad876c992e782cfd45d297b3952c8afefb8decc3ad02e8b',
  productionMeta: '9db099dedf5c5f0d052590d98d194807e2580a16694fc562ae9ffbf1d144857e',
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function captureSourceHashes(read = readFileSync, root = ROOT) {
  return Object.fromEntries(Object.entries(SOURCE_PATHS).map(([name, relative]) => [
    name,
    { path: relative, physicalSha256: sha256(read(path.join(root, relative))) },
  ]));
}

export function verifySourceHashes(hashes, expected = EXPECTED_PHYSICAL_SHA256) {
  const mismatches = Object.entries(expected)
    .filter(([name, value]) => hashes[name]?.physicalSha256 !== value)
    .map(([name]) => name);
  if (mismatches.length) throw new Error(`Protected source hash mismatch: ${mismatches.join(', ')}`);
  return true;
}

// ---------------------------------------------------------------------------
// §3 Schema introspection & capability discovery
// ---------------------------------------------------------------------------

const TYPE_REF = 'kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }';

export function makeFullIntrospectionQuery() {
  return `query FullSchema { __schema { queryType { name } types { kind name description
    fields(includeDeprecated: true) { name description isDeprecated
      args { name description defaultValue type { ${TYPE_REF} } }
      type { ${TYPE_REF} } }
    inputFields { name description defaultValue type { ${TYPE_REF} } }
    enumValues(includeDeprecated: true) { name description isDeprecated } } } }`;
}

export function typeString(type) {
  if (!type) return null;
  if (type.kind === 'NON_NULL') return `${typeString(type.ofType)}!`;
  if (type.kind === 'LIST') return `[${typeString(type.ofType)}]`;
  return type.name;
}

const namedType = (type) => (type?.ofType ? namedType(type.ofType) : type?.name ?? null);
const isList = (type) => (type?.kind === 'LIST' ? true : type?.ofType ? isList(type.ofType) : false);

const describeArg = (arg) => ({
  name: arg.name,
  graphqlType: typeString(arg.type),
  nullable: arg.type?.kind !== 'NON_NULL',
  description: arg.description ?? null,
});

/** Look a field up by exact name. Never returns a field that is not in the schema. */
export function findField(types, typeName, fieldName) {
  const type = types.get(typeName);
  const field = type?.fields?.find((item) => item.name === fieldName);
  if (!field) return { name: fieldName, found: false };
  return {
    name: fieldName,
    found: true,
    graphqlType: typeString(field.type),
    nullable: field.type?.kind !== 'NON_NULL',
    description: field.description ?? null,
    args: field.args.map(describeArg),
  };
}

const HERO_ARG = /^(heroId|heroIds|withHeroId|againstHeroId|withEnemyHeroIds|withFriendHeroIds|withEnemyHeroId|withFriendHeroId|byHeroId)$/;
const TIME_ARG = /^(week|startDateTime|endDateTime|after|before|day)$/;
const BRACKET_ARG = /^(bracketBasicIds|bracketIds|rankIds|bracket|rank)$/;
const PAGE_ARG = /^(skip|take|cursor|after|before|first|last)$/;
const ENTITY_ID_ARG = /^(id|ids|steamAccountId|steamAccountIds|teamId|teamIds|leagueId|seriesId|matchReplayUploadTeamId|matchId|matchIds)$/;

/** Flatten a field's arguments, expanding input-object arguments one level. */
function flattenArgs(types, field) {
  const out = [];
  for (const arg of field.args ?? []) {
    out.push({ ...describeArg(arg), via: null });
    const input = types.get(namedType(arg.type));
    if (input?.kind === 'INPUT_OBJECT') {
      for (const inner of input.inputFields ?? []) {
        out.push({ ...describeArg(inner), via: arg.name, viaRequired: arg.type?.kind === 'NON_NULL' });
      }
    }
  }
  return out;
}

/**
 * Identify the match type from the schema itself: the return type of a root
 * field that takes exactly one required ID argument and whose return type has
 * an `id` field and a list of participants carrying `heroId`.
 */
function discoverMatchType(types, rootType) {
  for (const field of rootType.fields ?? []) {
    const required = (field.args ?? []).filter((arg) => arg.type?.kind === 'NON_NULL');
    if (required.length !== 1 || required[0].name !== 'id' || isList(field.type)) continue;
    const candidate = types.get(namedType(field.type));
    const hasId = candidate?.fields?.some((item) => item.name === 'id');
    const participants = candidate?.fields?.find((item) =>
      isList(item.type) && types.get(namedType(item.type))?.fields?.some((inner) => inner.name === 'heroId'));
    if (hasId && participants) {
      return { typeName: candidate.name, rootField: field.name, participantsField: participants.name, participantType: namedType(participants.type) };
    }
  }
  return null;
}

/**
 * Walk the schema from the query root and classify every reachable field that
 * yields match identities. Returns a deterministic, schema-derived report.
 */
export function discoverMatchLevelCapabilities(schemaData, maxDepth = 4) {
  const schema = schemaData?.__schema;
  if (!schema?.types || !schema.queryType?.name) {
    return { status: 'UNVERIFIED', reason: 'Introspection response does not contain __schema.types' };
  }
  const types = new Map(schema.types.map((type) => [type.name, type]));
  const rootType = types.get(schema.queryType.name);
  const matchType = discoverMatchType(types, rootType);
  const carriers = new Set(schema.types
    .filter((type) => type.kind === 'OBJECT' && type.fields?.some((field) => field.name === 'matchId'))
    .map((type) => type.name));
  if (matchType) carriers.add(matchType.typeName);

  const endpoints = [];
  const queue = [{ typeName: rootType.name, hops: [] }];
  const seen = new Set([rootType.name]);
  while (queue.length) {
    const { typeName, hops } = queue.shift();
    if (hops.length >= maxDepth) continue;
    for (const field of types.get(typeName)?.fields ?? []) {
      const target = namedType(field.type);
      const hop = {
        typeName,
        field: field.name,
        returns: typeString(field.type),
        description: field.description ?? null,
        args: flattenArgs(types, field),
      };
      const nextHops = [...hops, hop];
      if (carriers.has(target) && isList(field.type)) endpoints.push({ hops: nextHops, carrierType: target });
      const targetType = types.get(target);
      if (targetType?.kind === 'OBJECT' && !seen.has(target) && !carriers.has(target)) {
        seen.add(target);
        queue.push({ typeName: target, hops: nextHops });
      }
    }
  }

  const classified = endpoints.map(({ hops, carrierType }) => {
    const args = hops.flatMap((hop) => hop.args);
    const requiredEntity = hops.flatMap((hop) => hop.args
      .filter((arg) => ENTITY_ID_ARG.test(arg.name) && !arg.nullable && (arg.via === null || arg.viaRequired))
      .map((arg) => `${hop.typeName}.${hop.field}(${arg.via ? `${arg.via}.` : ''}${arg.name})`));
    const heroArgs = [...new Set(args.filter((arg) => HERO_ARG.test(arg.name)).map((arg) => arg.name))];
    const heroPairFilter = heroArgs.length >= 2
      || args.some((arg) => HERO_ARG.test(arg.name) && arg.graphqlType?.startsWith('['));
    const timeFilter = args.some((arg) => TIME_ARG.test(arg.name) && arg.name !== 'after' && arg.name !== 'before')
      || args.some((arg) => (arg.name === 'after' || arg.name === 'before') && /Long/.test(arg.graphqlType ?? ''));
    const bracketFilter = args.some((arg) => BRACKET_ARG.test(arg.name));
    const pagination = [...new Set(args.filter((arg) => PAGE_ARG.test(arg.name)).map((arg) => arg.name))];
    const scope = requiredEntity.length ? 'ENTITY_SCOPED' : 'UNSCOPED';
    return {
      path: hops.map((hop) => hop.field).join('.'),
      carrierType,
      returns: hops.at(-1).returns,
      descriptions: hops.map((hop) => hop.description),
      scope,
      requiredEntityArguments: requiredEntity,
      heroArguments: heroArgs,
      heroPairFilter,
      timeFilter,
      bracketFilter,
      paginationArguments: pagination,
      populationCandidate: scope === 'UNSCOPED' && heroPairFilter && timeFilter && bracketFilter,
    };
  }).sort((a, b) => a.path.localeCompare(b.path));

  // The aggregate matchup endpoint used in production: does it drill down to matches?
  const heroStatsRoot = rootType.fields.find((field) => field.name === 'heroStats');
  const heroStatsType = heroStatsRoot ? namedType(heroStatsRoot.type) : null;
  const matchUp = heroStatsType ? findField(types, heroStatsType, 'matchUp') : { found: false };
  const matchUpField = types.get(heroStatsType)?.fields?.find((field) => field.name === 'matchUp');
  const dryadType = matchUpField ? namedType(matchUpField.type) : null;
  const rowTypes = dryadType
    ? [dryadType, ...new Set((types.get(dryadType)?.fields ?? [])
      .filter((field) => types.get(namedType(field.type))?.kind === 'OBJECT')
      .map((field) => namedType(field.type)))]
    : [];
  const aggregateRowFields = rowTypes.map((name) => ({
    typeName: name,
    fields: (types.get(name)?.fields ?? []).map((field) => ({
      name: field.name,
      graphqlType: typeString(field.type),
      description: field.description ?? null,
    })),
    matchIdentityFields: (types.get(name)?.fields ?? [])
      .filter((field) => field.name === 'matchId' || field.name === 'matchIds' || carriers.has(namedType(field.type)))
      .map((field) => field.name),
  }));

  const matchTypeFields = matchType ? {
    typeName: matchType.typeName,
    lookupRootField: findField(types, rootType.name, matchType.rootField),
    fields: ['id', 'startDateTime', 'endDateTime', 'didRadiantWin', 'bracket', 'rank', 'actualRank', 'averageRank', 'lobbyType', 'gameMode', 'isStats', matchType.participantsField]
      .map((name) => findField(types, matchType.typeName, name)),
    participantType: matchType.participantType,
    participantFields: ['matchId', 'heroId', 'isRadiant', 'isVictory', 'playerSlot', 'steamAccountId']
      .map((name) => findField(types, matchType.participantType, name)),
  } : null;

  const populationCandidates = classified.filter((item) => item.populationCandidate);
  return {
    status: populationCandidates.length ? 'MATCH_LEVEL_ENDPOINT_CANDIDATE_FOUND' : 'MATCH_LEVEL_EVIDENCE_UNAVAILABLE',
    queryRootType: rootType.name,
    typeCount: schema.types.length,
    matchType: matchTypeFields,
    matchIdentityCarrierTypes: [...carriers].sort(),
    aggregateEndpoint: {
      path: heroStatsRoot && matchUp.found ? `${heroStatsRoot.name}.matchUp` : null,
      field: matchUp,
      rowTypes: aggregateRowFields,
      exposesMatchIdentities: aggregateRowFields.some((row) => row.matchIdentityFields.length > 0),
      paginationUnit: 'skip/take page over hero dryad rows (argument descriptions); no match-level cursor',
    },
    matchListEndpoints: classified,
    populationCandidates: populationCandidates.map((item) => item.path),
    criteria: 'A population endpoint must be reachable without a required entity ID (player/team/league/match), must accept a hero-pair filter, a time filter and a rank-bracket filter, and must return match identities.',
  };
}

// ---------------------------------------------------------------------------
// §5–§9 Match-level primitives (only applied when match identities exist)
// ---------------------------------------------------------------------------

export function collectMatchIds(records, idField = 'id') {
  const counts = new Map();
  let missing = 0;
  for (const record of records ?? []) {
    const id = record?.[idField];
    if (id === null || id === undefined || id === '') {
      missing += 1;
      continue;
    }
    const key = String(id);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sortIds = (ids) => ids.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  return {
    returnedRecords: (records ?? []).length,
    missingIdRecords: missing,
    uniqueIds: sortIds([...counts.keys()]),
    duplicateIds: sortIds([...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id)),
  };
}

/**
 * pages: [{ cursor, ids, error? }] in request order. Complete only when the
 * last page is short (< take) and no error/loop occurred.
 */
export function assessPagination(pages, { take }) {
  if (!pages?.length) return { status: 'UNVERIFIED', pages: 0, reason: 'NO_PAGES' };
  const cursors = new Set();
  const signatures = new Set();
  for (const [index, page] of pages.entries()) {
    const cursorKey = JSON.stringify(page.cursor ?? null);
    const signature = (page.ids ?? []).join(',');
    if (cursors.has(cursorKey) || (signature && signatures.has(signature))) {
      return { status: 'LOOP_DETECTED', pages: pages.length, loopAtPage: index };
    }
    cursors.add(cursorKey);
    if (signature) signatures.add(signature);
    if (page.error) return { status: 'INCOMPLETE', pages: pages.length, reason: 'PAGE_ERROR', errorAtPage: index };
  }
  const last = pages.at(-1);
  if (!Number.isInteger(take) || take <= 0) return { status: 'UNVERIFIED', pages: pages.length, reason: 'UNKNOWN_PAGE_SIZE' };
  if ((last.ids ?? []).length >= take) return { status: 'INCOMPLETE', pages: pages.length, reason: 'LAST_PAGE_FULL' };
  return { status: 'COMPLETE', pages: pages.length };
}

/** a, b: { ids: string[], complete: boolean } */
export function compareMatchSets(a, b) {
  const setA = new Set(a?.ids ?? []);
  const setB = new Set(b?.ids ?? []);
  const intersection = [...setA].filter((id) => setB.has(id));
  const onlyA = [...setA].filter((id) => !setB.has(id));
  const onlyB = [...setB].filter((id) => !setA.has(id));
  const complete = a?.complete === true && b?.complete === true;
  return {
    countAtoB: setA.size,
    countBtoA: setB.size,
    intersectionCount: intersection.length,
    onlyAtoB: onlyA,
    onlyBtoA: onlyB,
    unionCount: new Set([...setA, ...setB]).size,
    // An empty or partial set from an incomplete source never proves a zero population.
    status: !complete ? 'INCOMPLETE'
      : onlyA.length === 0 && onlyB.length === 0 ? 'EQUAL_SETS' : 'DIFFERENT_SETS',
  };
}

export function reconcileCount(matchLevelCount, aggregateCount, matchLevelComplete) {
  if (!Number.isInteger(aggregateCount)) return { status: 'AGGREGATE_UNAVAILABLE', difference: null };
  if (!Number.isInteger(matchLevelCount) || matchLevelComplete !== true) {
    return { status: 'MATCH_LEVEL_UNAVAILABLE', difference: null };
  }
  return { status: matchLevelCount === aggregateCount ? 'MATCH' : 'MISMATCH', difference: matchLevelCount - aggregateCount };
}

/** Production bucket semantics: bucket b covers [b·BUCKET_SEC, (b+1)·BUCKET_SEC). */
export const assignBucket = (timestampSec, bucketSec = BUCKET_SEC) =>
  (Number.isFinite(timestampSec) ? Math.floor(timestampSec / bucketSec) : null);

export const bucketWindow = (bucket, bucketSec = BUCKET_SEC) => ({
  bucket,
  startSecInclusive: bucket * bucketSec,
  endSecExclusive: (bucket + 1) * bucketSec,
  startUtc: new Date(bucket * bucketSec * 1000).toISOString(),
  endUtcExclusive: new Date((bucket + 1) * bucketSec * 1000).toISOString(),
});

export function checkBucketAssignment({ startDateTime, reportedBucket = null }, expectedBucket) {
  const computed = assignBucket(startDateTime);
  if (computed === null) return { status: 'TIMESTAMP_MISSING', computedBucket: null };
  return {
    status: computed !== expectedBucket ? 'OUTSIDE_EXPECTED_BUCKET'
      : reportedBucket !== null && reportedBucket !== computed ? 'REPORTED_BUCKET_DIFFERS' : 'CONSISTENT',
    computedBucket: computed,
    reportedBucket,
  };
}

/** Determine both heroes' sides and the winner of one match record. */
export function matchOrientation(match, heroAId, heroBId, participantsField = 'players') {
  const players = match?.[participantsField];
  if (!Array.isArray(players)) return { status: 'PARTICIPANTS_MISSING' };
  const a = players.filter((player) => player.heroId === heroAId);
  const b = players.filter((player) => player.heroId === heroBId);
  if (a.length !== 1 || b.length !== 1) {
    return { status: a.length > 1 || b.length > 1 ? 'DUPLICATE_HERO' : 'HERO_MISSING' };
  }
  if (typeof a[0].isRadiant !== 'boolean' || typeof b[0].isRadiant !== 'boolean') return { status: 'SIDE_MISSING' };
  if (a[0].isRadiant === b[0].isRadiant) return { status: 'SAME_TEAM' };
  if (typeof match.didRadiantWin !== 'boolean') return { status: 'WINNER_MISSING' };
  const heroAWon = a[0].isRadiant === match.didRadiantWin;
  const victoryFlags = [a[0].isVictory, b[0].isVictory];
  const flagsConsistent = victoryFlags.every((flag) => typeof flag !== 'boolean')
    || (victoryFlags[0] === heroAWon && victoryFlags[1] === !heroAWon);
  return {
    status: flagsConsistent ? 'OPPOSING_TEAMS' : 'WINNER_FLAGS_INCONSISTENT',
    heroAIsRadiant: a[0].isRadiant,
    heroAWon,
  };
}

export function reconcileWinCount(orientations, reportedWinCount) {
  const valid = orientations.filter((item) => item.status === 'OPPOSING_TEAMS');
  if (valid.length !== orientations.length || !Number.isInteger(reportedWinCount)) {
    return { status: 'UNVERIFIED', validMatches: valid.length, totalMatches: orientations.length };
  }
  const heroAWins = valid.filter((item) => item.heroAWon).length;
  return {
    status: heroAWins === reportedWinCount ? 'WINCOUNT_EQUALS_HERO1_WINS'
      : valid.length - heroAWins === reportedWinCount ? 'WINCOUNT_EQUALS_HERO2_WINS' : 'WINCOUNT_UNEXPLAINED',
    heroAWins,
    heroBWins: valid.length - heroAWins,
    reportedWinCount,
  };
}

// ---------------------------------------------------------------------------
// §7 Aggregate cross-check across FIX9–FIX13 archives (offline)
// ---------------------------------------------------------------------------

/** Collect every `{query?, response}` that holds a heroStats payload. */
export function collectHeroStatsResponses(node, trail = '$', out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.response?.data?.heroStats) {
    out.push({ trail, query: typeof node.query === 'string' ? node.query : null, response: node.response });
    return out;
  }
  if (node.data?.heroStats && trail !== '$') {
    out.push({ trail, query: null, response: node });
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === 'object') collectHeroStatsResponses(value, `${trail}.${key}`, out);
  }
  return out;
}

/** True when every matchUp node in the query uses exactly the production brackets and the aliased week. */
export function queryUsesProductionFilter(query, bucket) {
  if (query === null) return null;
  const node = new RegExp(`w${bucket}:\\s*matchUp\\(([^)]*)\\)`).exec(query);
  if (!node) return false;
  return node[1].includes(`week: ${bucket * BUCKET_SEC}`)
    && node[1].includes(`bracketBasicIds: [${BRACKETS.join(', ')}]`);
}

export function directedCounts(responses, heroId1, heroId2, bucket) {
  const values = [];
  let rejectedNonProduction = 0;
  for (const { query, response } of responses) {
    const dryads = response?.data?.heroStats?.[`w${bucket}`];
    if (!Array.isArray(dryads)) continue;
    const rows = dryads.filter((dryad) => dryad.heroId === heroId1)
      .flatMap((dryad) => dryad.vs ?? [])
      .filter((row) => row.heroId1 === heroId1 && row.heroId2 === heroId2);
    if (!rows.length) continue;
    if (queryUsesProductionFilter(query, bucket) === false) {
      rejectedNonProduction += rows.length;
      continue;
    }
    for (const row of rows) values.push(`${row.matchCount}/${row.winCount}`);
  }
  const distinct = [...new Set(values)].sort();
  return { observations: values.length, distinct, rejectedNonProduction };
}

export function aggregateCrossCheck(sources, pairs, buckets, fix13Rows) {
  const rows = [];
  for (const pair of pairs) {
    for (const bucket of buckets) {
      const fix13 = fix13Rows.find((row) => row.canonicalPairId === pair.canonicalPairId && row.bucket === bucket);
      const entry = {
        canonicalPairId: pair.canonicalPairId,
        bucket,
        fix13Production: fix13 ? {
          AtoB: `${fix13.production.gamesAtoB}/${fix13.production.winsAtoB}`,
          BtoA: `${fix13.production.gamesBtoA}/${fix13.production.winsBtoA}`,
        } : null,
        sources: {},
      };
      for (const [name, responses] of Object.entries(sources)) {
        entry.sources[name] = {
          AtoB: directedCounts(responses, pair.heroAId, pair.heroBId, bucket),
          BtoA: directedCounts(responses, pair.heroBId, pair.heroAId, bucket),
        };
      }
      const observed = Object.values(entry.sources).flatMap((item) => [item.AtoB, item.BtoA]);
      const consistent = (direction) => {
        const all = new Set(Object.values(entry.sources).flatMap((item) => item[direction].distinct));
        if (entry.fix13Production) all.add(entry.fix13Production[direction]);
        return all.size;
      };
      entry.distinctAtoBValues = consistent('AtoB');
      entry.distinctBtoAValues = consistent('BtoA');
      entry.status = observed.every((item) => item.observations === 0) ? 'NO_ARCHIVED_OBSERVATION'
        : entry.distinctAtoBValues === 1 && entry.distinctBtoAValues === 1 ? 'AGGREGATE_STABLE_ACROSS_FIXES'
          : 'AGGREGATE_VALUES_DIFFER';
      entry.matchLevel = {
        AtoB: reconcileCount(null, fix13?.production.gamesAtoB, false),
        BtoA: reconcileCount(null, fix13?.production.gamesBtoA, false),
      };
      rows.push(entry);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Evidence assembly
// ---------------------------------------------------------------------------

const HYPOTHESES = Object.freeze([
  'MATCH_SET_DIFFERENCE_CONFIRMED',
  'MATCH_LEVEL_COUNT_RECONCILIATION',
  'RANK_FILTER_MATCH_SET_DIFFERENCE',
  'BUCKET_ASSIGNMENT_DIFFERENCE',
  'DUPLICATE_OR_MISSING_MATCH_RECORDS',
  'WINNER_ORIENTATION_SEMANTICS',
]);

export function buildMatchLevelEvidence({
  sourceHashesBefore,
  sourceHashesAfter,
  introspection,
  capabilities,
  fix13,
  aggregateRows,
}) {
  const unavailable = capabilities.status === 'MATCH_LEVEL_EVIDENCE_UNAVAILABLE';
  const pairs = fix13.pairs;
  const buckets = fix13.buckets;
  const stable = aggregateRows.filter((row) => row.status === 'AGGREGATE_STABLE_ACROSS_FIXES').length;
  const evidence = {
    schemaVersion: 1,
    diagnostic: 'TZ #76-FIX14 STRATZ match-level reverse-pair reconciliation',
    createdAt: introspection.record.finishedAt,
    productionParameters: {
      brackets: [...BRACKETS],
      bucketSeconds: BUCKET_SEC,
      buckets,
      bracketSource: 'scripts/update-data-stratz.mjs:BRACKETS',
    },
    sourceHashes: {
      before: sourceHashesBefore,
      after: sourceHashesAfter,
      unchanged: JSON.stringify(sourceHashesBefore) === JSON.stringify(sourceHashesAfter),
    },
    upstreamEvidence: {
      fix13EvidenceSha256: fix13.evidenceSha256,
      fix13PartitionStatus: fix13.partitionVerification.status,
      fix13RootCauseStatus: fix13.rootCause.status,
    },
    schemaIntrospection: {
      status: introspection.record.status,
      queryHash: introspection.record.requestHash,
      responseHash: introspection.record.responseHash,
      typeCount: capabilities.typeCount,
      rawArtifact: path.relative(ROOT, MATCH_LEVEL_RAW_PATH),
    },
    discoveredCapabilities: capabilities,
    queries: {
      networkRequests: 1,
      requests: [{
        requestId: introspection.record.requestId,
        kind: 'SCHEMA_INTROSPECTION',
        status: introspection.record.status,
        queryHash: introspection.record.requestHash,
        responseHash: introspection.record.responseHash,
        transportCreated: introspection.record.transportCreated,
        transportClosed: introspection.record.transportClosed,
      }],
      matchLevelRequests: 0,
      matchLevelRequestsNote: unavailable
        ? 'Not issued: the schema exposes no endpoint that can enumerate the matches behind matchUp. Entity-scoped or subset endpoints (player/team/league matches, guides, rampages, live, search) were not used as substitutes.'
        : 'A candidate endpoint was found; collection requires review before any query is issued.',
      preliminaryIntrospection: 'One identical staging introspection was issued during development (not archived) to design this parser; the archived request is the authoritative one.',
    },
    pairs: pairs.map((pair) => ({
      canonicalPairId: pair.canonicalPairId,
      heroAId: pair.heroAId,
      heroBId: pair.heroBId,
      heroA: pair.heroA,
      heroB: pair.heroB,
    })),
    matchSets: {
      status: unavailable ? 'NOT_COLLECTED_MATCH_LEVEL_EVIDENCE_UNAVAILABLE' : 'NOT_COLLECTED_PENDING_REVIEW',
      pairWeeks: pairs.flatMap((pair) => buckets.map((bucket) => ({
        canonicalPairId: pair.canonicalPairId,
        bucket,
        AtoB: null,
        BtoA: null,
        comparison: compareMatchSets({ ids: [], complete: false }, { ids: [], complete: false }),
      }))),
      note: 'Null match sets mean "not obtainable", never "zero matches".',
    },
    bucketReconciliation: {
      status: 'UNVERIFIED',
      reason: 'No per-match timestamps for the matchUp population are available.',
      productionBucketSemantics: 'bucket b covers [b·BUCKET_SEC, (b+1)·BUCKET_SEC); matchUp week argument = b·BUCKET_SEC',
      windows: buckets.map((bucket) => bucketWindow(bucket)),
      perDirectionTimestampFilteringPossible: 'UNVERIFIED — both directions are requested with the same week argument; whether STRATZ assigns a match to a week identically for both heroes cannot be observed without match records.',
    },
    countReconciliation: {
      status: 'MATCH_LEVEL_UNAVAILABLE',
      aggregateSourcesCompared: ['fix9Batch', 'fix9SingleHero', 'fix10Repeatability', 'fix11QueryComposition', 'fix12ProductionFilter', 'fix13Partition'],
      aggregateStablePairWeeks: stable,
      aggregatePairWeeks: aggregateRows.length,
      rows: aggregateRows,
    },
    winnerOrientation: {
      status: 'UNVERIFIED',
      reason: 'Winner/side data exists on individual match records, but the matches that make up matchUp cannot be enumerated, so winCount cannot be reconciled against match outcomes.',
      matchTypeSupportsOrientation: Boolean(capabilities.matchType?.participantFields?.find((field) => field.name === 'isRadiant')?.found
        && capabilities.matchType?.fields?.find((field) => field.name === 'didRadiantWin')?.found),
    },
    rootCauseHypotheses: [
      ...HYPOTHESES.map((category) => ({
        category,
        status: unavailable ? 'NOT_TESTABLE' : 'PENDING_REVIEW',
        reason: unavailable ? 'Requires match identities for the matchUp population, which the API does not expose.' : null,
      })),
      {
        category: 'MATCH_LEVEL_EVIDENCE_UNAVAILABLE',
        status: unavailable ? 'CONFIRMED_BY_SCHEMA' : 'NOT_APPLICABLE',
        evidence: {
          aggregateEndpoint: capabilities.aggregateEndpoint?.path ?? null,
          aggregateExposesMatchIdentities: capabilities.aggregateEndpoint?.exposesMatchIdentities ?? null,
          populationCandidates: capabilities.populationCandidates,
          matchListEndpointsInspected: capabilities.matchListEndpoints?.length ?? 0,
        },
      },
    ],
    finalStatus: unavailable ? 'MATCH_LEVEL_EVIDENCE_UNAVAILABLE' : 'UNRESOLVED',
    rootCause: {
      status: 'UNRESOLVED',
      category: unavailable ? 'MATCH_LEVEL_EVIDENCE_UNAVAILABLE' : 'UNRESOLVED',
      productionPublishAllowed: false,
      explanation: unavailable
        ? 'The STRATZ schema provides only aggregate matchUp counts; no unscoped endpoint returns the match IDs behind them. A→B/B→A match sets, bucket assignment and winner orientation therefore cannot be checked, and the cause of reverse-direction count differences remains unknown.'
        : 'Match-level collection was not performed.',
    },
    evidenceSha256: '',
  };
  evidence.evidenceSha256 = canonicalJsonSha256(evidence, 'evidenceSha256');
  return evidence;
}

function loadAggregateSources(read, root) {
  const load = (relative) => JSON.parse(read(path.join(root, relative), 'utf8'));
  const fix9 = load(SOURCE_PATHS.fix9Input);
  const fix10 = load(SOURCE_PATHS.fix10Repeatability);
  const fix11Raw = load(SOURCE_PATHS.fix11Raw);
  const fix12Raw = load(SOURCE_PATHS.fix12Raw);
  const fix12Production = Object.fromEntries(Object.entries(fix12Raw.queryResponses)
    .filter(([requestId]) => requestId.endsWith('-filter-production')));
  return {
    fix9Batch: collectHeroStatsResponses(fix9.batchResults),
    fix9SingleHero: collectHeroStatsResponses(fix9.singleHeroResults),
    fix10Repeatability: collectHeroStatsResponses(fix10.passes),
    fix11QueryComposition: collectHeroStatsResponses({ q: fix11Raw.queryResponses, c: fix11Raw.matchedBatchControl }),
    fix12ProductionFilter: collectHeroStatsResponses(fix12Production),
  };
}

export async function runFix14(deps = {}) {
  const read = deps.readFileSync ?? readFileSync;
  const root = deps.root ?? ROOT;
  const before = captureSourceHashes(read, root);
  verifySourceHashes(before);
  const fix13 = JSON.parse(read(path.join(root, SOURCE_PATHS.fix13Evidence), 'utf8'));
  if (fix13.evidenceSha256 !== canonicalJsonSha256(fix13, 'evidenceSha256')
    || fix13.rootCause?.productionPublishAllowed !== false) {
    throw new Error('FIX13 evidence is not the protected unresolved record');
  }
  const query = makeFullIntrospectionQuery();
  const introspection = await executeDiagnosticQuery({
    requestId: 'fix14-full-schema-introspection',
    query,
    Transport: deps.StratzTransport ?? StratzTransport,
    token: (deps.loadToken ?? loadToken)(),
    now: deps.now ?? (() => new Date()),
    validate: (response) => {
      if (!response?.data?.__schema?.types?.length) throw new Error('Introspection returned no types');
      return {};
    },
  });
  if (!introspection.response) {
    throw new Error(`Schema introspection failed: ${introspection.record.error}`);
  }
  const capabilities = discoverMatchLevelCapabilities(introspection.response.data);
  if (capabilities.status === 'MATCH_LEVEL_ENDPOINT_CANDIDATE_FOUND') {
    // Do not invent queries for an endpoint this script was not designed against.
    throw new Error(`Population endpoint candidate(s) found (${capabilities.populationCandidates.join(', ')}); review required before match collection`);
  }
  const aggregateRows = aggregateCrossCheck(
    loadAggregateSources(read, root),
    fix13.pairs,
    fix13.buckets,
    fix13.rankAsymmetryContribution.pairWeekRows,
  );
  const after = captureSourceHashes(read, root);
  verifySourceHashes(after);
  const evidence = buildMatchLevelEvidence({
    sourceHashesBefore: before,
    sourceHashesAfter: after,
    introspection,
    capabilities,
    fix13,
    aggregateRows,
  });
  const raw = {
    schemaVersion: 1,
    source: 'STRATZ production GraphQL via production StratzTransport',
    tokenPersisted: false,
    createdAt: introspection.record.finishedAt,
    schemaIntrospection: {
      requestId: introspection.record.requestId,
      query,
      queryHash: introspection.record.requestHash,
      responseHash: introspection.record.responseHash,
      response: introspection.response,
    },
    matchLevelResponses: {},
  };
  return { evidence, raw };
}

async function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  if (command === 'run') {
    if (existsSync(MATCH_LEVEL_EVIDENCE_PATH) || existsSync(MATCH_LEVEL_RAW_PATH)) {
      throw new Error('FIX14 output already exists; refusing to overwrite saved evidence');
    }
    const token = loadToken();
    const { evidence, raw } = await runFix14();
    const text = JSON.stringify([evidence, raw]);
    if (text.includes(token) || /Bearer\s+[A-Za-z0-9._-]{8,}/.test(text)) {
      throw new Error('FIX14 artifact unexpectedly contains credentials');
    }
    writeFileSync(MATCH_LEVEL_RAW_PATH, `${JSON.stringify(raw, null, 2)}\n`, { flag: 'wx' });
    writeFileSync(MATCH_LEVEL_EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({
      finalStatus: evidence.finalStatus,
      capabilities: evidence.discoveredCapabilities.status,
      populationCandidates: evidence.discoveredCapabilities.populationCandidates,
      evidenceSha256: evidence.evidenceSha256,
    }, null, 2));
    return;
  }
  if (command === 'check') {
    verifySourceHashes(captureSourceHashes());
    const evidence = JSON.parse(readFileSync(MATCH_LEVEL_EVIDENCE_PATH, 'utf8'));
    const raw = JSON.parse(readFileSync(MATCH_LEVEL_RAW_PATH, 'utf8'));
    if (evidence.evidenceSha256 !== canonicalJsonSha256(evidence, 'evidenceSha256')) {
      throw new Error('FIX14 evidence canonical hash mismatch');
    }
    if (sha256(raw.schemaIntrospection.query) !== evidence.schemaIntrospection.queryHash) {
      throw new Error('FIX14 introspection query hash mismatch');
    }
    const rediscovered = discoverMatchLevelCapabilities(raw.schemaIntrospection.response.data);
    if (JSON.stringify(rediscovered) !== JSON.stringify(evidence.discoveredCapabilities)) {
      throw new Error('FIX14 capability discovery does not reproduce from the raw introspection');
    }
    console.log(JSON.stringify({
      status: 'PASS',
      finalStatus: evidence.finalStatus,
      rootCause: evidence.rootCause.status,
      productionPublishAllowed: evidence.rootCause.productionPublishAllowed,
      evidenceSha256: evidence.evidenceSha256,
    }, null, 2));
    return;
  }
  throw new Error('Usage: node scripts/stratz-match-level-reconciliation.mjs <run|check>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[STRATZ FIX14] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
