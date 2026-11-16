#!/usr/bin/env node
// TZ #76-FIX15: STRATZ matchup semantics escalation & independent data-source validation.
//
//   collect — network, external sources only (OpenDota, Steam Web API probes).
//             Never contacts STRATZ. Writes the raw archive once (no overwrite).
//   build   — offline and deterministic. Produces the support escalation (md+json),
//             the external-source feasibility report and the external match-level
//             evidence from the raw archive plus protected FIX9–FIX14 evidence.
//   check   — verifies the frozen FIX15 artifacts by SHA-256 (FIX16: after the
//             median/allowlist corrections the generator no longer reproduces
//             them byte-for-byte; corrected successors are produced by
//             stratz-opendota-coverage-validation.mjs).
//
// Research only: nothing here is wired into production update-data-stratz.mjs.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRACKETS, BUCKET_SEC, buildChunkQuery } from './update-data-stratz.mjs';
import { canonicalJsonSha256 } from './stratz-matchup-root-cause-research.mjs';
import { assignBucket, bucketWindow } from './stratz-match-level-reconciliation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DQ = 'research/data-quality';

export const OUTPUT_PATHS = Object.freeze({
  escalationMd: `${DQ}/stratz-support-escalation.md`,
  escalationJson: `${DQ}/stratz-support-escalation.json`,
  feasibility: `${DQ}/stratz-external-source-feasibility.json`,
  externalEvidence: `${DQ}/stratz-external-match-level-evidence.json`,
  externalRaw: `${DQ}/stratz-external-match-level-raw-responses.json`,
});

const SOURCE_PATHS = Object.freeze({
  fix9Input: 'scripts/stratz-diagnostic-input.json',
  fix10Repeatability: `${DQ}/stratz-reverse-pair-repeatability-evidence.json`,
  fix10Report: `${DQ}/stratz-reverse-pair-asymmetry-report.json`,
  fix11Evidence: `${DQ}/stratz-reverse-pair-root-cause-evidence.json`,
  fix11Raw: `${DQ}/stratz-reverse-pair-root-cause-raw-responses.json`,
  fix12Evidence: `${DQ}/stratz-reverse-pair-bracket-semantics-evidence.json`,
  fix12Raw: `${DQ}/stratz-reverse-pair-bracket-raw-responses.json`,
  fix13Evidence: `${DQ}/stratz-reverse-pair-partition-semantics-evidence.json`,
  fix14Evidence: `${DQ}/stratz-reverse-pair-match-level-evidence.json`,
  fix14Raw: `${DQ}/stratz-reverse-pair-match-level-raw-responses.json`,
  productionHeroes: 'public/data/heroes.json',
  productionMatchups: 'public/data/matchups.json',
  productionMeta: 'public/data/meta.json',
  // FIX16: the whole production module is protected, which pins BRACKETS,
  // BUCKET_SEC and buildChunkQuery (and the aggregator) by content hash.
  productionModule: 'scripts/update-data-stratz.mjs',
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
  fix14Evidence: '91143b20f42f4227081d69bcbbae937ce1da8da4b480065047ae0a4d0a6ce862',
  fix14Raw: '69f4b06b1e05a7703b6a6e403b007c978fc3214f1ea2f90cac0027b35c297ba5',
  productionHeroes: '59ecc2bc9b55a62232bf7d40b85c1d4c306602e89addda6d3faa9ed38a2c061d',
  productionMatchups: '0a9e54aaa925494f7ad876c992e782cfd45d297b3952c8afefb8decc3ad02e8b',
  productionMeta: '9db099dedf5c5f0d052590d98d194807e2580a16694fc562ae9ffbf1d144857e',
  // Re-pinned by ТЗ №77, which removed the item pipeline from the generator
  // (FIX15/FIX16-era value: b142bf249e4510bce4f12ef004fbea96cd7b0c9f33a563a30d6ccc3c3ea65431).
  // The matchup query surface is unchanged: FIX17 content validation re-derives
  // buildChunkQuery and compares it with the recorded FIX12 raw query.
  productionModule: '7a0d5c3e595b38709292ebb94606768f03cc4f31b5e35ef7ff1acaf33a9e8aaf',
});

/**
 * FIX15 artifacts as published on 2026-11-13. They are historical and frozen:
 * after the FIX16 corrections (median, protected module hash, wording) the
 * generator no longer reproduces them, so `check` verifies them by hash and
 * `build` refuses to overwrite them. FIX16 publishes corrected successors.
 */
export const FIX15_FROZEN_ARTIFACT_SHA256 = Object.freeze({
  [OUTPUT_PATHS.escalationMd]: '02f0a98c1c616845c6a528322fdaa6203454ee00cb2d9eb60d1305740d640d58',
  [OUTPUT_PATHS.escalationJson]: 'cbe70befeaece68dfd7aa00ca8a2a7de4a51ec2b901d3c8a2d2f6332fb216ca3',
  [OUTPUT_PATHS.feasibility]: 'ebcb245cb9154aa4ccb7853aac606009e764895fe7a121b4df33be5ed0e93587',
  [OUTPUT_PATHS.externalEvidence]: 'af54bca9575e839f60a2ca2a91ff89b9a369b301a65a4fc132749313abf16a4e',
  [OUTPUT_PATHS.externalRaw]: 'aae3c1b1f00d090f30c299b517a0f14fe56047296213945c365e8cdae5a71344',
});

/** Median; for an even count it is the mean of the two central values (FIX16 correction). */
export function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function captureSourceHashes(read = readFileSync, root = ROOT) {
  return Object.fromEntries(Object.entries(SOURCE_PATHS).map(([name, relative]) => [
    name, { path: relative, physicalSha256: sha256(read(path.join(root, relative))) },
  ]));
}

export function verifySourceHashes(hashes, expected = EXPECTED_PHYSICAL_SHA256) {
  const bad = Object.entries(expected).filter(([name, value]) => hashes[name]?.physicalSha256 !== value)
    .map(([name]) => name);
  if (bad.length) throw new Error(`Protected source hash mismatch: ${bad.join(', ')}`);
  return true;
}

// ---------------------------------------------------------------------------
// Direction A — STRATZ support escalation
// ---------------------------------------------------------------------------

export const ESCALATION_STATUSES = Object.freeze(['DRAFTED', 'SENT', 'ACKNOWLEDGED', 'ANSWERED', 'CLOSED']);

/**
 * Advance the escalation status. Every transition beyond DRAFTED requires an
 * explicit, human-provided confirmation; nothing advances automatically.
 */
export function setEscalationStatus(record, status, confirmation) {
  if (!ESCALATION_STATUSES.includes(status)) throw new Error(`Unknown escalation status ${status}`);
  const from = ESCALATION_STATUSES.indexOf(record.status);
  const to = ESCALATION_STATUSES.indexOf(status);
  if (to <= from) throw new Error(`Escalation status cannot move from ${record.status} to ${status}`);
  if (!confirmation?.confirmedBy || !confirmation?.at || !confirmation?.reference) {
    throw new Error(`Status ${status} requires confirmation { confirmedBy, at, reference }`);
  }
  return {
    ...record,
    status,
    statusHistory: [...record.statusHistory, { status, ...confirmation }],
  };
}

const CREDENTIAL_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/-]{8,}/i,
  /authorization\s*:/i,
  /\bcookie\s*:/i,
  /set-cookie/i,
  /STRATZ_API_TOKEN\s*=/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /[?&]key=[A-Za-z0-9]{8,}/i, // Steam Web API key in a URL
];

/** Returns the list of credential findings in a text (empty = clean). */
export function scanForCredentials(text, knownSecrets = []) {
  const findings = CREDENTIAL_PATTERNS.filter((pattern) => pattern.test(text)).map(String);
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 8 && text.includes(secret)) findings.push('KNOWN_SECRET_VALUE');
  }
  return findings;
}

function pairWeekProduction(fix13, pairId) {
  return fix13.rankAsymmetryContribution.pairWeekRows
    .filter((row) => row.canonicalPairId === pairId)
    .sort((a, b) => a.bucket - b.bucket)
    .map((row) => ({
      bucket: row.bucket,
      gamesAtoB: row.production.gamesAtoB,
      gamesBtoA: row.production.gamesBtoA,
      winsAtoB: row.production.winsAtoB,
      winsBtoA: row.production.winsBtoA,
      signedDelta: row.production.signedDelta,
      groups: Object.fromEntries(row.groups.map((group) => [group.bracket, [group.gamesAtoB, group.gamesBtoA]])),
    }));
}

export function buildEscalation({ fix11, fix12, fix13, fix14, sourceHashes }) {
  const examplePairs = ['58:61', '61:79'];
  const pairs = examplePairs.map((pairId) => {
    const pair = fix13.pairs.find((item) => item.canonicalPairId === pairId);
    const weeks = pairWeekProduction(fix13, pairId);
    const fix12Aggregate = fix12.pairFilterComparisons
      .find((item) => item.canonicalPairId === pairId && item.filterId === 'production').result;
    const gamesAtoB = weeks.reduce((sum, week) => sum + week.gamesAtoB, 0);
    const gamesBtoA = weeks.reduce((sum, week) => sum + week.gamesBtoA, 0);
    if (gamesAtoB !== fix12Aggregate.AtoB || gamesBtoA !== fix12Aggregate.BtoA) {
      throw new Error(`FIX12/FIX13 aggregate disagreement for ${pairId}`);
    }
    const productionRequest = fix12.querySummary.requests
      .find((request) => request.canonicalPairId === pairId && request.filterId === 'production');
    return {
      canonicalPairId: pairId,
      heroA: { id: pair.heroAId, name: pair.heroA },
      heroB: { id: pair.heroBId, name: pair.heroB },
      aggregate: { gamesAtoB, gamesBtoA, delta: gamesAtoB - gamesBtoA },
      weeks,
      sanitizedQuery: buildChunkQuery([pair.heroAId, pair.heroBId], fix13.buckets),
      fix12RequestHash: productionRequest.requestHash,
      fix12ResponseHash: productionRequest.responseHash,
      fix12RequestedAt: productionRequest.startedAt,
    };
  });
  const orderComparisons = fix11.queryComposition.comparisons.orderComparisons;
  const crossCheck = fix14.countReconciliation;
  const findings = [
    {
      id: 'batch-vs-single-hero',
      statement: 'Batched (32 heroes per request), single-hero and pair-only requests return identical rows.',
      evidence: `FIX11 controls: pairOnlyVsSingleMismatches=${fix11.rootCause.evidence.find((item) => item.id === 'current-query-composition-controls')?.pairOnlyVsSingleMismatches}, singleHeroVsMatchedBatchMismatches=${fix11.rootCause.evidence.find((item) => item.id === 'current-query-composition-controls')?.singleHeroVsMatchedBatchMismatches}.`,
    },
    {
      id: 'repeatability',
      statement: 'Independent repeated requests return identical rows.',
      evidence: 'FIX10 repeatability: status PASS, 1512 matching rows, 0 mismatches.',
    },
    {
      id: 'hero-order',
      statement: 'Swapping the order of heroIds in the request does not change any row.',
      evidence: `FIX11: ${orderComparisons.filter((item) => item.comparison.status === 'PASS').length}/${orderComparisons.length} pairs PASS, 0 mismatching rows.`,
    },
    {
      id: 'bracket-partition',
      statement: 'Querying each production bracket separately and summing reproduces the multi-bracket totals exactly (matchCount and winCount, both directions).',
      evidence: `FIX13: ${fix13.partitionVerification.status}, ${fix13.partitionVerification.completePairBucketCount}/${fix13.partitionVerification.pairWeekObservations} pair-weeks.`,
    },
    {
      id: 'per-bucket',
      statement: 'Reverse-direction differences appear in individual weekly buckets, not only in the multi-week sum.',
      evidence: `FIX13: 0/${fix13.rankAsymmetryContribution.directionConsistencySummary.completePairWeekRows} pair-weeks have equal reverse counts.`,
    },
    {
      id: 'stable-across-retrievals',
      statement: 'For the studied pairs the values were identical across all archived retrievals on 2026-11-12.',
      evidence: `FIX14 cross-check: ${crossCheck.aggregateStablePairWeeks}/${crossCheck.aggregatePairWeeks} pair-weeks identical across 6 archives. Note: FIX11 also recorded ${fix11.queryComposition.summary.historicalFix9BatchMismatchCount} row differences for other heroes between a 07:52 UTC batch and 11:12 UTC re-queries, so values can change between retrievals.`,
    },
    {
      id: 'no-match-ids',
      statement: 'The public GraphQL schema exposes no way to list the match IDs behind a matchUp row.',
      evidence: `FIX14 schema introspection (${fix14.discoveredCapabilities.typeCount} types): status ${fix14.discoveredCapabilities.status}.`,
    },
  ];
  const questions = [
    'Is matchCount for heroId1=A/heroId2=B expected to equal matchCount for heroId1=B/heroId2=A (same week, same bracketBasicIds)? Is this part of the API contract?',
    'What exactly does the top-level `heroId` in heroStats.matchUp represent, and how are heroId1 and heroId2 assigned in the `vs` rows?',
    'What counts as one game in matchCount (lobby types, game modes, abandons, matches without full stats)?',
    'Can a single match be counted for A vs B but not for B vs A? If so, under which conditions?',
    'Is bracketBasicIds applied per player (to the hero\'s own player) or per match (e.g. average rank)? Is it applied identically to both heroes of the pair?',
    'Can different ranks of the two players in one match lead to different directional counts?',
    'Is `week` a fixed Unix bucket (week = floor(t / 604800) × 604800) or a calendar week, and which match timestamp (start or end) is used?',
    'How are matches with unknown or uncalibrated rank handled for bracketBasicIds filtering?',
    'Is there an official way to obtain the match IDs that make up a specific matchUp row?',
    'Are there known limitations, sampling, delays or reprocessing in the hero-stats aggregation pipeline (e.g. counts based on a subset of matches)?',
    'Could you share an official example query and the expected (symmetric or asymmetric) result for one of the pairs below?',
  ];
  const record = {
    schemaVersion: 1,
    kind: 'STRATZ_SUPPORT_ESCALATION',
    status: 'DRAFTED',
    statusHistory: [{ status: 'DRAFTED', confirmedBy: 'generator', at: fix14.createdAt, reference: 'generated from FIX9–FIX14 evidence; not sent' }],
    sendingPolicy: 'Not sent automatically. Moving to SENT/ACKNOWLEDGED/ANSWERED/CLOSED requires a human confirmation recorded via setEscalationStatus().',
    language: 'en',
    subject: 'heroStats.matchUp: matchCount differs between A→B and B→A for the same week and brackets',
    endpoint: 'https://api.stratz.com/graphql',
    productionParameters: {
      bracketBasicIds: [...BRACKETS],
      buckets: fix13.buckets,
      bucketSeconds: BUCKET_SEC,
      weekArgument: 'week = bucket × 604800 (Unix seconds)',
      take: 200,
      windows: fix13.buckets.map((bucket) => bucketWindow(bucket)),
    },
    examples: pairs,
    findings,
    questions,
    evidenceReferences: Object.fromEntries(Object.entries(sourceHashes)
      .filter(([name]) => name.startsWith('fix'))
      .map(([name, value]) => [name, value])),
    limitations: [
      'Counts were retrieved on 2026-11-12; STRATZ may have reprocessed data since.',
      'The examples cover 8 pairs × 4 weeks studied in FIX12–FIX14; other pairs are not characterised here.',
    ],
  };
  return record;
}

export function renderEscalationMarkdown(record) {
  const fmt = (value) => (value > 0 ? `+${value}` : `${value}`);
  const lines = [
    `# ${record.subject}`,
    '',
    `Status: **${record.status}** — draft for review, not sent.`,
    '',
    'Hello STRATZ team,',
    '',
    'We use the public GraphQL API (`heroStats.matchUp`) to build hero-vs-hero statistics. For the same week and the same `bracketBasicIds`, the `matchCount` returned for hero A against hero B differs from the `matchCount` returned for hero B against hero A. We would like to understand whether this is expected and how the aggregate is defined.',
    '',
    '## Observation',
    '',
    `Window: buckets ${record.productionParameters.buckets.join(', ')} (\`week = bucket × 604800\`, ${record.productionParameters.windows[0].startUtc} – ${record.productionParameters.windows.at(-1).endUtcExclusive}, end exclusive).`,
    '',
    `Brackets: ${record.productionParameters.bracketBasicIds.map((item) => `\`${item}\``).join(', ')}.`,
    '',
    '| Hero pair | A→B matchCount | B→A matchCount | Delta |',
    '|---|---:|---:|---:|',
    ...record.examples.map((pair) => `| ${pair.heroA.name} (${pair.heroA.id}) / ${pair.heroB.name} (${pair.heroB.id}) | ${pair.aggregate.gamesAtoB} | ${pair.aggregate.gamesBtoA} | ${fmt(pair.aggregate.delta)} |`),
    '',
    'Per week (A→B / B→A):',
    '',
    `| Hero pair | ${record.productionParameters.buckets.map((bucket) => `week ${bucket}`).join(' | ')} |`,
    `|---|${record.productionParameters.buckets.map(() => '---:').join('|')}|`,
    ...record.examples.map((pair) => `| ${pair.heroA.name} / ${pair.heroB.name} | ${pair.weeks.map((week) => `${week.gamesAtoB} / ${week.gamesBtoA}`).join(' | ')} |`),
    '',
    `Per bracket, week ${record.examples[0].weeks[0].bucket}, ${record.examples[0].heroA.name} / ${record.examples[0].heroB.name} (A→B / B→A):`,
    '',
    ...Object.entries(record.examples[0].weeks[0].groups).map(([bracket, [a, b]]) => `- \`${bracket}\`: ${a} / ${b}`),
    `- all four brackets: ${record.examples[0].weeks[0].gamesAtoB} / ${record.examples[0].weeks[0].gamesBtoA}`,
    '',
    'Here A→B is the `vs` row with `heroId1 = A, heroId2 = B` under the top-level `heroId = A`, and B→A is the row with `heroId1 = B, heroId2 = A` under `heroId = B`.',
    '',
    '## Query (sanitized)',
    '',
    '```graphql',
    record.examples[0].sanitizedQuery,
    '```',
    '',
    `Request SHA-256: \`${record.examples[0].fix12RequestHash}\`, normalized response SHA-256: \`${record.examples[0].fix12ResponseHash}\` (retrieved ${record.examples[0].fix12RequestedAt}).`,
    '',
    '## What we have already ruled out',
    '',
    ...record.findings.map((finding) => `- ${finding.statement} (${finding.evidence})`),
    '',
    '## Questions',
    '',
    ...record.questions.map((question, index) => `${index + 1}. ${question}`),
    '',
    'Example queries and the expected results for one of the pairs above would be very helpful.',
    '',
    'Thank you!',
    '',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Direction B — external source feasibility
// ---------------------------------------------------------------------------

/**
 * Decide whether a source can support strict pair reconciliation.
 * capabilities: { matchIds, timestamp, heroIdsBothTeams, playerSide, winner,
 *                 rank, pagination, historicalCoverage, accessible }
 */
export function assessSource(capabilities) {
  const reasons = [];
  if (capabilities.accessible === false) reasons.push('ACCESS_REQUIRES_CREDENTIALS_NOT_AVAILABLE');
  if (!capabilities.matchIds) return { verdict: 'NOT_SUPPORTED', reasons: ['NO_MATCH_IDS', ...reasons], bucketReconciliation: false, pairReconciliation: false };
  if (!capabilities.pagination || capabilities.pagination === 'IMPRACTICAL') reasons.push('NO_PRACTICAL_PAGINATION');
  if (!capabilities.historicalCoverage) reasons.push('NO_HISTORICAL_COVERAGE');
  const bucketReconciliation = Boolean(capabilities.timestamp);
  const pairReconciliation = Boolean(capabilities.heroIdsBothTeams && capabilities.playerSide);
  if (!bucketReconciliation) reasons.push('NO_TIMESTAMP');
  if (!pairReconciliation) reasons.push('NO_TWO_TEAM_HERO_IDS');
  const limitations = [];
  if (!capabilities.rank) limitations.push('NO_RANK_OR_BRACKET');
  else if (capabilities.rank === 'MATCH_AVERAGE') limitations.push('RANK_IS_MATCH_AVERAGE_NOT_PER_PLAYER');
  if (!capabilities.winner) limitations.push('NO_WINNER');
  const verdict = reasons.length ? 'INSUFFICIENT'
    : limitations.length ? 'SUITABLE_WITH_LIMITATIONS' : 'SUITABLE';
  return { verdict, reasons, limitations, bucketReconciliation, pairReconciliation };
}

export function buildFeasibility(raw) {
  const spec = raw.opendota.openapi.extracted;
  const steamStatus = (name) => raw.steam.probes.find((probe) => probe.name === name)?.httpStatus;
  const page = raw.opendota.publicMatchesPage;
  const providers = [
    {
      id: 'opendota-publicMatches',
      endpoint: 'GET https://api.opendota.com/api/publicMatches',
      documentation: spec.publicMatches.summary,
      observed: {
        httpStatus: page.httpStatus,
        rowsPerPage: page.body.length,
        rowsWithZeroedHeroIds: page.body.filter((row) => (row.radiant_team ?? []).some((hero) => hero === 0)).length,
        rateLimitHeaders: page.rateLimit,
      },
      capabilities: {
        matchIds: true, timestamp: true, heroIdsBothTeams: true, playerSide: true, winner: true,
        rank: 'MATCH_AVERAGE', historicalCoverage: true, accessible: true,
        pagination: 'IMPRACTICAL',
      },
      notes: [
        'Documented as "randomly sampled public matches"; only less_than_match_id/min_rank/max_rank parameters, no hero or time filter.',
        `${page.body.length} rows per page against a free quota of ${page.rateLimit['x-rate-limit-remaining-day'] ?? 'unknown'} requests/day cannot page through ~6M matches/week.`,
      ],
    },
    {
      id: 'opendota-explorer-public_matches',
      endpoint: 'GET https://api.opendota.com/api/explorer?sql=… (table public_matches)',
      documentation: spec.explorer.summary,
      observed: {
        chunkRequests: raw.opendota.chunks.length,
        chunkIdSpan: raw.opendota.chunkSize,
        failedChunks: raw.opendota.chunks.filter((chunk) => chunk.status !== 'OK').length,
      },
      capabilities: {
        matchIds: true, timestamp: true, heroIdsBothTeams: true, playerSide: true, winner: true,
        rank: 'MATCH_AVERAGE', historicalCoverage: true, accessible: true, pagination: 'MATCH_ID_RANGE',
      },
      notes: [
        'SQL over the public_matches table; enumerated with contiguous match_id ranges (indexed). Full-window scans by start_time time out (~16 s limit).',
        'avg_rank_tier/num_rank_tier are per-match aggregates; per-player brackets are not available, so STRATZ bracketBasicIds filtering cannot be reproduced.',
        'Completeness of public_matches relative to all public matchmaking games is not documented; recent rows can have zeroed hero arrays.',
      ],
    },
    {
      id: 'opendota-findMatches',
      endpoint: 'GET https://api.opendota.com/api/findMatches',
      documentation: spec.findMatches.summary,
      capabilities: {
        matchIds: true, timestamp: true, heroIdsBothTeams: true, playerSide: true, winner: true,
        rank: false, historicalCoverage: false, accessible: true, pagination: false,
      },
      notes: ['Documented as "recent matches"; parameters only teamA/teamB; no time window or pagination.'],
    },
    {
      id: 'steam-GetMatchHistory',
      endpoint: 'GET https://api.steampowered.com/IDOTA2Match_570/GetMatchHistory/v1/',
      observed: { keylessHttpStatus: steamStatus('GetMatchHistory') },
      capabilities: {
        matchIds: true, timestamp: true, heroIdsBothTeams: true, playerSide: true, winner: false,
        rank: false, historicalCoverage: false, accessible: false, pagination: true,
      },
      notes: [
        'Requires a Steam Web API key (keyless request returned HTTP 403 "verify your key= parameter"); no key is configured for this project.',
        'Documented parameters include hero_id and skill as request filters but no date range; skill is not returned per match; radiant_win needs GetMatchDetails per match.',
      ],
    },
    {
      id: 'steam-GetMatchHistoryBySequenceNum',
      endpoint: 'GET https://api.steampowered.com/IDOTA2Match_570/GetMatchHistoryBySequenceNum/v1/',
      observed: { keylessHttpStatus: steamStatus('GetMatchHistoryBySequenceNum') },
      capabilities: {
        matchIds: true, timestamp: true, heroIdsBothTeams: true, playerSide: true, winner: true,
        rank: false, historicalCoverage: true, accessible: false, pagination: true,
      },
      notes: [
        'Requires a Steam Web API key (keyless request returned HTTP 403).',
        'Complete sequential stream without hero filters: a 4-week window means scanning tens of millions of matches; no rank information.',
      ],
    },
  ].map((provider) => ({ ...provider, assessment: assessSource(provider.capabilities) }));
  const selected = providers.find((provider) => provider.id === 'opendota-explorer-public_matches');
  return {
    schemaVersion: 1,
    kind: 'EXTERNAL_SOURCE_FEASIBILITY',
    retrievedAt: raw.retrievedAt,
    source: 'OpenDota OpenAPI spec + live probes; Steam Web API keyless probes',
    rawArtifact: OUTPUT_PATHS.externalRaw,
    requirements: {
      required: ['matchIds', 'timestamp', 'heroIdsBothTeams', 'playerSide', 'pagination', 'historicalCoverage'],
      desirable: ['winner', 'rank'],
    },
    providers,
    otherDatasets: 'No other public, currently-updated match-level dataset with an API was verified during this research; none is assumed.',
    selection: {
      providerId: selected.id,
      verdict: selected.assessment.verdict,
      rationale: 'Only source verified to expose match IDs, timestamps, both teams\' hero IDs, sides and winner for the full window through practical enumeration.',
      limitations: [
        ...selected.assessment.limitations,
        'COVERAGE_RELATIVE_TO_STRATZ_UNVERIFIED',
        'NOT_EQUIVALENT_TO_STRATZ_BRACKET_FILTER',
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// External match-level dataset & reconciliation
// ---------------------------------------------------------------------------

export const MATCH_FIELDS = Object.freeze([
  'match_id', 'start_time', 'radiant_win', 'lobby_type', 'game_mode',
  'avg_rank_tier', 'num_rank_tier', 'radiant_team', 'dire_team',
]);

const fromCompact = (row) => Object.fromEntries(MATCH_FIELDS.map((field, index) => [field, row[index]]));

/** Deduplicate by match_id; conflicting duplicates are reported, never merged. */
export function dedupeMatches(rows) {
  const byId = new Map();
  const duplicates = new Map();
  for (const row of rows) {
    const id = String(row.match_id);
    if (!byId.has(id)) {
      byId.set(id, row);
      continue;
    }
    const same = JSON.stringify(byId.get(id)) === JSON.stringify(row);
    const entry = duplicates.get(id) ?? { matchId: id, occurrences: 1, conflicting: false };
    entry.occurrences += 1;
    entry.conflicting ||= !same;
    duplicates.set(id, entry);
  }
  const sortById = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  return {
    matches: [...byId.values()].sort((a, b) => sortById(String(a.match_id), String(b.match_id))),
    duplicates: [...duplicates.values()].sort((a, b) => sortById(a.matchId, b.matchId)),
  };
}

/**
 * Orientation of one external match for the pair. The external source has no
 * notion of matchup direction; we only establish that A and B were on opposing
 * teams and (if radiant_win is known) whether A's team won.
 */
export function externalPairOrientation(match, heroAId, heroBId) {
  const radiant = Array.isArray(match.radiant_team) ? match.radiant_team : null;
  const dire = Array.isArray(match.dire_team) ? match.dire_team : null;
  if (!radiant || !dire) return { status: 'TEAMS_MISSING' };
  const aR = radiant.includes(heroAId);
  const aD = dire.includes(heroAId);
  const bR = radiant.includes(heroBId);
  const bD = dire.includes(heroBId);
  if (!(aR || aD) || !(bR || bD)) return { status: 'PAIR_NOT_PRESENT' };
  if ((aR && aD) || (bR && bD)) return { status: 'HERO_ON_BOTH_TEAMS' };
  if (aR === bR) return { status: 'SAME_TEAM' };
  if (typeof match.radiant_win !== 'boolean') return { status: 'OPPOSING', heroAWon: null };
  return { status: 'OPPOSING', heroAWon: aR === match.radiant_win };
}

const PRODUCTION_RANK_GROUPS = Object.freeze({
  // OpenDota rank_tier tens digit: 1 Herald, 2 Guardian, … 8 Immortal.
  HERALD_GUARDIAN: [1, 2],
  CRUSADER_ARCHON: [3, 4],
  LEGEND_ANCIENT: [5, 6],
  DIVINE_IMMORTAL: [7, 8],
});

export function rankGroupOfAverage(avgRankTier) {
  if (!Number.isInteger(avgRankTier) || avgRankTier <= 0) return 'UNKNOWN';
  const tens = Math.floor(avgRankTier / 10);
  return Object.entries(PRODUCTION_RANK_GROUPS).find(([, values]) => values.includes(tens))?.[0] ?? 'OUT_OF_RANGE';
}

export const EXTERNAL_SUBSETS = Object.freeze({
  ALL_PUBLIC: () => true,
  RANKED_MATCHMAKING: (match) => match.lobby_type === 7,
  RANKED_AVG_RANK_IN_PRODUCTION_RANGE: (match) => match.lobby_type === 7
    && rankGroupOfAverage(match.avg_rank_tier) in PRODUCTION_RANK_GROUPS,
});

const relative = (a, b) => (b ? (a - b) / b : null);

export function reconcilePairWeek({ pair, bucket, matches, stratz, coverageStatus }) {
  const inBucket = matches.filter((match) => assignBucket(match.start_time) === bucket);
  const oriented = inBucket.map((match) => ({ match, orientation: externalPairOrientation(match, pair.heroAId, pair.heroBId) }))
    .filter((item) => item.orientation.status === 'OPPOSING');
  const subsets = Object.fromEntries(Object.entries(EXTERNAL_SUBSETS).map(([name, predicate]) => {
    const items = oriented.filter((item) => predicate(item.match));
    const withWinner = items.filter((item) => item.orientation.heroAWon !== null);
    return [name, {
      matches: items.length,
      heroAWins: withWinner.filter((item) => item.orientation.heroAWon).length,
      heroBWins: withWinner.filter((item) => !item.orientation.heroAWon).length,
      winnerUnknown: items.length - withWinner.length,
    }];
  }));
  const rankGroups = Object.fromEntries([...Object.keys(PRODUCTION_RANK_GROUPS), 'UNKNOWN', 'OUT_OF_RANGE'].map((group) => [
    group,
    oriented.filter((item) => item.match.lobby_type === 7 && rankGroupOfAverage(item.match.avg_rank_tier) === group).length,
  ]));
  const reference = subsets.RANKED_AVG_RANK_IN_PRODUCTION_RANGE.matches;
  const complete = coverageStatus === 'COMPLETE';
  return {
    canonicalPairId: pair.canonicalPairId,
    bucket,
    stratz: stratz ? { gamesAtoB: stratz.gamesAtoB, gamesBtoA: stratz.gamesBtoA, winsAtoB: stratz.winsAtoB, winsBtoA: stratz.winsBtoA } : null,
    external: {
      directional: false,
      note: 'One external match with A and B on opposing teams counts once for the pair; the source defines no A→B/B→A direction.',
      subsets,
      rankedByAverageRankGroup: rankGroups,
    },
    comparison: stratz ? {
      referenceSubset: 'RANKED_AVG_RANK_IN_PRODUCTION_RANGE',
      externalMatches: reference,
      absoluteDifferenceAtoB: stratz.gamesAtoB - reference,
      absoluteDifferenceBtoA: stratz.gamesBtoA - reference,
      relativeDifferenceAtoB: relative(stratz.gamesAtoB, reference),
      relativeDifferenceBtoA: relative(stratz.gamesBtoA, reference),
      stratzToExternalRatioAtoB: reference ? stratz.gamesAtoB / reference : null,
      stratzToExternalRatioBtoA: reference ? stratz.gamesBtoA / reference : null,
      externalWinsAvsStratzWinsAtoB: { external: subsets.RANKED_AVG_RANK_IN_PRODUCTION_RANGE.heroAWins, stratz: stratz.winsAtoB },
    } : null,
    coverage: coverageStatus,
    productionThresholdApplied: false,
    productionThresholdNote: complete ? null : 'External coverage is not complete; the production threshold is not used as an error criterion.',
  };
}

export function summarizeCoverage(raw, bucketTotals) {
  const failed = raw.opendota.chunks.filter((chunk) => chunk.status !== 'OK');
  const zeroHero = bucketTotals.reduce((sum, item) => sum + item.zeroHeroMatches, 0);
  const total = bucketTotals.reduce((sum, item) => sum + item.matches, 0);
  const limitations = [
    'public_matches completeness relative to all matchmaking games is not documented by OpenDota.',
    'Rank is a per-match average (avg_rank_tier over num_rank_tier players); STRATZ bracketBasicIds semantics (per player vs per match) are unknown, so filters are not equivalent.',
    'Lobby/game-mode scope of STRATZ matchCount is unknown; several external subsets are reported instead of one.',
    `${zeroHero} of ${total} in-window public_matches rows have zeroed hero arrays and cannot be attributed to any pair.`,
    `Window boundaries are reached through match_id ranges with a start_time margin of ${(raw.opendota.boundaryMarginSec.lower / 86400).toFixed(2)} days before and ${(raw.opendota.boundaryMarginSec.upper / 86400).toFixed(2)} days after the window; matches whose start_time is in the window but whose match_id lies outside these ranges are not observed.`,
  ];
  if (failed.length) limitations.push(`${failed.length} chunk request(s) failed; their match_id ranges are missing.`);
  return {
    status: 'PARTIAL',
    classification: 'PARTIAL_MATCH_COVERAGE',
    reasons: ['COVERAGE_RELATIVE_TO_STRATZ_UNVERIFIED', ...(zeroHero ? ['ZEROED_HERO_ROWS'] : []), ...(failed.length ? ['FAILED_CHUNKS'] : [])],
    limitations,
    failedChunkRanges: failed.map((chunk) => [chunk.fromId, chunk.toId]),
  };
}

export function buildExternalEvidence({ raw, rawSha256, fix13, sourceHashes }) {
  const rows = raw.opendota.chunks.filter((chunk) => chunk.status === 'OK').flatMap((chunk) => chunk.rows.map(fromCompact));
  const { matches, duplicates } = dedupeMatches(rows);
  const buckets = fix13.buckets;
  const windowStart = buckets[0] * BUCKET_SEC;
  const windowEnd = (buckets.at(-1) + 1) * BUCKET_SEC;
  const inWindow = matches.filter((match) => match.start_time >= windowStart && match.start_time < windowEnd);
  const bucketTotals = buckets.map((bucket) => {
    const totals = raw.opendota.chunks.filter((chunk) => chunk.status === 'OK').map((chunk) => chunk.totals?.[`b${bucket}`])
      .filter(Boolean);
    return {
      bucket,
      window: bucketWindow(bucket),
      matches: totals.reduce((sum, item) => sum + item.matches, 0),
      rankedMatches: totals.reduce((sum, item) => sum + item.ranked, 0),
      zeroHeroMatches: totals.reduce((sum, item) => sum + item.zeroHero, 0),
      pairCandidateMatches: inWindow.filter((match) => assignBucket(match.start_time) === bucket).length,
    };
  });
  const coverage = summarizeCoverage(raw, bucketTotals);
  const reconciliation = fix13.pairs.flatMap((pair) => buckets.map((bucket) => {
    const row = fix13.rankAsymmetryContribution.pairWeekRows
      .find((item) => item.canonicalPairId === pair.canonicalPairId && item.bucket === bucket);
    return reconcilePairWeek({ pair, bucket, matches: inWindow, stratz: row?.production ?? null, coverageStatus: coverage.status });
  }));
  const ratios = reconciliation.flatMap((row) => [row.comparison?.stratzToExternalRatioAtoB, row.comparison?.stratzToExternalRatioBtoA])
    .filter((value) => Number.isFinite(value));
  const evidence = {
    schemaVersion: 1,
    datasetSource: 'EXTERNAL_MATCH_SOURCE',
    provider: 'OpenDota explorer, table public_matches',
    retrievedAt: raw.retrievedAt,
    window: { buckets, startSecInclusive: windowStart, endSecExclusive: windowEnd, bucketSeconds: BUCKET_SEC },
    sourceCoverage: coverage,
    rawArtifact: { path: OUTPUT_PATHS.externalRaw, sha256: rawSha256 },
    matchesStorage: 'Match records (match_id, start_time, radiant_win, lobby_type, game_mode, avg_rank_tier, num_rank_tier, radiant_team, dire_team) are stored in the raw artifact; this summary keeps per-pair-week aggregates only.',
    dataset: {
      recordsReturned: rows.length,
      uniqueMatchIds: matches.length,
      duplicateMatchIds: duplicates,
      inWindowPairCandidateMatches: inWindow.length,
      outOfWindowRecords: matches.length - inWindow.length,
    },
    bucketTotals,
    reconciliation,
    reconciliationSummary: {
      pairWeeks: reconciliation.length,
      stratzReverseCountsEqual: reconciliation.filter((row) => row.stratz && row.stratz.gamesAtoB === row.stratz.gamesBtoA).length,
      externalCountIsSymmetricByConstruction: true,
      stratzToExternalRatio: ratios.length ? {
        min: Math.min(...ratios), max: Math.max(...ratios),
        median: median(ratios),
      } : null,
      stratzWithinExternalReference: reconciliation.filter((row) => row.comparison
        && row.stratz.gamesAtoB <= row.comparison.externalMatches && row.stratz.gamesBtoA <= row.comparison.externalMatches).length,
      interpretation: 'Descriptive only. External coverage is partial/unverified and its rank filter is not equivalent, so these numbers neither confirm nor refute a STRATZ defect.',
    },
    sourceHashes,
    limitations: coverage.limitations,
    evidenceSha256: '',
  };
  evidence.evidenceSha256 = canonicalJsonSha256(evidence, 'evidenceSha256');
  return evidence;
}

export function classifyRootCause({ escalation, externalEvidence }) {
  const vendorAnswered = escalation.status === 'ANSWERED' || escalation.status === 'CLOSED';
  const externalComplete = externalEvidence?.sourceCoverage?.status === 'COMPLETE';
  const categories = [
    { category: 'STRATZ_MATCHUP_DIRECTIONAL_SEMANTICS_CONFIRMED', applies: false, reason: vendorAnswered ? 'Answer must be reviewed manually.' : 'No official STRATZ answer.' },
    { category: 'STRATZ_VENDOR_CONFIRMED_ISSUE', applies: false, reason: 'No official STRATZ answer.' },
    { category: 'EXTERNAL_SOURCE_RECONCILIATION_CONFIRMED', applies: false, reason: externalComplete ? 'Requires review.' : 'External coverage is not complete and filters are not equivalent.' },
    { category: 'PUBLIC_SOURCE_COVERAGE_INSUFFICIENT', applies: Boolean(externalEvidence) && !externalComplete, reason: externalEvidence?.sourceCoverage?.reasons?.join(', ') ?? 'No external dataset.' },
    { category: 'MATCH_LEVEL_EVIDENCE_UNAVAILABLE', applies: true, reason: 'STRATZ exposes no match IDs for matchUp rows (FIX14); external match IDs cannot be mapped onto STRATZ directional rows.' },
    { category: 'UNRESOLVED', applies: true, reason: 'Neither an official answer nor a complete, equivalent independent reconciliation exists.' },
  ];
  return {
    status: 'UNRESOLVED',
    productionPublishAllowed: false,
    categories,
    note: 'Stable aggregate counts alone do not prove a STRATZ defect.',
  };
}

// ---------------------------------------------------------------------------
// Network collector (external sources only)
// ---------------------------------------------------------------------------

const OPENDOTA = 'https://api.opendota.com/api';
const USER_AGENT = 'research-client';
const RATE_HEADERS = ['x-rate-limit-remaining-minute', 'x-rate-limit-remaining-day'];

export function pairPredicateSql(pairs) {
  const heroes = [...new Set(pairs.flatMap((pair) => [pair.heroAId, pair.heroBId]))].sort((a, b) => a - b);
  const cond = pairs.map(({ heroAId: a, heroBId: b }) =>
    `(${a} = ANY(radiant_team) AND ${b} = ANY(dire_team)) OR (${b} = ANY(radiant_team) AND ${a} = ANY(dire_team))`).join(' OR ');
  return `radiant_team && ARRAY[${heroes.join(',')}] AND dire_team && ARRAY[${heroes.join(',')}] AND (${cond})`;
}

export function chunkSql(fromId, toId, pairs) {
  return `SELECT ${MATCH_FIELDS.join(', ')} FROM public_matches WHERE match_id >= ${fromId} AND match_id < ${toId} AND ${pairPredicateSql(pairs)} ORDER BY match_id`;
}

export function totalsSql(fromId, toId, buckets) {
  const parts = buckets.flatMap((bucket) => {
    const t = `start_time >= ${bucket * BUCKET_SEC} AND start_time < ${(bucket + 1) * BUCKET_SEC}`;
    return [
      `count(*) FILTER (WHERE ${t}) AS b${bucket}_matches`,
      `count(*) FILTER (WHERE ${t} AND lobby_type = 7) AS b${bucket}_ranked`,
      `count(*) FILTER (WHERE ${t} AND (0 = ANY(radiant_team) OR 0 = ANY(dire_team))) AS b${bucket}_zero_hero`,
    ];
  });
  return `SELECT count(*) AS rows, min(start_time) AS min_t, max(start_time) AS max_t, ${parts.join(', ')} FROM public_matches WHERE match_id >= ${fromId} AND match_id < ${toId}`;
}

async function collect({ fix13, fetchImpl = fetch, log = console.log, delayMs = 1100, chunkSize = 300000 }) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let requests = 0;
  const get = async (url, { json = true } = {}) => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      if (requests > 0) await sleep(delayMs);
      requests += 1;
      const response = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT } });
      const text = await response.text();
      const rateLimit = Object.fromEntries(RATE_HEADERS.map((name) => [name, response.headers.get(name)]));
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        await sleep(5000 * attempt);
        continue;
      }
      let body = text;
      if (json) {
        try { body = JSON.parse(text); } catch { body = { err: `non-JSON response (HTTP ${response.status})` }; }
      }
      return { httpStatus: response.status, body, rateLimit };
    }
    throw new Error('unreachable');
  };
  const explorer = async (sql) => {
    const result = await get(`${OPENDOTA}/explorer?sql=${encodeURIComponent(sql)}`);
    if (result.httpStatus !== 200 || result.body?.err) {
      return { ok: false, error: String(result.body?.err ?? `HTTP ${result.httpStatus}`), httpStatus: result.httpStatus };
    }
    return { ok: true, rows: result.body.rows, httpStatus: result.httpStatus };
  };

  const retrievedAt = new Date().toISOString();
  log('[FIX15] OpenDota OpenAPI spec');
  const specResponse = await get(OPENDOTA, { json: false });
  const spec = JSON.parse(specResponse.body);
  const pick = (p) => ({ summary: spec.paths[p]?.get?.summary ?? null, parameters: spec.paths[p]?.get?.parameters ?? [] });
  log('[FIX15] OpenDota publicMatches page');
  const page = await get(`${OPENDOTA}/publicMatches`);
  log('[FIX15] Steam keyless probes');
  const steamProbes = [];
  for (const [name, query] of [['GetMatchHistory', 'hero_id=58&matches_requested=1'], ['GetMatchHistoryBySequenceNum', 'matches_requested=1']]) {
    const url = `https://api.steampowered.com/IDOTA2Match_570/${name}/v1/?${query}`;
    const result = await get(url, { json: false });
    steamProbes.push({ name, url, httpStatus: result.httpStatus, body: String(result.body).slice(0, 500) });
  }

  // Locate match_id boundaries: first id whose start_time >= target.
  const marginSec = 2 * 86400;
  const firstIdAtOrAfter = async (target, lo, hi) => {
    const steps = [];
    const probe = async (id) => {
      const sql = `SELECT match_id, start_time FROM public_matches WHERE match_id >= ${id} ORDER BY match_id ASC LIMIT 1`;
      const result = await explorer(sql);
      if (!result.ok || !result.rows?.length) throw new Error(`Boundary probe failed at ${id}: ${result.error ?? 'no rows'}`);
      steps.push({ sql, sqlSha256: sha256(sql), row: result.rows[0] });
      return result.rows[0];
    };
    if ((await probe(lo)).start_time >= target) throw new Error('Boundary search lower bound is not below target');
    if ((await probe(hi)).start_time < target) throw new Error('Boundary search upper bound is not above target');
    while (hi - lo > 20000) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await probe(mid)).start_time >= target) hi = mid; else lo = mid;
    }
    return { matchId: hi, steps };
  };
  const buckets = fix13.buckets;
  const windowStart = buckets[0] * BUCKET_SEC;
  const windowEnd = (buckets.at(-1) + 1) * BUCKET_SEC;
  const newest = page.body.reduce((best, row) => (row.match_id > best.match_id ? row : best), page.body[0]);
  const searchHi = newest.match_id;
  // The upper margin cannot extend past the newest available match.
  const upperTarget = Math.min(windowEnd + marginSec, newest.start_time - 3600);
  if (upperTarget <= windowEnd) throw new Error('Not enough data after the window end for an upper margin');
  log('[FIX15] boundary search');
  const lower = await firstIdAtOrAfter(windowStart - marginSec, 8_900_000_000, searchHi);
  const upper = await firstIdAtOrAfter(upperTarget, lower.matchId, searchHi);

  const chunks = [];
  const queue = [];
  for (let from = lower.matchId; from < upper.matchId; from += chunkSize) {
    queue.push([from, Math.min(from + chunkSize, upper.matchId)]);
  }
  while (queue.length) {
    const [fromId, toId] = queue.shift();
    const sql = chunkSql(fromId, toId, fix13.pairs);
    const result = await explorer(sql);
    if (!result.ok && /timeout/i.test(result.error) && toId - fromId > 50000) {
      const mid = Math.floor((fromId + toId) / 2);
      queue.unshift([fromId, mid], [mid, toId]);
      continue;
    }
    const tSql = totalsSql(fromId, toId, buckets);
    const totals = result.ok ? await explorer(tSql) : null;
    const chunk = {
      fromId,
      toId,
      sql,
      sqlSha256: sha256(sql),
      totalsSql: tSql,
      totalsSqlSha256: sha256(tSql),
      status: result.ok && totals?.ok ? 'OK' : 'FAILED',
      error: result.ok ? (totals?.ok ? null : totals?.error ?? null) : result.error,
      rows: result.ok ? result.rows.map((row) => MATCH_FIELDS.map((field) => row[field] ?? null)) : [],
      totals: totals?.ok ? Object.fromEntries(buckets.map((bucket) => [`b${bucket}`, {
        matches: Number(totals.rows[0][`b${bucket}_matches`]),
        ranked: Number(totals.rows[0][`b${bucket}_ranked`]),
        zeroHero: Number(totals.rows[0][`b${bucket}_zero_hero`]),
      }])) : null,
      rangeRows: totals?.ok ? Number(totals.rows[0].rows) : null,
      rangeMinStart: totals?.ok ? totals.rows[0].min_t : null,
      rangeMaxStart: totals?.ok ? totals.rows[0].max_t : null,
    };
    chunk.rowsSha256 = sha256(JSON.stringify(chunk.rows));
    chunks.push(chunk);
    if (chunks.length % 10 === 0) log(`[FIX15] chunks ${chunks.length}, remaining ${queue.length}`);
  }
  chunks.sort((a, b) => a.fromId - b.fromId);
  return {
    schemaVersion: 1,
    kind: 'EXTERNAL_MATCH_LEVEL_RAW',
    retrievedAt,
    finishedAt: new Date().toISOString(),
    source: 'OpenDota public API (anonymous) and Steam Web API keyless probes; STRATZ not contacted',
    clientIdentification: `user-agent "${USER_AGENT}"; response headers other than rate-limit counters are not stored`,
    requestCount: requests,
    opendota: {
      openapi: {
        sha256: sha256(specResponse.body),
        version: spec.info?.version ?? null,
        extracted: {
          publicMatches: pick('/publicMatches'),
          explorer: pick('/explorer'),
          findMatches: pick('/findMatches'),
          parsedMatches: pick('/parsedMatches'),
          parameters: spec.components?.parameters ?? {},
          PublicMatchesResponse: spec.components?.schemas?.PublicMatchesResponse ?? null,
        },
      },
      publicMatchesPage: { httpStatus: page.httpStatus, rateLimit: page.rateLimit, body: page.body },
      boundaryMarginSec: { lower: marginSec, upper: upperTarget - windowEnd },
      boundaries: { lower, upper },
      chunkSize,
      matchFields: [...MATCH_FIELDS],
      chunks,
    },
    steam: { probes: steamProbes },
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const readJson = (relative, read = readFileSync) => JSON.parse(read(path.join(ROOT, relative), 'utf8'));

export function buildAll({ read = readFileSync } = {}) {
  const before = captureSourceHashes(read);
  verifySourceHashes(before);
  const fix11 = readJson(SOURCE_PATHS.fix11Evidence, read);
  const fix12 = readJson(SOURCE_PATHS.fix12Evidence, read);
  const fix13 = readJson(SOURCE_PATHS.fix13Evidence, read);
  const fix14 = readJson(SOURCE_PATHS.fix14Evidence, read);
  const rawBytes = read(path.join(ROOT, OUTPUT_PATHS.externalRaw));
  const raw = JSON.parse(rawBytes.toString('utf8'));
  const rawSha256 = sha256(rawBytes);

  const escalation = buildEscalation({ fix11, fix12, fix13, fix14, sourceHashes: before });
  const markdown = renderEscalationMarkdown(escalation);
  let token = null;
  try { token = process.env.STRATZ_API_TOKEN?.trim() || null; } catch { token = null; }
  const credentialFindings = scanForCredentials(`${markdown}\n${JSON.stringify(escalation)}`, [token]);
  if (credentialFindings.length) throw new Error(`Escalation contains credential-like content: ${credentialFindings.join(', ')}`);

  const feasibility = buildFeasibility(raw);
  feasibility.rawArtifactSha256 = rawSha256;
  feasibility.sourceHashes = before;
  feasibility.evidenceSha256 = canonicalJsonSha256(feasibility, 'evidenceSha256');

  const externalEvidence = buildExternalEvidence({ raw, rawSha256, fix13, sourceHashes: before });
  const rootCause = classifyRootCause({ escalation, externalEvidence });

  const escalationJson = {
    ...escalation,
    retrievalTimestamps: { stratzEvidence: fix12.createdAt, externalRaw: raw.retrievedAt },
    markdown: { path: OUTPUT_PATHS.escalationMd, sha256: sha256(markdown) },
    credentialScan: { status: 'CLEAN', patternsChecked: CREDENTIAL_PATTERNS.length },
    rootCause,
    evidenceSha256: '',
  };
  escalationJson.evidenceSha256 = canonicalJsonSha256(escalationJson, 'evidenceSha256');
  externalEvidence.rootCause = rootCause;
  externalEvidence.evidenceSha256 = canonicalJsonSha256(externalEvidence, 'evidenceSha256');

  const after = captureSourceHashes(read);
  verifySourceHashes(after);
  return {
    [OUTPUT_PATHS.escalationMd]: markdown,
    [OUTPUT_PATHS.escalationJson]: `${JSON.stringify(escalationJson, null, 2)}\n`,
    [OUTPUT_PATHS.feasibility]: `${JSON.stringify(feasibility, null, 2)}\n`,
    [OUTPUT_PATHS.externalEvidence]: `${JSON.stringify(externalEvidence, null, 2)}\n`,
  };
}

function writeOnce(relative, content) {
  const target = path.join(ROOT, relative);
  if (existsSync(target)) {
    if (readFileSync(target, 'utf8') === content) return 'UNCHANGED';
    throw new Error(`${relative} exists with different content; refusing to overwrite`);
  }
  writeFileSync(target, content, { flag: 'wx' });
  return 'WRITTEN';
}

async function main([command] = process.argv.slice(2)) {
  if (command === 'collect') {
    const target = path.join(ROOT, OUTPUT_PATHS.externalRaw);
    if (existsSync(target)) throw new Error('External raw archive already exists; refusing to overwrite');
    verifySourceHashes(captureSourceHashes());
    const raw = await collect({ fix13: readJson(SOURCE_PATHS.fix13Evidence) });
    const text = `${JSON.stringify(raw)}\n`;
    const findings = scanForCredentials(text, [process.env.STRATZ_API_TOKEN?.trim()]);
    if (findings.length) throw new Error(`Raw archive contains credential-like content: ${findings.join(', ')}`);
    writeFileSync(target, text, { flag: 'wx' });
    verifySourceHashes(captureSourceHashes());
    console.log(JSON.stringify({ requests: raw.requestCount, chunks: raw.opendota.chunks.length, failed: raw.opendota.chunks.filter((chunk) => chunk.status !== 'OK').length, sha256: sha256(text) }, null, 2));
    return;
  }
  if (command === 'check') {
    // FIX15 artifacts are frozen (see FIX15_FROZEN_ARTIFACT_SHA256).
    verifySourceHashes(captureSourceHashes());
    const result = {};
    for (const [relative, expected] of Object.entries(FIX15_FROZEN_ARTIFACT_SHA256)) {
      if (sha256(readFileSync(path.join(ROOT, relative))) !== expected) throw new Error(`${relative} changed`);
      result[relative] = 'FROZEN_HASH_OK';
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'build') {
    const outputs = buildAll();
    const result = {};
    for (const [relative, content] of Object.entries(outputs)) {
      result[relative] = writeOnce(relative, content);
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error('Usage: node scripts/stratz-external-source-research.mjs <collect|build|check>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[STRATZ FIX15] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
