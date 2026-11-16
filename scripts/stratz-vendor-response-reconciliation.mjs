#!/usr/bin/env node
// TZ #76-FIX17: STRATZ vendor escalation & official response reconciliation.
//
//   validate  — offline. Validates the escalation status file, the vendor response
//               input and the final escalation (content, hashes, security). No writes.
//   reconcile — offline. Writes the final escalation, the supporting-evidence
//               manifest and the escalation evidence report. Creates the vendor
//               response template and the status file only if they do not exist;
//               never fills in a response and never changes the status.
//   check     — offline. runCheck(): recomputes source hashes, numerical claims,
//               security scan, submission status, response hash, and verifies the
//               saved artifacts byte-for-byte (deterministic projection).
//   transition <STATUS> <confirmation.json>
//             — manual, human-driven status change (see transitionEscalation()).
//
// Nothing here contacts STRATZ, OpenDota or Steam, and nothing sends the escalation.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRACKETS, BUCKET_SEC, buildChunkQuery } from './update-data-stratz.mjs';
import { canonicalJsonSha256 } from './stratz-matchup-root-cause-research.mjs';
import { scanForCredentials } from './stratz-external-source-research.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DQ = 'research/data-quality';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const FIX17_PATHS = Object.freeze({
  finalMd: `${DQ}/stratz-support-escalation-final.md`,
  manifest: `${DQ}/stratz-support-escalation-manifest.json`,
  evidence: `${DQ}/stratz-vendor-escalation-evidence.json`,
  response: `${DQ}/stratz-vendor-response.json`,
  status: `${DQ}/stratz-support-escalation-status.json`,
});

// ---------------------------------------------------------------------------
// Sources (read-only). Hashes are always computed from the files themselves.
// ---------------------------------------------------------------------------

export const SOURCES = Object.freeze([
  { id: 'fix9Input', path: 'scripts/stratz-diagnostic-input.json', fix: 'FIX9', role: 'Original production-transport batch (32 heroes per request) and single-hero responses, 2026-11-12 07:52 UTC.', supports: ['examples', 'batch-single'] },
  { id: 'fix10Repeatability', path: `${DQ}/stratz-reverse-pair-repeatability-evidence.json`, fix: 'FIX10', role: 'Two independent repeated passes for heroes 58, 61, 79 including raw responses.', supports: ['examples', 'repeatability'] },
  { id: 'fix10Report', path: `${DQ}/stratz-reverse-pair-asymmetry-report.json`, fix: 'FIX10', role: 'Asymmetry report: affected pairs and production threshold diagnosis.', supports: ['examples'] },
  { id: 'fix11Evidence', path: `${DQ}/stratz-reverse-pair-root-cause-evidence.json`, fix: 'FIX11', role: 'Query composition controls: hero order, batch vs single, pair-only requests.', supports: ['hero-order', 'batch-single', 'stability-note'] },
  { id: 'fix11Raw', path: `${DQ}/stratz-reverse-pair-root-cause-raw-responses.json`, fix: 'FIX11', role: 'Raw responses of the FIX11 controls, including both hero orders per pair.', supports: ['examples', 'hero-order'] },
  { id: 'fix12Evidence', path: `${DQ}/stratz-reverse-pair-bracket-semantics-evidence.json`, fix: 'FIX12', role: 'Production and per-bracket filter comparisons for the 8 studied pairs.', supports: ['examples', 'query'] },
  { id: 'fix12Raw', path: `${DQ}/stratz-reverse-pair-bracket-raw-responses.json`, fix: 'FIX12', role: 'Raw responses for production and per-bracket filters.', supports: ['examples', 'bracket-partition', 'query'] },
  { id: 'fix13Evidence', path: `${DQ}/stratz-reverse-pair-partition-semantics-evidence.json`, fix: 'FIX13', role: 'Bracket partition proof on sample, winsAverage semantics, per-week rows.', supports: ['examples', 'bracket-partition', 'wins-average', 'per-bucket'] },
  { id: 'fix14Evidence', path: `${DQ}/stratz-reverse-pair-match-level-evidence.json`, fix: 'FIX14', role: 'GraphQL schema introspection: no match IDs behind matchUp rows; aggregate stability across archives.', supports: ['no-match-ids', 'stability'] },
  { id: 'fix14Raw', path: `${DQ}/stratz-reverse-pair-match-level-raw-responses.json`, fix: 'FIX14', role: 'Raw schema introspection responses.', supports: ['no-match-ids'] },
  { id: 'fix15Evidence', path: `${DQ}/stratz-external-match-level-evidence.json`, fix: 'FIX15', role: 'OpenDota reference counts per pair-week (descriptive only).', supports: ['opendota-reference'] },
  { id: 'fix15Raw', path: `${DQ}/stratz-external-match-level-raw-responses.json`, fix: 'FIX15', role: 'OpenDota explorer raw records (match_id level).', supports: ['opendota-reference'] },
  { id: 'fix16Evidence', path: `${DQ}/stratz-opendota-coverage-validation-evidence.json`, fix: 'FIX16', role: 'OpenDota enumeration, monotonicity, hero-array and boundary validation; coverage PARTIAL.', supports: ['opendota-reference'] },
  { id: 'fix16Raw', path: `${DQ}/stratz-opendota-coverage-validation-raw-responses.json`, fix: 'FIX16', role: 'OpenDota per-range coverage statistics.', supports: ['opendota-reference'] },
  { id: 'escalationV2Md', path: `${DQ}/stratz-support-escalation-v2.md`, fix: 'FIX16', role: 'Previous escalation draft (superseded by the final text).', supports: [] },
  { id: 'escalationV2Json', path: `${DQ}/stratz-support-escalation-v2.json`, fix: 'FIX16', role: 'Previous escalation draft metadata.', supports: [] },
]);

export const PRODUCTION_FILES = Object.freeze([
  'public/data/heroes.json', 'public/data/matchups.json', 'public/data/meta.json',
  'public/data/positions.json', 'scripts/update-data-stratz.mjs',
]);

/**
 * Production files that FIX16 recorded but that changed by design afterwards
 * (ТЗ №77: the item layers were retired and the generator lost its item
 * pipeline). Their FIX16 records are reported, never treated as a research
 * evidence mismatch; every other recorded reference must still match exactly.
 */
export const PRODUCTION_CHANGES_AFTER_FIX16 = Object.freeze({
  'public/data/items.json': 'RETIRED_BY_TZ77',
  'public/data/item-stats.json': 'RETIRED_BY_TZ77',
  'scripts/update-data-stratz.mjs': 'CHANGED_BY_TZ77',
});

const SELF_HASH_FIELDS = ['evidenceSha256', 'inputSha256'];

/** Physical + (where defined) canonical SHA-256 for one file. */
export function hashSource(relative, read = readFileSync, root = ROOT) {
  const bytes = read(path.join(root, relative));
  const entry = { path: relative, physicalSha256: sha256(bytes), canonicalSha256: null, storedSelfHash: null, canonicalStatus: 'NOT_DEFINED' };
  if (relative.endsWith('.json')) {
    const json = JSON.parse(bytes.toString('utf8'));
    const field = SELF_HASH_FIELDS.find((name) => typeof json[name] === 'string' && json[name].length === 64);
    if (field) {
      const computed = canonicalJsonSha256(json, field);
      if (field === 'inputSha256' && computed !== json[field]) {
        // inputSha256 here refers to another file (FIX10 report → FIX9 input), not to itself.
        entry.crossReference = { field, value: json[field] };
      } else {
        entry.canonicalSha256 = computed;
        entry.storedSelfHash = { field, value: json[field] };
        entry.canonicalStatus = computed === json[field] ? 'MATCH' : 'MISMATCH';
      }
    }
  }
  return entry;
}

/**
 * Cross-references recorded by earlier fixes, checked against the files as they
 * are now. Nothing is copied from reports by hand: each expected value is read
 * from the artifact that recorded it.
 */
export function verifyRecordedReferences(read = readFileSync, root = ROOT) {
  const json = (relative) => JSON.parse(read(path.join(root, relative), 'utf8'));
  const physical = (relative) => sha256(read(path.join(root, relative)));
  const physicalOrNull = (relative) => { try { return physical(relative); } catch { return null; } };
  const checks = [];
  const fix16 = json(`${DQ}/stratz-opendota-coverage-validation-evidence.json`);
  for (const [name, entry] of Object.entries(fix16.protectedHashes)) {
    const change = PRODUCTION_CHANGES_AFTER_FIX16[entry.path];
    const actual = change ? physicalOrNull(entry.path) : physical(entry.path);
    checks.push({ check: `FIX16 protectedHashes.${name}`, path: entry.path, expected: entry.physicalSha256, actual, ...(change && actual !== entry.physicalSha256 ? { supersededBy: change } : {}) });
  }
  checks.push({ check: 'FIX16 inputs.fix16Raw', path: fix16.inputs.fix16Raw.path, expected: fix16.inputs.fix16Raw.sha256, actual: physical(fix16.inputs.fix16Raw.path) });
  const v2 = json(`${DQ}/stratz-support-escalation-v2.json`);
  checks.push({ check: 'escalation-v2 markdown', path: v2.markdown.path, expected: v2.markdown.sha256, actual: physical(v2.markdown.path) });
  checks.push({ check: 'escalation-v2 coverageValidation (canonical)', path: v2.coverageValidation.path, expected: v2.coverageValidation.evidenceSha256, actual: canonicalJsonSha256(json(v2.coverageValidation.path), 'evidenceSha256') });
  const fix15 = json(`${DQ}/stratz-external-match-level-evidence.json`);
  checks.push({ check: 'FIX15 rawArtifact', path: fix15.rawArtifact.path, expected: fix15.rawArtifact.sha256, actual: physical(fix15.rawArtifact.path) });
  const report = json(`${DQ}/stratz-reverse-pair-asymmetry-report.json`);
  const fix9 = json('scripts/stratz-diagnostic-input.json');
  checks.push({ check: 'FIX10 report inputSha256 → FIX9 inputSha256', path: 'scripts/stratz-diagnostic-input.json', expected: report.inputSha256, actual: fix9.inputSha256 });
  return checks.map(({ supersededBy, ...item }) => ({ ...item, status: item.expected === item.actual ? 'MATCH' : supersededBy ?? 'MISMATCH' }));
}

export function buildSourceManifest(read = readFileSync, root = ROOT) {
  return {
    sources: SOURCES.map((source) => ({ id: source.id, fix: source.fix, role: source.role, supportsClaims: source.supports, ...hashSource(source.path, read, root) })),
    production: PRODUCTION_FILES.map((relative) => ({ ...hashSource(relative, read, root), role: 'Production file (protected, read-only).' })),
  };
}

/** Compare a freshly computed manifest with a saved one. */
export function compareManifests(saved, current) {
  const flat = (manifest) => [...manifest.sources, ...manifest.production].map((entry) => [entry.path, entry]);
  const now = new Map(flat(current));
  const mismatches = [];
  for (const [relative, entry] of flat(saved)) {
    const actual = now.get(relative);
    if (!actual) mismatches.push({ path: relative, field: 'missing' });
    else {
      if (actual.physicalSha256 !== entry.physicalSha256) mismatches.push({ path: relative, field: 'physicalSha256', expected: entry.physicalSha256, actual: actual.physicalSha256 });
      if (actual.canonicalSha256 !== entry.canonicalSha256) mismatches.push({ path: relative, field: 'canonicalSha256', expected: entry.canonicalSha256, actual: actual.canonicalSha256 });
    }
  }
  return mismatches;
}

// ---------------------------------------------------------------------------
// Numerical ground truth, recomputed from raw GraphQL responses.
// ---------------------------------------------------------------------------

export const EXAMPLE_PAIRS = Object.freeze([
  { canonicalPairId: '58:61', heroA: { id: 58, name: 'Enchantress' }, heroB: { id: 61, name: 'Broodmother' } },
  { canonicalPairId: '61:79', heroA: { id: 61, name: 'Broodmother' }, heroB: { id: 79, name: 'Shadow Demon' } },
]);

/**
 * Per-bucket {games, wins} for direction A→B: the `vs` row with heroId1 = A,
 * heroId2 = B inside the dryad with heroId = A. Returns null for a bucket when
 * the row is missing or ambiguous.
 */
export function directedFromResponse(response, heroA, heroB, buckets) {
  const stats = response?.data?.heroStats;
  return Object.fromEntries(buckets.map((bucket) => {
    const dryads = stats?.[`w${bucket}`];
    const dryad = Array.isArray(dryads) ? dryads.filter((item) => item.heroId === heroA) : [];
    const rows = dryad.length === 1 ? (dryad[0].vs ?? []).filter((row) => row.heroId1 === heroA && row.heroId2 === heroB) : [];
    return [bucket, rows.length === 1 ? { games: rows[0].matchCount, wins: rows[0].winCount } : null];
  }));
}

const sumBuckets = (perBucket) => {
  const values = Object.values(perBucket);
  if (values.some((value) => !value)) return null;
  return { games: values.reduce((sum, value) => sum + value.games, 0), wins: values.reduce((sum, value) => sum + value.wins, 0) };
};

/** All independent observations of one pair, from raw responses and from evidence summaries. */
export function collectPairObservations(pair, data) {
  const { fix9, fix10, fix10Report, fix11Raw, fix12, fix12Raw, fix13, buckets } = data;
  const a = pair.heroA.id;
  const b = pair.heroB.id;
  const raw = [];
  const both = (label, responseA, responseB) => {
    const ab = directedFromResponse(responseA, a, b, buckets);
    const ba = directedFromResponse(responseB, b, a, buckets);
    raw.push({ source: label, perBucket: Object.fromEntries(buckets.map((bucket) => [bucket, { AtoB: ab[bucket], BtoA: ba[bucket] }])), total: { AtoB: sumBuckets(ab), BtoA: sumBuckets(ba) } });
  };
  const chunkOf = (hero) => fix9.batchResults.chunks.find((chunk) => chunk.chunkHeroIds.includes(hero))?.response;
  both('FIX9 batch (raw)', chunkOf(a), chunkOf(b));
  const single = (hero) => fix9.singleHeroResults.find((item) => item.heroId === hero)?.response;
  if (single(a) && single(b)) both('FIX9 single-hero (raw)', single(a), single(b));
  for (const pass of fix10.passes) {
    const q = (hero) => pass.queries.find((item) => item.heroId === hero)?.response;
    both(`FIX10 pass ${pass.passNumber} (raw)`, q(a), q(b));
  }
  for (const order of [[a, b], [b, a]]) {
    const response = fix11Raw.queryResponses[`pair-${pair.canonicalPairId.replace(':', '-')}-order-${order[0]}-${order[1]}`]?.response;
    both(`FIX11 order ${order[0]},${order[1]} (raw)`, response, response);
  }
  const prod = fix12Raw.queryResponses[`pair-${pair.canonicalPairId.replace(':', '-')}-filter-production`]?.response;
  both('FIX12 production filter (raw)', prod, prod);

  const affected = fix10Report.affectedPairs.find((item) => item.canonicalPairId === pair.canonicalPairId);
  const fix12Agg = fix12.pairFilterComparisons.find((item) => item.canonicalPairId === pair.canonicalPairId && item.filterId === 'production')?.result;
  const weeks = fix13.rankAsymmetryContribution.pairWeekRows.filter((row) => row.canonicalPairId === pair.canonicalPairId).sort((x, y) => x.bucket - y.bucket);
  const summaries = [
    { source: 'FIX10 asymmetry report', AtoB: affected?.gamesA ?? null, BtoA: affected?.gamesB ?? null, winsAtoB: affected?.winsA ?? null, winsBtoA: affected?.winsB ?? null },
    { source: 'FIX12 production comparison', AtoB: fix12Agg?.AtoB ?? null, BtoA: fix12Agg?.BtoA ?? null },
    { source: 'FIX13 per-week rows (sum)', AtoB: weeks.reduce((sum, row) => sum + row.production.gamesAtoB, 0), BtoA: weeks.reduce((sum, row) => sum + row.production.gamesBtoA, 0), winsAtoB: weeks.reduce((sum, row) => sum + row.production.winsAtoB, 0), winsBtoA: weeks.reduce((sum, row) => sum + row.production.winsBtoA, 0) },
  ];
  return { raw, summaries, weeks };
}

/** Ground truth for a pair, or a list of disagreements between the independent observations. */
export function establishPairTruth(pair, data) {
  const { raw, summaries, weeks } = collectPairObservations(pair, data);
  const disagreements = [];
  const reference = raw.find((item) => item.source === 'FIX12 production filter (raw)');
  for (const item of raw) {
    for (const bucket of data.buckets) {
      for (const dir of ['AtoB', 'BtoA']) {
        const value = item.perBucket[bucket][dir];
        const ref = reference.perBucket[bucket][dir];
        if (!value || !ref || value.games !== ref.games || value.wins !== ref.wins) {
          disagreements.push({ source: item.source, bucket, direction: dir, value, reference: ref });
        }
      }
    }
  }
  const totals = reference.total;
  for (const item of summaries) {
    if (item.AtoB !== totals.AtoB.games || item.BtoA !== totals.BtoA.games) disagreements.push({ source: item.source, field: 'games', value: [item.AtoB, item.BtoA], reference: [totals.AtoB.games, totals.BtoA.games] });
    if ('winsAtoB' in item && (item.winsAtoB !== totals.AtoB.wins || item.winsBtoA !== totals.BtoA.wins)) disagreements.push({ source: item.source, field: 'wins', value: [item.winsAtoB, item.winsBtoA], reference: [totals.AtoB.wins, totals.BtoA.wins] });
  }
  const groupsByBucket = Object.fromEntries(weeks.map((row) => [row.bucket, Object.fromEntries(row.groups.map((group) => [group.bracket, { AtoB: group.gamesAtoB, BtoA: group.gamesBtoA, winsAtoB: group.winsAtoB, winsBtoA: group.winsBtoA }]))]));
  for (const row of weeks) {
    const fromRaw = reference.perBucket[row.bucket];
    if (row.production.gamesAtoB !== fromRaw.AtoB.games || row.production.gamesBtoA !== fromRaw.BtoA.games) disagreements.push({ source: 'FIX13 per-week production', bucket: row.bucket });
    const groups = Object.values(groupsByBucket[row.bucket]);
    if (groups.reduce((s, g) => s + g.AtoB, 0) !== row.production.gamesAtoB || groups.reduce((s, g) => s + g.BtoA, 0) !== row.production.gamesBtoA) disagreements.push({ source: 'FIX13 bracket groups sum', bucket: row.bucket });
    if (row.groups.map((group) => group.bracket).join(',') !== BRACKETS.join(',')) disagreements.push({ source: 'FIX13 bracket groups', bucket: row.bucket, field: 'brackets' });
  }
  return {
    pair,
    perBucket: Object.fromEntries(data.buckets.map((bucket) => [bucket, { AtoB: reference.perBucket[bucket].AtoB.games, BtoA: reference.perBucket[bucket].BtoA.games }])),
    total: { AtoB: totals.AtoB.games, BtoA: totals.BtoA.games, delta: totals.AtoB.games - totals.BtoA.games, winsAtoB: totals.AtoB.wins, winsBtoA: totals.BtoA.wins },
    groupsByBucket,
    observationSources: [...raw.map((item) => item.source), ...summaries.map((item) => item.source)],
    disagreements,
  };
}

// ---------------------------------------------------------------------------
// Supporting facts (each read from the evidence that established it).
// ---------------------------------------------------------------------------

export function collectFacts(data) {
  const { fix10, fix11, fix12, fix12Raw, fix13, fix14, fix15, fix16, buckets } = data;
  const order = fix11.queryComposition.comparisons.orderComparisons;
  const controls = fix11.rootCause.evidence.find((item) => item.id === 'current-query-composition-controls');
  const caps = fix14.discoveredCapabilities;
  const ratios = fix15.reconciliation.flatMap((row) => [row.comparison?.stratzToExternalRatioAtoB, row.comparison?.stratzToExternalRatioBtoA]).filter(Number.isFinite);
  const example = fix15.reconciliation.find((row) => row.canonicalPairId === '58:61' && row.bucket === 2963);
  const productionRequest = (pairId) => fix12.querySummary.requests.find((request) => request.canonicalPairId === pairId && request.filterId === 'production');
  return {
    partition: { status: fix13.partitionVerification.status, matching: Math.min(fix13.partitionVerification.matchingGamesAtoB, fix13.partitionVerification.matchingGamesBtoA, fix13.partitionVerification.matchingWinsAtoB, fix13.partitionVerification.matchingWinsBtoA), total: fix13.partitionVerification.pairWeekObservations },
    winsAverage: { status: fix13.winsAverageSemantics.status, matching: fix13.winsAverageSemantics.matchingWinRatioRows, total: fix13.winsAverageSemantics.relevantRows, schemaContract: fix13.winsAverageSemantics.schemaContract },
    repeatability: { status: fix10.status, matchingRows: fix10.matchingRowCount, mismatchingRows: fix10.mismatchingRowCount, passes: fix10.passes.length },
    batchSingle: { pairOnlyVsSingle: controls?.pairOnlyVsSingleMismatches ?? null, singleVsBatch: controls?.singleHeroVsMatchedBatchMismatches ?? null, historicalFix9BatchMismatches: fix11.queryComposition.summary.historicalFix9BatchMismatchCount },
    heroOrder: { pass: order.filter((item) => item.comparison.status === 'PASS').length, total: order.length, mismatchingRows: order.reduce((sum, item) => sum + item.comparison.mismatchingRowCount, 0) },
    perBucket: { equal: fix13.rankAsymmetryContribution.pairWeekRows.filter((row) => row.production.gamesAtoB === row.production.gamesBtoA).length, total: fix13.rankAsymmetryContribution.pairWeekRows.length },
    stability: { stable: fix14.countReconciliation.aggregateStablePairWeeks, total: fix14.countReconciliation.aggregatePairWeeks },
    noMatchIds: {
      status: caps.status,
      typeCount: caps.typeCount,
      matchListEndpoints: caps.matchListEndpoints.length,
      entityScoped: caps.matchListEndpoints.filter((item) => item.scope === 'ENTITY_SCOPED').length,
      unscopedWithoutFilters: caps.matchListEndpoints.filter((item) => item.scope !== 'ENTITY_SCOPED' && !(item.heroPairFilter && item.timeFilter && item.bracketFilter)).length,
      populationCandidates: caps.populationCandidates.length,
    },
    openDota: {
      pairWeeks: fix15.reconciliation.length,
      min: Math.min(...ratios),
      max: Math.max(...ratios),
      example: { stratzAtoB: example.stratz.gamesAtoB, stratzBtoA: example.stratz.gamesBtoA, external: example.comparison.externalMatches },
      coverageStatus: fix16.sourceCoverage.classification,
    },
    query: {
      production: buildChunkQuery([58, 61], buckets),
      example: fix12Raw.queryResponses['pair-58-61-filter-production'].query,
      requestHash: productionRequest('58:61').requestHash,
      responseHash: productionRequest('58:61').responseHash,
      requestedAt: productionRequest('58:61').startedAt,
    },
    windows: buckets.map((bucket) => ({ bucket, startUtc: new Date(bucket * BUCKET_SEC * 1000).toISOString().slice(0, 10), endUtcExclusive: new Date((bucket + 1) * BUCKET_SEC * 1000).toISOString().slice(0, 10) })),
    retrievedOn: fix12.createdAt.slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Final escalation text.
// ---------------------------------------------------------------------------

export const QUESTIONS = Object.freeze([
  { id: 'Q1', text: 'Is `matchCount` for A→B expected to equal `matchCount` for B→A (same week, same `bracketBasicIds`)? Is this part of the API contract?' },
  { id: 'Q2', text: 'What exactly does the top-level `heroId` of a `heroStats.matchUp` entry represent?' },
  { id: 'Q3', text: 'How are `heroId1` and `heroId2` assigned in the `vs` rows?' },
  { id: 'Q4', text: 'Why can the reverse-direction `matchCount` values differ?' },
  { id: 'Q5', text: 'How is `bracketBasicIds` applied to the two players of one match (per player, per match, or otherwise)?' },
  { id: 'Q6', text: 'Which match eligibility rules are used for `matchCount`?' },
  { id: 'Q7', text: 'How are lobby types and game modes filtered?' },
  { id: 'Q8', text: 'How are matches with an unknown rank excluded or counted?' },
  { id: 'Q9', text: 'What are the exact semantics of `week` (bucket definition and which match timestamp is used)?' },
  { id: 'Q10', text: 'Why are match-level IDs not available from `matchUp`?' },
  { id: 'Q11', text: 'Is there an official way to obtain the underlying match IDs for a specific `matchUp` row?' },
]);

export const REQUESTS = Object.freeze([
  'official documentation of the `matchUp` fields (`heroId`, `heroId1`, `heroId2`, `matchCount`, `winCount`, `winsAverage`);',
  'an example query;',
  'the expected result for that query;',
  'an explanation of the directional count semantics;',
  'any known limitations of the aggregation pipeline (sampling, delays, reprocessing).',
]);

export const OPENDOTA_SENTENCE = (min, max) => `In our independent OpenDota reference sample, STRATZ directional match counts ranged from approximately ${min.toFixed(2)} to ${max.toFixed(2)} of the corresponding external pair-match counts. This is not a coverage estimate because the two sources do not expose equivalent match eligibility, rank, and completeness filters.`;

const fmtDelta = (value) => (value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : '0');
const label = (pair) => `${pair.heroA.name} (${pair.heroA.id}) / ${pair.heroB.name} (${pair.heroB.id})`;

export function renderFinalMarkdown({ truths, facts, attachments, buckets }) {
  const f = facts;
  const lines = [
    '# heroStats.matchUp: matchCount differs between A→B and B→A for the same week and brackets',
    '',
    'Hello STRATZ team,',
    '',
    '## 1. Short description',
    '',
    'We use the public GraphQL API (`heroStats.matchUp`) to build hero-vs-hero statistics. For the same weeks and the same `bracketBasicIds`, the `matchCount` returned for hero A against hero B differs from the `matchCount` returned for hero B against hero A. The difference is reproducible and stable across repeated requests. We would like to understand whether this is expected and how the aggregate is defined.',
    '',
    '## 2. Exact reproducible examples',
    '',
    'A→B is the `vs` row with `heroId1 = A, heroId2 = B` inside the entry with top-level `heroId = A`; B→A is the row with `heroId1 = B, heroId2 = A` inside the entry with `heroId = B`. Counts are summed over the four weekly buckets below; all values are integers exactly as returned.',
    '',
    '### Totals over four weeks',
    '',
    '| Hero pair | A→B matchCount | B→A matchCount | Delta (A→B − B→A) |',
    '|---|---:|---:|---:|',
    ...truths.map((t) => `| ${label(t.pair)} | ${t.total.AtoB} | ${t.total.BtoA} | ${fmtDelta(t.total.delta)} |`),
    '',
    '### Per week (A→B / B→A)',
    '',
    `| Hero pair | ${buckets.map((bucket) => `week ${bucket}`).join(' | ')} |`,
    `|---|${buckets.map(() => '---:').join('|')}|`,
    ...truths.map((t) => `| ${label(t.pair)} | ${buckets.map((bucket) => `${t.perBucket[bucket].AtoB} / ${t.perBucket[bucket].BtoA}`).join(' | ')} |`),
    '',
  ];
  for (const t of truths) {
    const bucket = buckets[0];
    lines.push(`### Per bracket, week ${bucket}: ${label(t.pair)} (A→B / B→A)`, '');
    for (const bracket of BRACKETS) lines.push(`- \`${bracket}\`: ${t.groupsByBucket[bucket][bracket].AtoB} / ${t.groupsByBucket[bucket][bracket].BtoA}`);
    lines.push(`- all four brackets in one request: ${t.perBucket[bucket].AtoB} / ${t.perBucket[bucket].BtoA}`, '');
  }
  lines.push(
    '## 3. Production query configuration',
    '',
    '- Endpoint: `https://api.stratz.com/graphql`',
    `- \`bracketBasicIds\`: ${BRACKETS.map((bracket) => `\`${bracket}\``).join(', ')}`,
    `- \`week\`: bucket × ${BUCKET_SEC} (Unix seconds); buckets ${buckets.join(', ')}`,
    `- Window: ${f.windows[0].startUtc} to ${f.windows.at(-1).endUtcExclusive} UTC (end exclusive), weeks ${f.windows.map((w) => `${w.bucket} = ${w.startUtc}`).join(', ')}`,
    '- `take: 200`; production requests the fields `heroId`, `vs { heroId1 heroId2 matchCount winCount }`',
    '',
    'Exact request for the first pair as sent in our diagnostic run (no credentials; sent with a standard API token). It is the production query with three additional fields (`winRateHeroId1`, `winRateHeroId2`, `winsAverage`); `matchCount` and `winCount` were identical with and without these fields:',
    '',
    '```graphql',
    f.query.example,
    '```',
    '',
    `SHA-256 of the query text above: \`${f.query.requestHash}\`; normalized response SHA-256: \`${f.query.responseHash}\` (retrieved ${f.query.requestedAt}).`,
    '',
    '## 4. What has already been verified',
    '',
    `1. Bracket partition: querying each of the four production bracket groups separately and summing reproduces the multi-bracket \`matchCount\` and \`winCount\` exactly, in both directions, in ${f.partition.matching}/${f.partition.total} pair-weeks.`,
    `2. \`winsAverage\` equals \`winCount / matchCount\` (within the returned rounding) in ${f.winsAverage.matching}/${f.winsAverage.total} checked rows. This is our empirical observation, not a documented contract.`,
    `3. Reproducibility: batched (32 heroes per request), single-hero and pair-only requests return identical rows, and ${f.repeatability.passes} independent repeated passes matched in all ${f.repeatability.matchingRows} rows.`,
    `4. Hero order: swapping the order of \`heroIds\` in the request does not change any row (${f.heroOrder.pass}/${f.heroOrder.total} pairs).`,
    `5. The reverse counts differ within individual weeks, not only in the four-week sum (${f.perBucket.equal}/${f.perBucket.total} pair-weeks have equal reverse counts).`,
    `6. Stability: for the studied pairs the values were identical across ${f.stability.stable}/${f.stability.total} pair-weeks in all archived retrievals on ${f.retrievedOn}. Rows for some other heroes did change between retrievals that day, so values can change over time.`,
    '',
    '### Independent OpenDota reference',
    '',
    `For context only, we counted matches for the same pairs and weeks in OpenDota's \`public_matches\` table (ranked matchmaking, match-average rank Herald–Immortal, the two heroes on opposing teams). Example: ${label(EXAMPLE_PAIRS[0])}, week ${buckets[0]}: STRATZ ${f.openDota.example.stratzAtoB} (A→B) / ${f.openDota.example.stratzBtoA} (B→A), OpenDota reference ${f.openDota.example.external} matches.`,
    '',
    OPENDOTA_SENTENCE(f.openDota.min, f.openDota.max),
    '',
    'Limitations of this reference: OpenDota does not document the completeness of `public_matches`; its rank is a match average rather than per player; lobby type and game mode eligibility may differ; and its match IDs cannot be linked to individual `matchUp` rows. We use it only to motivate the question about eligibility criteria.',
    '',
    '## 5. API limitations discovered during introspection',
    '',
    `- Schema introspection (${f.noMatchIds.typeCount} types) found no field that returns the match IDs behind a \`matchUp\` row.`,
    `- ${f.noMatchIds.matchListEndpoints} fields return match lists: ${f.noMatchIds.entityScoped} require a specific player, team, league, guild or match ID, and the remaining ${f.noMatchIds.unscopedWithoutFilters} lack a hero-pair, time or bracket filter.`,
    '- The schema description of `winsAverage` is empty, and the descriptions of `heroId1`, `heroId2` and `matchCount` do not state whether reverse counts are expected to be equal.',
    '',
    'Because of this we cannot reconcile the two directions at match level on our side.',
    '',
    '## 6. Questions',
    '',
    ...QUESTIONS.map((question, index) => `${index + 1}. ${question.text}`),
    '',
    'If possible, please share:',
    '',
    ...REQUESTS.map((request) => `- ${request}`),
    '',
    '## 7. Supporting evidence',
    '',
    'We can provide the following compact attachments (no credentials; large raw archives available on request):',
    '',
    ...attachments.map((item) => `- ${item.id}. ${item.title} (SHA-256 \`${item.contentSha256}\`)`),
    '',
    'Thank you for your help.',
    '',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Attachments (compact, derived; no raw archives).
// ---------------------------------------------------------------------------

export function buildAttachments({ truths, facts, buckets }) {
  const items = [
    { id: 'A1', title: 'Sanitized GraphQL query', sources: ['fix12Raw'], content: { query: facts.query.example, productionQuery: facts.query.production, requestSha256: facts.query.requestHash, responseSha256: facts.query.responseHash } },
    { id: 'A2', title: 'Pair-level summary', sources: ['fix9Input', 'fix10Repeatability', 'fix11Raw', 'fix12Raw', 'fix13Evidence'], content: truths.map((t) => ({ pair: label(t.pair), buckets, perBucket: t.perBucket, total: t.total })) },
    { id: 'A3', title: 'Bracket partition summary', sources: ['fix13Evidence', 'fix12Raw'], content: { brackets: [...BRACKETS], pairWeeksMatching: facts.partition.matching, pairWeeks: facts.partition.total, status: facts.partition.status, examples: truths.map((t) => ({ pair: label(t.pair), groupsByBucket: t.groupsByBucket })) } },
    { id: 'A4', title: 'Repeatability summary', sources: ['fix10Repeatability', 'fix11Evidence', 'fix14Evidence'], content: { repeatability: facts.repeatability, heroOrder: facts.heroOrder, batchSingle: facts.batchSingle, stability: facts.stability } },
    { id: 'A5', title: 'Match-level API capability limitation', sources: ['fix14Evidence'], content: facts.noMatchIds },
    { id: 'A6', title: 'OpenDota comparison caveat', sources: ['fix15Evidence', 'fix16Evidence'], content: { statement: OPENDOTA_SENTENCE(facts.openDota.min, facts.openDota.max), classification: 'REFERENCE_RATIO_NOT_COVERAGE_ESTIMATE', externalCoverage: facts.openDota.coverageStatus, ratioMin: facts.openDota.min, ratioMax: facts.openDota.max } },
  ];
  return items.map((item) => ({ ...item, contentSha256: canonicalJsonSha256({ content: item.content, evidenceSha256: '' }, 'evidenceSha256') }));
}

// ---------------------------------------------------------------------------
// Content validation: parse the Markdown and compare with recomputed values.
// ---------------------------------------------------------------------------

const MINUS = /[−-]/;
const toInt = (text) => Number(text.replace(MINUS, '-').replace('+', ''));

/** Extract the numeric claims of the final Markdown. */
export function extractMarkdownClaims(markdown) {
  const totals = [...markdown.matchAll(/^\| (.+?) \((\d+)\) \/ (.+?) \((\d+)\) \| (\d+) \| (\d+) \| ([+−-]?\d+) \|$/gm)]
    .map((m) => ({ heroA: Number(m[2]), heroB: Number(m[4]), AtoB: Number(m[5]), BtoA: Number(m[6]), delta: toInt(m[7]) }));
  const weekHeader = markdown.match(/^\| Hero pair \| (week \d+(?: \| week \d+)*) \|$/m);
  const weekBuckets = weekHeader ? weekHeader[1].split(' | ').map((cell) => Number(cell.replace('week ', ''))) : [];
  const weekly = [...markdown.matchAll(/^\| .+? \((\d+)\) \/ .+? \((\d+)\) \| (\d+ \/ \d+(?: \| \d+ \/ \d+)*) \|$/gm)]
    .map((m) => ({ heroA: Number(m[1]), heroB: Number(m[2]), cells: m[3].split(' | ').map((cell) => cell.split(' / ').map(Number)) }));
  const brackets = [...markdown.matchAll(/^### Per bracket, week (\d+): .+? \((\d+)\) \/ .+? \((\d+)\) \(A→B \/ B→A\)\n\n((?:- .+\n)+)/gm)].map((m) => ({
    bucket: Number(m[1]),
    heroA: Number(m[2]),
    heroB: Number(m[3]),
    groups: [...m[4].matchAll(/^- `([A-Z_]+)`: (\d+) \/ (\d+)$/gm)].map((g) => ({ bracket: g[1], AtoB: Number(g[2]), BtoA: Number(g[3]) })),
    combined: (m[4].match(/^- all four brackets in one request: (\d+) \/ (\d+)$/m) ?? []).slice(1).map(Number),
  }));
  const queryText = markdown.match(/```graphql\n([\s\S]*?)\n```/)?.[1] ?? null;
  const queryHash = markdown.match(/SHA-256 of the query text above: `([0-9a-f]{64})`/)?.[1] ?? null;
  const configBrackets = (markdown.match(/^- `bracketBasicIds`: (.+)$/m)?.[1] ?? '').split(', ').map((item) => item.replace(/`/g, ''));
  const queryBrackets = (markdown.match(/bracketBasicIds: \[([A-Z_, ]+)\]/)?.[1] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const grab = (re) => (markdown.match(re) ?? []).slice(1).map(Number);
  return {
    totals,
    weekBuckets,
    weekly,
    brackets,
    configBrackets,
    queryBrackets,
    queryText,
    queryHash,
    partition: grab(/in (\d+)\/(\d+) pair-weeks\./),
    winsAverage: grab(/in (\d+)\/(\d+) checked rows/),
    repeatability: grab(/(\d+) independent repeated passes matched in all (\d+) rows/),
    heroOrder: grab(/\((\d+)\/(\d+) pairs\)/),
    perBucketEqual: grab(/\((\d+)\/(\d+) pair-weeks have equal reverse counts\)/),
    stability: grab(/identical across (\d+)\/(\d+) pair-weeks/),
    typeCount: grab(/introspection \((\d+) types\)/),
    endpoints: grab(/(\d+) fields return match lists: (\d+) require .+?remaining (\d+) lack/),
    openDotaExample: grab(/STRATZ (\d+) \(A→B\) \/ (\d+) \(B→A\), OpenDota reference (\d+) matches/),
    openDotaRatio: (markdown.match(/approximately (\d\.\d\d) to (\d\.\d\d) of the corresponding/) ?? []).slice(1),
  };
}

export const FORBIDDEN_OPENDOTA_PHRASES = Object.freeze([
  /\bSTRATZ\s+(?:loses|lost|is\s+losing|is\s+missing|misses|drops)\b/i,
  /\bcovers?\s+only\b/i,
  /\b45\s*[–-]\s*67\s*%/,
  /\b33\s*[–-]\s*55\s*%/,
  /OpenDota\s+(?:proves|proved|demonstrates|confirms|shows)\b/i,
  /\bcoverage\s+(?:of|rate|ratio)\s+(?:of\s+)?STRATZ\b/i,
  /\bSTRATZ(?:'s)?\s+coverage\b/i,
]);

/** Compare the Markdown claims with ground truth; every mismatch is listed. */
export function validateContent(markdown, { truths, facts, buckets }) {
  const claims = extractMarkdownClaims(markdown);
  const mismatches = [];
  let checked = 0;
  const expect = (claim, actual, expected) => {
    checked += 1;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches.push({ claim, found: actual, expected });
  };
  for (const t of truths) {
    const total = claims.totals.find((row) => row.heroA === t.pair.heroA.id && row.heroB === t.pair.heroB.id);
    expect(`totals ${t.pair.canonicalPairId} (orientation A=${t.pair.heroA.id})`, total ? [total.AtoB, total.BtoA, total.delta] : null, [t.total.AtoB, t.total.BtoA, t.total.delta]);
    const week = claims.weekly.find((row) => row.heroA === t.pair.heroA.id && row.heroB === t.pair.heroB.id);
    expect(`weekly ${t.pair.canonicalPairId}`, week?.cells ?? null, buckets.map((bucket) => [t.perBucket[bucket].AtoB, t.perBucket[bucket].BtoA]));
    if (week && total) {
      expect(`bucket aggregation ${t.pair.canonicalPairId}`, [week.cells.reduce((s, c) => s + c[0], 0), week.cells.reduce((s, c) => s + c[1], 0)], [total.AtoB, total.BtoA]);
      expect(`delta arithmetic ${t.pair.canonicalPairId}`, total.delta, total.AtoB - total.BtoA);
    }
    const br = claims.brackets.find((row) => row.heroA === t.pair.heroA.id && row.heroB === t.pair.heroB.id);
    expect(`bracket breakdown ${t.pair.canonicalPairId}`, br ? br.groups : null, BRACKETS.map((bracket) => ({ bracket, AtoB: t.groupsByBucket[br?.bucket ?? buckets[0]][bracket].AtoB, BtoA: t.groupsByBucket[br?.bucket ?? buckets[0]][bracket].BtoA })));
    if (br) {
      expect(`bracket sum ${t.pair.canonicalPairId}`, [br.groups.reduce((s, g) => s + g.AtoB, 0), br.groups.reduce((s, g) => s + g.BtoA, 0)], br.combined);
      expect(`bracket combined ${t.pair.canonicalPairId}`, br.combined, [t.perBucket[br.bucket].AtoB, t.perBucket[br.bucket].BtoA]);
    }
  }
  expect('week columns', claims.weekBuckets, buckets);
  expect('query text hash', claims.queryText === null ? null : sha256(claims.queryText), facts.query.requestHash);
  expect('query hash stated', claims.queryHash, facts.query.requestHash);
  expect('production query differs only by extra fields', claims.queryText?.replace(/ winRateHeroId1 winRateHeroId2 winsAverage/g, '') ?? null, facts.query.production);
  expect('batch/single/pair-only controls', [facts.batchSingle.pairOnlyVsSingle, facts.batchSingle.singleVsBatch], [0, 0]);
  expect('production brackets (configuration)', claims.configBrackets, [...BRACKETS]);
  expect('production brackets (query)', claims.queryBrackets, [...BRACKETS]);
  expect('bracket partition', claims.partition, [facts.partition.matching, facts.partition.total]);
  expect('winsAverage', claims.winsAverage, [facts.winsAverage.matching, facts.winsAverage.total]);
  expect('repeatability', claims.repeatability, [facts.repeatability.passes, facts.repeatability.matchingRows]);
  expect('hero order', claims.heroOrder, [facts.heroOrder.pass, facts.heroOrder.total]);
  expect('per-bucket asymmetry', claims.perBucketEqual, [facts.perBucket.equal, facts.perBucket.total]);
  expect('stability', claims.stability, [facts.stability.stable, facts.stability.total]);
  expect('schema type count', claims.typeCount, [facts.noMatchIds.typeCount]);
  expect('match-list endpoints', claims.endpoints, [facts.noMatchIds.matchListEndpoints, facts.noMatchIds.entityScoped, facts.noMatchIds.unscopedWithoutFilters]);
  expect('OpenDota example', claims.openDotaExample, [facts.openDota.example.stratzAtoB, facts.openDota.example.stratzBtoA, facts.openDota.example.external]);
  expect('OpenDota ratio range', claims.openDotaRatio, [facts.openDota.min.toFixed(2), facts.openDota.max.toFixed(2)]);
  checked += 1;
  if (!markdown.includes(OPENDOTA_SENTENCE(facts.openDota.min, facts.openDota.max))) mismatches.push({ claim: 'OpenDota caveat sentence', found: null, expected: 'required sentence' });
  for (const pattern of FORBIDDEN_OPENDOTA_PHRASES) {
    checked += 1;
    const hit = markdown.match(pattern);
    if (hit) mismatches.push({ claim: 'forbidden OpenDota phrasing', found: hit[0], expected: null });
  }
  for (const pair of truths) {
    checked += 1;
    if (pair.disagreements.length) mismatches.push({ claim: `historical agreement ${pair.pair.canonicalPairId}`, found: pair.disagreements, expected: [] });
  }
  for (const question of QUESTIONS) {
    checked += 1;
    if (!markdown.includes(question.text)) mismatches.push({ claim: `question ${question.id}`, found: null, expected: question.text });
  }
  return { status: mismatches.length ? 'FAIL' : 'PASS', checkedClaims: checked, mismatches };
}

// ---------------------------------------------------------------------------
// Security.
// ---------------------------------------------------------------------------

const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/i;
const IP_HEADERS = /\b(?:x-ip-address|x-forwarded-for|x-real-ip|cf-connecting-ip|true-client-ip)\b/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const ENV_FILE = /(^|\n)\s*[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)\s*=\s*\S+/;

/** Secret values from .env (used only for comparison; never stored or returned). */
export function loadKnownSecrets(read = readFileSync, root = ROOT) {
  try {
    const text = read(path.join(root, '.env'), 'utf8');
    return text.split('\n').map((line) => line.match(/^\s*[A-Z0-9_]+\s*=\s*(.+?)\s*$/)?.[1]?.replace(/^["']|["']$/g, '')).filter((value) => value && value.length >= 8);
  } catch {
    return [];
  }
}

/** Findings for one text. `strict` adds IP addresses, e-mail addresses and .env-like lines. */
export function securityFindings(text, { knownSecrets = [], strict = true, label: where = 'text' } = {}) {
  const findings = scanForCredentials(text, knownSecrets).map((kind) => ({ where, kind }));
  if (IP_HEADERS.test(text)) findings.push({ where, kind: 'IP_HEADER' });
  if (strict) {
    if (IPV4.test(text) || IPV6.test(text)) findings.push({ where, kind: 'IP_ADDRESS' });
    if (EMAIL.test(text)) findings.push({ where, kind: 'EMAIL_ADDRESS' });
    if (ENV_FILE.test(text)) findings.push({ where, kind: 'ENV_ASSIGNMENT' });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Escalation status machine.
// ---------------------------------------------------------------------------

export const ESCALATION_STATUSES = Object.freeze(['DRAFTED', 'READY_FOR_SUBMISSION', 'SENT', 'ACKNOWLEDGED', 'ANSWERED', 'CLOSED']);
const ALLOWED = Object.freeze({
  DRAFTED: ['READY_FOR_SUBMISSION'],
  READY_FOR_SUBMISSION: ['SENT', 'DRAFTED'],
  SENT: ['ACKNOWLEDGED', 'ANSWERED'],
  ACKNOWLEDGED: ['ANSWERED'],
  ANSWERED: ['CLOSED'],
  CLOSED: [],
});
const AUTOMATED_ACTORS = /^(?:generator|automation|system|script|claude|assistant|bot|ci)$/i;
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const isoTime = (value) => nonEmpty(value) && !Number.isNaN(Date.parse(value));

export function initialStatusRecord() {
  return {
    schemaVersion: 1,
    escalation: FIX17_PATHS.finalMd,
    status: 'DRAFTED',
    submission: { sent: false, ticketReference: null, submissionChannel: null, sentAt: null, confirmedBy: null },
    statusHistory: [{ status: 'DRAFTED', by: 'generator', note: 'Final escalation generated (FIX17); not sent.' }],
    policy: 'Status changes only through transitionEscalation(). SENT and later states require explicit human confirmation; generating Markdown never changes the status.',
  };
}

/**
 * Controlled status change. Returns a new record; throws if the transition is
 * not allowed or its required confirmation is missing.
 */
export function transitionEscalation(record, to, payload = {}, { validation } = {}) {
  if (!ESCALATION_STATUSES.includes(to)) throw new Error(`Unknown escalation status ${to}`);
  if (!(ALLOWED[record.status] ?? []).includes(to)) throw new Error(`Transition ${record.status} → ${to} is not allowed`);
  const human = nonEmpty(payload.confirmedBy) && !AUTOMATED_ACTORS.test(payload.confirmedBy.trim());
  const entry = { status: to };
  let submission = record.submission;
  if (to === 'READY_FOR_SUBMISSION') {
    const ok = validation && ['content', 'hashes', 'security'].every((key) => validation[key] === 'PASS' || validation[key] === 'CLEAN');
    if (!ok) throw new Error('READY_FOR_SUBMISSION requires passing content, hash and security validation');
    Object.assign(entry, { by: payload.confirmedBy ?? 'validation', validation: { content: validation.content, hashes: validation.hashes, security: validation.security } });
  } else if (to === 'DRAFTED') {
    if (!human) throw new Error('Returning to DRAFTED requires a human confirmedBy');
    Object.assign(entry, { by: payload.confirmedBy, note: payload.note ?? null });
  } else if (to === 'SENT') {
    if (payload.humanConfirmed !== true || !human) throw new Error('SENT requires explicit human confirmation (humanConfirmed: true, confirmedBy)');
    for (const field of ['ticketReference', 'submissionChannel']) if (!nonEmpty(payload[field])) throw new Error(`SENT requires ${field}`);
    if (!isoTime(payload.sentAt)) throw new Error('SENT requires sentAt (ISO timestamp)');
    submission = { sent: true, ticketReference: payload.ticketReference, submissionChannel: payload.submissionChannel, sentAt: payload.sentAt, confirmedBy: payload.confirmedBy };
    Object.assign(entry, { by: payload.confirmedBy, at: payload.sentAt, reference: payload.ticketReference, channel: payload.submissionChannel });
  } else if (to === 'ACKNOWLEDGED') {
    if (!human || !nonEmpty(payload.reference) || !nonEmpty(payload.acknowledgement) || !isoTime(payload.acknowledgedAt)) {
      throw new Error('ACKNOWLEDGED requires confirmedBy, acknowledgement, acknowledgedAt and reference');
    }
    Object.assign(entry, { by: payload.confirmedBy, at: payload.acknowledgedAt, reference: payload.reference, acknowledgement: payload.acknowledgement });
  } else if (to === 'ANSWERED') {
    const response = payload.response;
    const result = response ? validateResponse(response) : null;
    if (!human || !result || result.status !== 'RECEIVED') throw new Error(`ANSWERED requires confirmedBy and a valid received response${result ? `: ${result.errors.join('; ')}` : ''}`);
    if (response.ticketReference !== record.submission.ticketReference) throw new Error('ANSWERED response ticketReference does not match the submitted ticket');
    Object.assign(entry, { by: payload.confirmedBy, at: response.receivedAt, reference: response.ticketReference, responseSha256: response.responseSha256 });
  } else if (to === 'CLOSED') {
    if (!human || !isoTime(payload.closedAt) || !nonEmpty(payload.reason)) throw new Error('CLOSED requires confirmedBy, closedAt and reason');
    Object.assign(entry, { by: payload.confirmedBy, at: payload.closedAt, reason: payload.reason });
  }
  return { ...record, status: to, submission, statusHistory: [...record.statusHistory, entry] };
}

export function validateStatusRecord(record) {
  const errors = [];
  if (!ESCALATION_STATUSES.includes(record?.status)) errors.push(`unknown status ${record?.status}`);
  if (record?.statusHistory?.at(-1)?.status !== record?.status) errors.push('status does not match the last history entry');
  const sentIndex = ESCALATION_STATUSES.indexOf('SENT');
  const index = ESCALATION_STATUSES.indexOf(record?.status);
  if (index >= sentIndex) {
    const s = record.submission ?? {};
    if (!s.sent || !nonEmpty(s.ticketReference) || !nonEmpty(s.submissionChannel) || !isoTime(s.sentAt) || !nonEmpty(s.confirmedBy) || AUTOMATED_ACTORS.test(s.confirmedBy)) errors.push('status at or beyond SENT without complete human submission confirmation');
  } else if (record?.submission?.sent) errors.push('submission.sent is true while status is before SENT');
  return { status: errors.length ? 'INVALID' : 'VALID', errors };
}

// ---------------------------------------------------------------------------
// Vendor response intake.
// ---------------------------------------------------------------------------

export function responseTemplate() {
  return {
    schemaVersion: 1,
    ticketReference: null,
    receivedAt: null,
    sender: null,
    source: null,
    originalResponse: '',
    attachments: [],
    responseSha256: '',
    inputStatus: 'NOT_RECEIVED',
  };
}

/** Validate the vendor response input. Never fabricates content. */
export function validateResponse(response, { read = readFileSync, root = ROOT } = {}) {
  const errors = [];
  if (!response || response.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (response?.inputStatus === 'NOT_RECEIVED') {
    if (response.originalResponse !== '' || response.responseSha256 !== '' || response.ticketReference !== null || response.receivedAt !== null || response.sender !== null || response.source !== null || (response.attachments ?? []).length) {
      errors.push('NOT_RECEIVED input must be the empty template (no text, hash, sender, source, ticket or attachments)');
    }
    return { status: errors.length ? 'INVALID' : 'NOT_RECEIVED', errors };
  }
  if (response?.inputStatus !== 'RECEIVED') errors.push('inputStatus must be NOT_RECEIVED or RECEIVED');
  if (!nonEmpty(response?.originalResponse)) errors.push('originalResponse is empty');
  if (!isoTime(response?.receivedAt)) errors.push('receivedAt must be an ISO timestamp');
  if (!nonEmpty(response?.sender) && !nonEmpty(response?.source)) errors.push('sender or source is required');
  if (!nonEmpty(response?.ticketReference)) errors.push('ticketReference is required');
  if (nonEmpty(response?.originalResponse) && response.responseSha256 !== sha256(response.originalResponse)) errors.push('responseSha256 does not match sha256(originalResponse)');
  for (const [index, attachment] of (response?.attachments ?? []).entries()) {
    if (!nonEmpty(attachment?.name) || !/^[0-9a-f]{64}$/.test(attachment?.sha256 ?? '')) { errors.push(`attachment ${index}: name and sha256 are required`); continue; }
    if (attachment.path) {
      let actual = null;
      try { actual = sha256(read(path.join(root, attachment.path))); } catch { actual = null; }
      if (actual !== attachment.sha256) errors.push(`attachment ${index}: sha256 does not match ${attachment.path}`);
    }
  }
  for (const [index, annotation] of (response?.reviewerAnnotations ?? []).entries()) {
    if (!nonEmpty(annotation?.annotatedBy) || AUTOMATED_ACTORS.test(annotation.annotatedBy)) errors.push(`reviewerAnnotations ${index}: annotatedBy (human) is required`);
    if (!CLAIM_STATUSES.includes(annotation?.answerStatus)) errors.push(`reviewerAnnotations ${index}: invalid answerStatus`);
    if (!nonEmpty(annotation?.quote) || !response.originalResponse?.includes(annotation.quote)) errors.push(`reviewerAnnotations ${index}: quote must be verbatim text from originalResponse`);
  }
  return { status: errors.length ? 'INVALID' : 'RECEIVED', errors };
}

export const CLAIM_STATUSES = Object.freeze(['CONFIRMED_BY_VENDOR', 'SUPPORTED_BY_VENDOR', 'CONTRADICTED_BY_VENDOR', 'NOT_ANSWERED', 'AMBIGUOUS']);

const QUESTION_KEYWORDS = Object.freeze({
  Q1: /\b(?:equal|symmetric|same (?:count|number|value)|contract|expected to (?:match|be equal))\b/i,
  Q2: /\btop[- ]level\b|\bheroId\b(?![12])/i,
  Q3: /\bheroId[12]\b/i,
  Q4: /\b(?:differ|difference|asymmetr|reverse|direction)/i,
  Q5: /\bbracket|\bper[- ]player\b|\bplayer[- ]level\b|\brank(?:s|ed)? of (?:each|both)/i,
  Q6: /\beligib|\bincluded matches\b|\bcounted (?:only|if|when)\b|\bmatches (?:are|were) (?:counted|included|excluded)/i,
  Q7: /\blobby|\bgame ?mode/i,
  Q8: /\bunknown (?:rank|mmr)|\buncalibrated|\bunranked/i,
  Q9: /\bweek\b|\btimestamp|\bstart ?time|\bend ?time/i,
  Q10: /\bmatch[- ]?ids?\b.*\b(?:not|unavailable|aggregate)|\b(?:not|no) (?:expose|provide|return)\w* match/i,
  Q11: /\b(?:official )?(?:way|endpoint|query|api) (?:to|for) (?:get|obtain|retrieve|list)\w*.*match/i,
});

/**
 * Checks of vendor statements against historical evidence. They never decide
 * the vendor answer status; they describe what our evidence can and cannot test.
 */
const CLAIM_CHECKS = Object.freeze([
  {
    id: 'SYMMETRY_CLAIM',
    pattern: /\b(?:should|must|will|always)\s+(?:be\s+)?(?:equal|identical|symmetric)\b|\bare\s+(?:always\s+)?(?:equal|identical|symmetric)\b/i,
    verify: (facts) => ({
      conditionsDescribed: 'Reverse-direction matchCount values are equal.',
      historicalObservations: [`${facts.perBucket.equal}/${facts.perBucket.total} studied pair-weeks have equal reverse counts (FIX13).`],
      contradictingEvidence: [{ source: 'fix13Evidence', observation: `${facts.perBucket.total - facts.perBucket.equal}/${facts.perBucket.total} pair-weeks unequal` }],
      supportingEvidence: [],
      additionalDataRequired: 'None to test the statement as worded; an explanation would still be needed.',
      verifiableWithoutNewMatchLevelData: 'YES',
    }),
  },
  {
    id: 'BRACKET_CONDITION_CLAIM',
    pattern: /\bper[- ]player\b|\bplayer[- ]level\b|\bbracket(?:s|BasicIds)?\b.*\b(?:player|match|average)\b/i,
    verify: (facts) => ({
      conditionsDescribed: 'Bracket conditions applied to players/matches (as stated in the claim).',
      historicalObservations: [`Production bracket groups are additive in ${facts.partition.matching}/${facts.partition.total} pair-weeks (FIX13); asymmetry appears within single bracket groups.`],
      contradictingEvidence: [],
      supportingEvidence: [],
      additionalDataRequired: 'Per-player ranks of the underlying matches (match-level data) to confirm which matches are counted per direction.',
      verifiableWithoutNewMatchLevelData: 'PARTIAL',
    }),
  },
  {
    id: 'SUBSET_OR_SAMPLING_CLAIM',
    pattern: /\bsubset\b|\bsampl|\bonly (?:parsed|processed|some)\b|\bnot all matches\b/i,
    verify: (facts) => ({
      conditionsDescribed: 'The aggregate is based on a subset of matches.',
      historicalObservations: [`OpenDota reference ratio ${facts.openDota.min.toFixed(2)}–${facts.openDota.max.toFixed(2)} (FIX15; not a coverage estimate, FIX16 coverage ${facts.openDota.coverageStatus}).`],
      contradictingEvidence: [],
      supportingEvidence: [],
      additionalDataRequired: 'The vendor eligibility rules and the match IDs behind matchUp rows.',
      verifiableWithoutNewMatchLevelData: 'NO',
    }),
  },
  {
    id: 'WEEK_SEMANTICS_CLAIM',
    pattern: /\bweek\b/i,
    verify: () => ({
      conditionsDescribed: 'Definition of the week bucket.',
      historicalObservations: ['Asymmetry appears in each bucket; bucket boundaries cannot be tested without match timestamps.'],
      contradictingEvidence: [],
      supportingEvidence: [],
      additionalDataRequired: 'Match timestamps of the counted matches.',
      verifiableWithoutNewMatchLevelData: 'NO',
    }),
  },
  {
    id: 'NO_MATCH_IDS_CLAIM',
    pattern: /\bmatch[- ]?ids?\b/i,
    verify: (facts) => ({
      conditionsDescribed: 'Availability of match IDs for matchUp rows.',
      historicalObservations: [`Schema introspection found no population endpoint returning match IDs (FIX14, ${facts.noMatchIds.typeCount} types).`],
      contradictingEvidence: [],
      supportingEvidence: [{ source: 'fix14Evidence', observation: facts.noMatchIds.status }],
      additionalDataRequired: 'If an endpoint is named: run it and reconcile the A→B and B→A match sets.',
      verifiableWithoutNewMatchLevelData: 'YES',
    }),
  },
]);

/** Split the vendor text into claims (sentences/bullets). Quotes are verbatim and capped. */
export function splitClaims(text, { maxQuote = 600 } = {}) {
  return text.replace(/\r\n/g, '\n').split(/\n\s*\n|\n(?=\s*(?:[-*•]|\d+[.)])\s)|(?<=[.!?])\s+(?=[A-Z])/)
    .map((part) => part.trim()).filter((part) => part.length > 0)
    .map((part, index) => ({ claimId: `C${String(index + 1).padStart(2, '0')}`, originalText: part.length > maxQuote ? `${part.slice(0, maxQuote)}…` : part, truncated: part.length > maxQuote }));
}

/** Analyse a validated response. Vendor text and our checks are kept in separate fields. */
export function analyzeResponse(response, facts) {
  const validation = validateResponse(response);
  if (validation.status === 'NOT_RECEIVED') return { status: 'NOT_RECEIVED', claims: [], questions: QUESTIONS.map((q) => ({ questionId: q.id, answerStatus: 'NOT_ANSWERED', claimIds: [] })) };
  if (validation.status !== 'RECEIVED') return { status: 'INVALID', errors: validation.errors, claims: [], questions: [] };
  const annotations = response.reviewerAnnotations ?? [];
  const claims = splitClaims(response.originalResponse).map((claim) => {
    const related = Object.entries(QUESTION_KEYWORDS).filter(([, re]) => re.test(claim.originalText)).map(([id]) => id);
    const annotation = annotations.find((item) => claim.originalText.includes(item.quote) || item.quote.includes(claim.originalText.replace(/…$/, '')));
    const checks = CLAIM_CHECKS.filter((check) => check.pattern.test(claim.originalText)).map((check) => ({ checkId: check.id, ...check.verify(facts) }));
    const questionId = annotation?.questionId ?? related[0] ?? null;
    return {
      ...claim,
      questionId,
      relatedQuestionIds: related,
      answerStatus: annotation?.answerStatus ?? 'AMBIGUOUS',
      statusSource: annotation ? `reviewer annotation by ${annotation.annotatedBy}` : 'automatic (unreviewed claims stay AMBIGUOUS)',
      supportingEvidence: checks.flatMap((check) => check.supportingEvidence),
      contradictingEvidence: checks.flatMap((check) => check.contradictingEvidence),
      historicalChecks: checks,
      sourceReference: { ticketReference: response.ticketReference, responseSha256: response.responseSha256, claimId: claim.claimId },
      confidence: annotation?.confidence ?? 'LOW',
      remainingQuestions: [],
    };
  });
  const rank = (status) => ['CONFIRMED_BY_VENDOR', 'CONTRADICTED_BY_VENDOR', 'SUPPORTED_BY_VENDOR', 'AMBIGUOUS', 'NOT_ANSWERED'].indexOf(status);
  const questions = QUESTIONS.map((q) => {
    const linked = claims.filter((claim) => claim.questionId === q.id || claim.relatedQuestionIds.includes(q.id));
    const best = linked.map((claim) => claim.answerStatus).sort((a, b) => rank(a) - rank(b))[0] ?? 'NOT_ANSWERED';
    return { questionId: q.id, answerStatus: best, claimIds: linked.map((claim) => claim.claimId) };
  });
  const open = questions.filter((q) => !['CONFIRMED_BY_VENDOR', 'SUPPORTED_BY_VENDOR', 'CONTRADICTED_BY_VENDOR'].includes(q.answerStatus)).map((q) => q.questionId);
  for (const claim of claims) {
    claim.remainingQuestions = [...open.filter((id) => claim.relatedQuestionIds.includes(id) || claim.questionId === id), ...claim.historicalChecks.filter((check) => check.verifiableWithoutNewMatchLevelData !== 'YES').map((check) => `${check.checkId}: ${check.additionalDataRequired}`)];
  }
  return { status: 'RECEIVED', ticketReference: response.ticketReference, responseSha256: response.responseSha256, claims, questions, unansweredQuestions: open };
}

export const ROOT_CAUSE_STATUSES = Object.freeze(['STRATZ_FIELD_SEMANTICS_CONFIRMED', 'STRATZ_VENDOR_ISSUE_CONFIRMED', 'AGGREGATION_INTERPRETATION_CONFIRMED', 'PARTIALLY_EXPLAINED', 'UNRESOLVED']);

/**
 * A response alone never resolves the root cause. A resolved status requires a
 * human resolution record that cites vendor claims CONFIRMED_BY_VENDOR for Q4
 * and a reproduction on historical evidence.
 */
export function resolveRootCause(analysis, resolution = null) {
  const base = { productionPublishAllowed: false, matchLevelReconciliation: 'NOT_PERFORMED' };
  if (analysis.status !== 'RECEIVED') return { ...base, status: 'UNRESOLVED', reason: analysis.status === 'NOT_RECEIVED' ? 'No vendor response received.' : 'Vendor response input is invalid.' };
  const confirmed = analysis.claims.filter((claim) => claim.answerStatus === 'CONFIRMED_BY_VENDOR');
  const explainsDifference = confirmed.some((claim) => claim.questionId === 'Q4' || claim.relatedQuestionIds.includes('Q4'));
  if (resolution && ROOT_CAUSE_STATUSES.includes(resolution.status) && resolution.status !== 'UNRESOLVED' && resolution.status !== 'PARTIALLY_EXPLAINED') {
    const cited = (resolution.vendorClaimIds ?? []).every((id) => confirmed.some((claim) => claim.claimId === id)) && (resolution.vendorClaimIds ?? []).length > 0;
    const reproduced = resolution.reproducedOnHistoricalEvidence === true && Array.isArray(resolution.evidence) && resolution.evidence.length > 0;
    const human = nonEmpty(resolution.decidedBy) && !AUTOMATED_ACTORS.test(resolution.decidedBy);
    if (cited && reproduced && human && explainsDifference) return { ...base, status: resolution.status, reason: 'Human resolution with confirmed vendor claims and historical reproduction.', resolution };
  }
  const answered = analysis.questions.some((q) => ['CONFIRMED_BY_VENDOR', 'SUPPORTED_BY_VENDOR'].includes(q.answerStatus));
  return { ...base, status: answered ? 'PARTIALLY_EXPLAINED' : 'UNRESOLVED', reason: answered ? 'Some questions answered; no verified resolution.' : 'No question answered with vendor confirmation.' };
}

// ---------------------------------------------------------------------------
// Build / check.
// ---------------------------------------------------------------------------

const readJson = (relative, read, root = ROOT) => JSON.parse(read(path.join(root, relative), 'utf8'));

export function loadData(read = readFileSync, root = ROOT) {
  const j = (relative) => readJson(relative, read, root);
  const fix13 = j(`${DQ}/stratz-reverse-pair-partition-semantics-evidence.json`);
  return {
    fix9: j('scripts/stratz-diagnostic-input.json'),
    fix10: j(`${DQ}/stratz-reverse-pair-repeatability-evidence.json`),
    fix10Report: j(`${DQ}/stratz-reverse-pair-asymmetry-report.json`),
    fix11: j(`${DQ}/stratz-reverse-pair-root-cause-evidence.json`),
    fix11Raw: j(`${DQ}/stratz-reverse-pair-root-cause-raw-responses.json`),
    fix12: j(`${DQ}/stratz-reverse-pair-bracket-semantics-evidence.json`),
    fix12Raw: j(`${DQ}/stratz-reverse-pair-bracket-raw-responses.json`),
    fix13,
    fix14: j(`${DQ}/stratz-reverse-pair-match-level-evidence.json`),
    fix15: j(`${DQ}/stratz-external-match-level-evidence.json`),
    fix16: j(`${DQ}/stratz-opendota-coverage-validation-evidence.json`),
    buckets: fix13.buckets,
  };
}

/** Pure build: returns the generated artifacts and the validation results. */
export function buildFix17({ read = readFileSync, root = ROOT, statusRecord, response, resolution = null } = {}) {
  const manifestBefore = buildSourceManifest(read, root);
  const references = verifyRecordedReferences(read, root);
  const data = loadData(read, root);
  const truths = EXAMPLE_PAIRS.map((pair) => establishPairTruth(pair, data));
  const facts = collectFacts(data);
  const attachments = buildAttachments({ truths, facts, buckets: data.buckets });
  const markdown = renderFinalMarkdown({ truths, facts, attachments, buckets: data.buckets });
  const content = validateContent(markdown, { truths, facts, buckets: data.buckets });

  const status = statusRecord ?? initialStatusRecord();
  const intake = response ?? responseTemplate();
  const statusValidation = validateStatusRecord(status);
  const responseValidation = validateResponse(intake, { read, root });
  const analysis = analyzeResponse(intake, facts);
  const rootCause = resolveRootCause(analysis, resolution);

  const manifest = {
    schemaVersion: 1,
    kind: 'STRATZ_SUPPORT_ESCALATION_MANIFEST',
    escalation: { path: FIX17_PATHS.finalMd, sha256: sha256(markdown) },
    hashPolicy: 'All hashes are computed from the files at build time; canonicalSha256 is the self-hash recomputation (recursive key sort without the self-hash field) where the file defines one.',
    sources: manifestBefore.sources,
    production: manifestBefore.production,
    recordedReferenceChecks: references,
    attachments: attachments.map((item) => ({ id: item.id, title: item.title, sources: item.sources, contentSha256: item.contentSha256, content: item.content })),
    evidenceSha256: '',
  };
  manifest.evidenceSha256 = canonicalJsonSha256(manifest, 'evidenceSha256');

  const knownSecrets = loadKnownSecrets(read, root);
  const findings = [
    ...securityFindings(markdown, { knownSecrets, label: FIX17_PATHS.finalMd }),
    ...securityFindings(JSON.stringify(manifest), { knownSecrets, label: FIX17_PATHS.manifest }),
    ...securityFindings(JSON.stringify(status), { knownSecrets, strict: false, label: FIX17_PATHS.status }),
    ...securityFindings(JSON.stringify({ ...intake, originalResponse: '' }), { knownSecrets, strict: false, label: FIX17_PATHS.response }),
    ...SOURCES.map((source) => securityFindings(read(path.join(root, source.path), 'utf8'), { knownSecrets, strict: !/raw|diagnostic-input/.test(source.path), label: source.path })).flat(),
  ];
  const hashMismatches = references.filter((item) => item.status === 'MISMATCH');
  const canonicalMismatches = [...manifest.sources, ...manifest.production].filter((entry) => entry.canonicalStatus === 'MISMATCH');

  const evidence = {
    schemaVersion: 1,
    escalationStatus: status.status,
    submission: { sent: Boolean(status.submission?.sent), ticketReference: status.submission?.ticketReference ?? null, submissionChannel: status.submission?.submissionChannel ?? null },
    readyForSubmissionEligible: content.status === 'PASS' && !findings.length && !hashMismatches.length && !canonicalMismatches.length,
    statusValidation,
    sourceManifest: { path: FIX17_PATHS.manifest, evidenceSha256: manifest.evidenceSha256, entries: [...manifest.sources, ...manifest.production].map((entry) => ({ path: entry.path, physicalSha256: entry.physicalSha256, canonicalSha256: entry.canonicalSha256, canonicalStatus: entry.canonicalStatus })) },
    hashValidation: { status: hashMismatches.length || canonicalMismatches.length ? 'FAIL' : 'PASS', recordedReferenceChecks: references.length, mismatches: hashMismatches, canonicalMismatches: canonicalMismatches.map((entry) => entry.path), productionChangedAfterFix16: references.filter((item) => item.status === 'RETIRED_BY_TZ77' || item.status === 'CHANGED_BY_TZ77').map((item) => ({ path: item.path, status: item.status, fix16Recorded: item.expected, current: item.actual })) },
    numericalGroundTruth: truths.map((t) => ({ canonicalPairId: t.pair.canonicalPairId, orientation: `A=${t.pair.heroA.id} (${t.pair.heroA.name}), B=${t.pair.heroB.id} (${t.pair.heroB.name})`, perBucket: t.perBucket, total: t.total, brackets: [...BRACKETS], observationSources: t.observationSources, disagreements: t.disagreements })),
    contentValidation: content,
    openDotaComparison: { classification: 'REFERENCE_RATIO_NOT_COVERAGE_ESTIMATE', ratioMin: facts.openDota.min, ratioMax: facts.openDota.max, externalCoverage: facts.openDota.coverageStatus, statement: OPENDOTA_SENTENCE(facts.openDota.min, facts.openDota.max) },
    securityValidation: { status: findings.length ? 'FINDINGS' : 'CLEAN', findings, scanned: [FIX17_PATHS.finalMd, FIX17_PATHS.manifest, FIX17_PATHS.status, FIX17_PATHS.response, ...SOURCES.map((source) => source.path)], knownSecretValuesCompared: knownSecrets.length > 0, policy: 'Generated files: credentials, IP headers, IP addresses, e-mail addresses, .env assignments. Raw archives: credentials and IP headers. Secret values are compared, never stored.' },
    vendorResponse: { status: analysis.status, inputValidation: responseValidation, ticketReference: analysis.ticketReference ?? null, responseSha256: analysis.responseSha256 ?? null, claims: analysis.claims, questions: analysis.questions, unansweredQuestions: analysis.unansweredQuestions ?? QUESTIONS.map((q) => q.id) },
    rootCause,
    evidenceSha256: '',
  };
  evidence.evidenceSha256 = canonicalJsonSha256(evidence, 'evidenceSha256');

  const manifestAfter = buildSourceManifest(read, root);
  const drift = compareManifests(manifestBefore, manifestAfter);
  if (drift.length) throw new Error(`Sources changed during build: ${drift.map((item) => item.path).join(', ')}`);
  return {
    outputs: {
      [FIX17_PATHS.finalMd]: markdown,
      [FIX17_PATHS.manifest]: `${JSON.stringify(manifest, null, 2)}\n`,
      [FIX17_PATHS.evidence]: `${JSON.stringify(evidence, null, 2)}\n`,
    },
    evidence,
    manifest,
    markdown,
    truths,
    facts,
  };
}

function loadInputs(read = readFileSync, root = ROOT) {
  const load = (relative, fallback) => (existsSync(path.join(root, relative)) ? readJson(relative, read, root) : fallback());
  return { statusRecord: load(FIX17_PATHS.status, initialStatusRecord), response: load(FIX17_PATHS.response, responseTemplate) };
}

/**
 * Full offline check of the saved FIX17 artifacts. Returns a report; `ok` is
 * false on any failure.
 */
export function runCheck({ read = readFileSync, root = ROOT } = {}) {
  const inputs = loadInputs(read, root);
  const build = buildFix17({ read, root, ...inputs });
  const failures = [];
  const saved = (relative) => (existsSync(path.join(root, relative)) ? read(path.join(root, relative), 'utf8') : null);
  for (const [relative, content] of Object.entries(build.outputs)) if (saved(relative) !== content) failures.push(`${relative} does not reproduce`);
  const savedManifest = saved(FIX17_PATHS.manifest) ? JSON.parse(saved(FIX17_PATHS.manifest)) : null;
  const manifestDrift = savedManifest ? compareManifests(savedManifest, build.manifest) : [{ path: FIX17_PATHS.manifest, field: 'missing' }];
  if (manifestDrift.length) failures.push(`source hashes differ from manifest: ${manifestDrift.map((item) => `${item.path}:${item.field}`).join(', ')}`);
  if (savedManifest && canonicalJsonSha256(savedManifest, 'evidenceSha256') !== savedManifest.evidenceSha256) failures.push('manifest canonical hash mismatch');
  const savedEvidence = saved(FIX17_PATHS.evidence) ? JSON.parse(saved(FIX17_PATHS.evidence)) : null;
  if (savedEvidence && canonicalJsonSha256(savedEvidence, 'evidenceSha256') !== savedEvidence.evidenceSha256) failures.push('evidence canonical hash mismatch');
  const e = build.evidence;
  if (e.contentValidation.status !== 'PASS') failures.push('content validation failed');
  if (e.securityValidation.status !== 'CLEAN') failures.push('security scan has findings');
  if (e.hashValidation.status !== 'PASS') failures.push('recorded hash references mismatch');
  if (e.statusValidation.status !== 'VALID') failures.push(`status record invalid: ${e.statusValidation.errors.join('; ')}`);
  if (e.vendorResponse.inputValidation.status === 'INVALID') failures.push(`vendor response invalid: ${e.vendorResponse.inputValidation.errors.join('; ')}`);
  if (e.rootCause.productionPublishAllowed !== false) failures.push('productionPublishAllowed must be false');
  return { ok: failures.length === 0, failures, evidenceSha256: e.evidenceSha256, manifestSha256: build.manifest.evidenceSha256, escalationStatus: e.escalationStatus, contentValidation: { status: e.contentValidation.status, checkedClaims: e.contentValidation.checkedClaims }, securityValidation: e.securityValidation.status, hashValidation: e.hashValidation.status, vendorResponse: e.vendorResponse.status, rootCause: e.rootCause.status };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function writeNew(relative, content) {
  const target = path.join(ROOT, relative);
  if (existsSync(target)) return 'KEPT';
  writeFileSync(target, content, { flag: 'wx' });
  return 'CREATED';
}

async function main([command, ...args] = process.argv.slice(2)) {
  if (command === 'validate') {
    const inputs = loadInputs();
    const build = buildFix17(inputs);
    const e = build.evidence;
    const report = { content: e.contentValidation.status, checkedClaims: e.contentValidation.checkedClaims, hashes: e.hashValidation.status, security: e.securityValidation.status, status: e.escalationStatus, statusRecord: e.statusValidation.status, response: e.vendorResponse.inputValidation.status, readyForSubmissionEligible: e.readyForSubmissionEligible };
    console.log(JSON.stringify(report, null, 2));
    if (e.contentValidation.status !== 'PASS' || e.hashValidation.status !== 'PASS' || e.securityValidation.status !== 'CLEAN' || e.statusValidation.status !== 'VALID' || e.vendorResponse.inputValidation.status === 'INVALID') process.exitCode = 1;
    return;
  }
  if (command === 'reconcile') {
    const created = {
      [FIX17_PATHS.status]: writeNew(FIX17_PATHS.status, `${JSON.stringify(initialStatusRecord(), null, 2)}\n`),
      [FIX17_PATHS.response]: writeNew(FIX17_PATHS.response, `${JSON.stringify(responseTemplate(), null, 2)}\n`),
    };
    const inputs = loadInputs();
    const resolutionPath = path.join(ROOT, `${DQ}/stratz-root-cause-resolution.json`);
    const resolution = existsSync(resolutionPath) ? JSON.parse(readFileSync(resolutionPath, 'utf8')) : null;
    const build = buildFix17({ ...inputs, resolution });
    if (build.evidence.contentValidation.status !== 'PASS') throw new Error(`Content validation failed: ${JSON.stringify(build.evidence.contentValidation.mismatches)}`);
    if (build.evidence.securityValidation.status !== 'CLEAN') throw new Error(`Security findings: ${JSON.stringify(build.evidence.securityValidation.findings)}`);
    for (const [relative, content] of Object.entries(build.outputs)) {
      const target = path.join(ROOT, relative);
      created[relative] = existsSync(target) && readFileSync(target, 'utf8') === content ? 'UNCHANGED' : 'WRITTEN';
      if (created[relative] === 'WRITTEN') writeFileSync(target, content);
    }
    console.log(JSON.stringify(created, null, 2));
    return;
  }
  if (command === 'check') {
    const report = runCheck();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === 'transition') {
    const [to, confirmationPath] = args;
    if (!to || !confirmationPath) throw new Error('Usage: transition <STATUS> <confirmation.json>');
    const inputs = loadInputs();
    const confirmation = JSON.parse(readFileSync(path.resolve(confirmationPath), 'utf8'));
    const build = buildFix17(inputs);
    const validation = { content: build.evidence.contentValidation.status, hashes: build.evidence.hashValidation.status, security: build.evidence.securityValidation.status };
    const payload = to === 'ANSWERED' ? { ...confirmation, response: inputs.response } : confirmation;
    const next = transitionEscalation(inputs.statusRecord, to, payload, { validation });
    writeFileSync(path.join(ROOT, FIX17_PATHS.status), `${JSON.stringify(next, null, 2)}\n`);
    console.log(JSON.stringify({ from: inputs.statusRecord.status, to: next.status }, null, 2));
    return;
  }
  throw new Error('Usage: node scripts/stratz-vendor-response-reconciliation.mjs <validate|reconcile|check|transition>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[STRATZ FIX17] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
