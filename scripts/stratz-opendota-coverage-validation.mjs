#!/usr/bin/env node
// TZ #76-FIX16: OpenDota coverage validation & STRATZ escalation finalization.
//
//   collect — network, OpenDota explorer only (read-only SELECTs). Re-measures the
//             FIX15 match_id ranges with per-range statistics that the FIX15 raw
//             archive does not contain (null / incomplete / zeroed hero arrays,
//             match_id → start_time ordering) and probes two ranges beyond each
//             window boundary. Writes a new supplemental raw archive once; the
//             FIX15 raw archive is never touched. STRATZ is not contacted.
//   build   — offline and deterministic. Produces the coverage-validation
//             evidence and the finalized (still DRAFTED) support escalation v2.
//   check   — verifies the frozen FIX16 artifacts by SHA-256 (ТЗ №77 changed the
//             protected production set, so a rebuild no longer reproduces the
//             recorded protectedHashes byte-for-byte).
//
// Research only: nothing here is wired into production update-data-stratz.mjs.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUCKET_SEC } from './update-data-stratz.mjs';
import { canonicalJsonSha256 } from './stratz-matchup-root-cause-research.mjs';
import {
  EXPECTED_PHYSICAL_SHA256,
  FIX15_FROZEN_ARTIFACT_SHA256,
  MATCH_FIELDS,
  OUTPUT_PATHS as FIX15_PATHS,
  buildEscalation,
  captureSourceHashes,
  classifyRootCause,
  median,
  renderEscalationMarkdown,
  scanForCredentials,
  verifySourceHashes,
} from './stratz-external-source-research.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DQ = 'research/data-quality';

export const FIX16_PATHS = Object.freeze({
  raw: `${DQ}/stratz-opendota-coverage-validation-raw-responses.json`,
  evidence: `${DQ}/stratz-opendota-coverage-validation-evidence.json`,
  escalationMd: `${DQ}/stratz-support-escalation-v2.md`,
  escalationJson: `${DQ}/stratz-support-escalation-v2.json`,
});

// public/data/items.json and item-stats.json were retired by ТЗ №77 (Counterpick
// only); they are no longer production files and are not protected here.
const EXTRA_PRODUCTION_PATHS = Object.freeze({
  productionPositions: 'public/data/positions.json',
});

/** Everything FIX16 must leave untouched: FIX9–FIX14 + production (FIX15 list), FIX15 artifacts, other production data. */
export const PROTECTED_SHA256 = Object.freeze({
  ...EXPECTED_PHYSICAL_SHA256,
  ...Object.fromEntries(Object.entries(FIX15_FROZEN_ARTIFACT_SHA256).map(([relative, hash]) => [`fix15:${path.basename(relative)}`, hash])),
  productionPositions: '4a0e6ba79e8b5ebe12fb3a56ba107742a5dd920a178a7d61afe11af2387853da',
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/**
 * FIX16 artifacts as published on 2026-11-13. They are historical and frozen:
 * after ТЗ №77 changed the protected production set (item files retired, the
 * generator re-pinned) the generator no longer reproduces the recorded
 * protectedHashes, so `check` verifies them by hash and `build` refuses to
 * overwrite them.
 */
export const FIX16_FROZEN_ARTIFACT_SHA256 = Object.freeze({
  [FIX16_PATHS.raw]: '3898599572177131decbb6b2cf8e184d7313eb7ac02fa08987e5d6e79b02b22f',
  [FIX16_PATHS.evidence]: '808dd41362d0509e87037f65fd94ec5a0206e6f79d681a37d13c22ef19a19e98',
  [FIX16_PATHS.escalationMd]: '009f3b58cc23df5eecdf3f47ca7963e83c3f1b58e708c7c906e21f799936bd76',
  [FIX16_PATHS.escalationJson]: 'cc6f029f55d956b2ef505961619750d5520e0bc1bd68f233dd1b8b5b4ba71c39',
});

export function captureProtectedHashes(read = readFileSync, root = ROOT) {
  const fix15 = Object.fromEntries(Object.keys(FIX15_FROZEN_ARTIFACT_SHA256).map((relative) => [
    `fix15:${path.basename(relative)}`, { path: relative, physicalSha256: sha256(read(path.join(root, relative))) },
  ]));
  const extra = Object.fromEntries(Object.entries(EXTRA_PRODUCTION_PATHS).map(([name, relative]) => [
    name, { path: relative, physicalSha256: sha256(read(path.join(root, relative))) },
  ]));
  return { ...captureSourceHashes(read, root), ...fix15, ...extra };
}

export function verifyProtectedHashes(hashes, expected = PROTECTED_SHA256) {
  return verifySourceHashes(hashes, expected);
}

// ---------------------------------------------------------------------------
// 1. match_id range continuity
// ---------------------------------------------------------------------------

/**
 * Check that half-open [fromId, toId) ranges tile [expected.fromId, expected.toId)
 * exactly: no gaps, no overlaps, no empty/inverted ranges.
 */
export function checkRangeContinuity(ranges, expected = {}) {
  const inputOrdered = ranges.every((range, index) => index === 0 || ranges[index - 1].fromId <= range.fromId);
  const sorted = [...ranges].sort((a, b) => a.fromId - b.fromId || a.toId - b.toId);
  const invalidRanges = sorted.filter((range) => !(Number.isSafeInteger(range.fromId) && Number.isSafeInteger(range.toId) && range.toId > range.fromId))
    .map((range) => [range.fromId, range.toId]);
  const gaps = [];
  const overlaps = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const prev = sorted[index - 1];
    const next = sorted[index];
    if (next.fromId > prev.toId) gaps.push({ fromId: prev.toId, toId: next.fromId, ids: next.fromId - prev.toId });
    if (next.fromId < prev.toId) overlaps.push({ fromId: next.fromId, toId: Math.min(prev.toId, next.toId), ids: Math.min(prev.toId, next.toId) - next.fromId });
  }
  const first = sorted[0];
  const last = sorted.at(-1);
  if (first && Number.isSafeInteger(expected.fromId) && first.fromId > expected.fromId) {
    gaps.unshift({ fromId: expected.fromId, toId: first.fromId, ids: first.fromId - expected.fromId, edge: 'LEADING' });
  }
  if (last && Number.isSafeInteger(expected.toId) && last.toId < expected.toId) {
    gaps.push({ fromId: last.toId, toId: expected.toId, ids: expected.toId - last.toId, edge: 'TRAILING' });
  }
  const outsideExpected = sorted.filter((range) => (Number.isSafeInteger(expected.fromId) && range.fromId < expected.fromId)
    || (Number.isSafeInteger(expected.toId) && range.toId > expected.toId)).map((range) => [range.fromId, range.toId]);
  const ok = sorted.length > 0 && !gaps.length && !overlaps.length && !invalidRanges.length && !outsideExpected.length;
  return {
    status: ok ? 'CONTIGUOUS' : 'NOT_CONTIGUOUS',
    rangeCount: sorted.length,
    inputOrdered,
    firstFromId: first?.fromId ?? null,
    lastToId: last?.toId ?? null,
    expected: { fromId: expected.fromId ?? null, toId: expected.toId ?? null },
    idSpan: first && last ? last.toId - first.fromId : 0,
    summedRangeIds: sorted.reduce((sum, range) => sum + Math.max(0, range.toId - range.fromId), 0),
    gaps,
    overlaps,
    invalidRanges,
    outsideExpected,
  };
}

// ---------------------------------------------------------------------------
// 2. match_id → start_time ordering
// ---------------------------------------------------------------------------

/**
 * Ordering of start_time along increasing match_id. A "drop below running max"
 * is how far a match started before some match with a smaller ID; its maximum
 * bounds how far a boundary located by binary search over match_id can be off.
 */
export function analyzeTimeOrder(records, { largeJumpSec = 3600, listLimit = 20 } = {}) {
  const sorted = [...records].sort((a, b) => Number(a.match_id) - Number(b.match_id));
  let backwardSteps = 0;
  let equalSteps = 0;
  let forwardSteps = 0;
  let maxBackwardStepSec = 0;
  let maxForwardStepSec = 0;
  let maxDropBelowRunningMaxSec = 0;
  let recordsBelowRunningMax = 0;
  let duplicateMatchIds = 0;
  const largeJumps = [];
  let largeJumpCount = 0;
  let runningMax = -Infinity;
  for (let index = 0; index < sorted.length; index += 1) {
    const { match_id: id, start_time: t } = sorted[index];
    if (index > 0) {
      const prev = sorted[index - 1];
      if (Number(prev.match_id) === Number(id)) duplicateMatchIds += 1;
      const step = t - prev.start_time;
      if (step < 0) { backwardSteps += 1; maxBackwardStepSec = Math.max(maxBackwardStepSec, -step); }
      else if (step === 0) equalSteps += 1;
      else { forwardSteps += 1; maxForwardStepSec = Math.max(maxForwardStepSec, step); }
      if (Math.abs(step) >= largeJumpSec) {
        largeJumpCount += 1;
        if (largeJumps.length < listLimit) largeJumps.push({ fromMatchId: prev.match_id, toMatchId: id, stepSec: step });
      }
      if (t < runningMax) { recordsBelowRunningMax += 1; maxDropBelowRunningMaxSec = Math.max(maxDropBelowRunningMaxSec, runningMax - t); }
    }
    runningMax = Math.max(runningMax, t);
  }
  const status = sorted.length < 2 ? 'INSUFFICIENT_DATA'
    : backwardSteps === 0 ? (equalSteps === 0 ? 'STRICTLY_INCREASING' : 'NON_DECREASING')
      : 'NOT_MONOTONIC';
  return {
    status,
    records: sorted.length,
    steps: Math.max(0, sorted.length - 1),
    backwardSteps,
    equalSteps,
    forwardSteps,
    duplicateMatchIds,
    maxBackwardStepSec,
    maxForwardStepSec,
    recordsBelowRunningMax,
    maxDropBelowRunningMaxSec,
    largeJumpThresholdSec: largeJumpSec,
    largeJumpCount,
    largeJumps,
  };
}

/** Ordering across consecutive ranges, from each range's min/max start_time. */
export function analyzeRangeTimeOrder(ranges) {
  const sorted = [...ranges].filter((range) => Number.isFinite(range.minStart) && Number.isFinite(range.maxStart))
    .sort((a, b) => a.fromId - b.fromId);
  let adjacentOverlaps = 0;
  let maxAdjacentOverlapSec = 0;
  let maxCrossRangeDropSec = 0;
  let minStartDecreases = 0;
  let runningMax = -Infinity;
  for (let index = 0; index < sorted.length; index += 1) {
    const range = sorted[index];
    if (index > 0) {
      const prev = sorted[index - 1];
      const overlap = prev.maxStart - range.minStart;
      if (overlap > 0) { adjacentOverlaps += 1; maxAdjacentOverlapSec = Math.max(maxAdjacentOverlapSec, overlap); }
      if (range.minStart < prev.minStart) minStartDecreases += 1;
      maxCrossRangeDropSec = Math.max(maxCrossRangeDropSec, runningMax - range.minStart);
    }
    runningMax = Math.max(runningMax, range.maxStart);
  }
  return { ranges: sorted.length, adjacentOverlaps, maxAdjacentOverlapSec, minStartDecreases, maxCrossRangeDropSec };
}

/**
 * Exact maximum drop of start_time below the running maximum over the whole
 * ordered sequence of measured ranges (main FIX15 ranges, timeout sub-ranges
 * and boundary extensions), reported per group.
 *
 * For a row in range i the earlier rows are (a) earlier rows of range i —
 * covered by the in-range SQL statistic — and (b) all rows of earlier ranges,
 * whose maximum is the running max of their maxStart. Hence
 *   globalMaxDrop = max_i max(withinDrop_i, runningMaxBefore_i − minStart_i)
 * is exact, not an estimate. Single lag steps across a border are not
 * observable from range aggregates; their size is bounded by the border drop.
 *
 * ranges: [{ role: 'fix15-range'|'extension', side, fromId, toId, status, stats }]
 * fix15Bounds: FIX15 chunk [fromId, toId) pairs, to tell split borders apart.
 */
export function analyzeMonotonicityGroups(ranges, fix15Bounds = []) {
  const groupOf = (range) => (range.role === 'extension' ? `extension-${range.side}` : 'main');
  const sorted = [...ranges].sort((a, b) => a.fromId - b.fromId || a.toId - b.toId);
  const failed = sorted.filter((range) => range.status !== 'OK' || !range.stats);
  const ok = sorted.filter((range) => range.status === 'OK' && range.stats && Number.isFinite(range.stats.minStart));
  const fix15Starts = new Set(fix15Bounds.map(([from]) => from));
  const within = {};
  const borders = {};
  const addWithin = (name, range) => {
    const g = within[name] ??= { ranges: 0, rows: 0, backwardSteps: 0, equalSteps: 0, forwardSteps: 0, largeJumps: 0, maxBackwardStepSec: 0, maxDropBelowRunningMaxSec: 0, worstRange: null };
    const o = range.stats.order;
    g.ranges += 1;
    g.rows += range.stats.rows;
    g.backwardSteps += o.backwardSteps ?? 0;
    g.equalSteps += o.equalSteps ?? 0;
    g.forwardSteps += o.forwardSteps ?? 0;
    g.largeJumps += o.largeJumps ?? 0;
    g.maxBackwardStepSec = Math.max(g.maxBackwardStepSec, o.maxBackwardStepSec);
    if (!g.worstRange || o.maxDropBelowRunningMaxSec > g.maxDropBelowRunningMaxSec) {
      g.worstRange = [range.fromId, range.toId];
      g.maxDropBelowRunningMaxSec = o.maxDropBelowRunningMaxSec;
    }
  };
  let runningMax = -Infinity;
  let globalMaxDropSec = 0;
  let contiguousChain = true;
  for (let index = 0; index < ok.length; index += 1) {
    const range = ok[index];
    addWithin(groupOf(range), range);
    globalMaxDropSec = Math.max(globalMaxDropSec, range.stats.order.maxDropBelowRunningMaxSec);
    if (index > 0) {
      const prev = ok[index - 1];
      if (prev.toId !== range.fromId) contiguousChain = false;
      const kind = groupOf(prev) !== groupOf(range) ? `${groupOf(prev)}->${groupOf(range)}`
        : groupOf(range) === 'main' ? (fix15Starts.has(range.fromId) ? 'main-fix15-chunk-border' : 'main-split-subrange-border')
          : `${groupOf(range)}-internal-border`;
      const b = borders[kind] ??= { borders: 0, adjacentOverlaps: 0, maxAdjacentOverlapSec: 0, maxDropBelowRunningMaxSec: 0, worstBorderAtId: null };
      const overlap = prev.stats.maxStart - range.stats.minStart;
      const drop = Math.max(0, runningMax - range.stats.minStart);
      b.borders += 1;
      if (overlap > 0) { b.adjacentOverlaps += 1; b.maxAdjacentOverlapSec = Math.max(b.maxAdjacentOverlapSec, overlap); }
      if (b.worstBorderAtId === null || drop > b.maxDropBelowRunningMaxSec) {
        b.worstBorderAtId = range.fromId;
        b.maxDropBelowRunningMaxSec = drop;
      }
      globalMaxDropSec = Math.max(globalMaxDropSec, drop);
    }
    runningMax = Math.max(runningMax, range.stats.maxStart);
  }
  return {
    method: 'exact maximum drop below running max over all measured rows in match_id order (in-range SQL window statistic + running max across ranges)',
    measuredRanges: ok.length,
    failedOrUnmeasuredRanges: failed.map((range) => [range.fromId, range.toId]),
    contiguousChain: contiguousChain && failed.length === 0,
    withinRanges: within,
    acrossBorders: borders,
    globalMaxDropBelowRunningMaxSec: globalMaxDropSec,
    borderLagStepsObservable: false,
  };
}

// ---------------------------------------------------------------------------
// 3. hero arrays
// ---------------------------------------------------------------------------

export const HERO_ARRAY_CLASSES = Object.freeze(['NULL_ARRAY', 'INCOMPLETE_ARRAY', 'NULL_ELEMENT', 'ZEROED_HERO', 'COMPLETE']);

/**
 * Classify a match's team arrays. A missing/null array is NULL_ARRAY and is
 * never treated as zeroed. Precedence for the exclusive class follows the list
 * order; the flags are non-exclusive.
 */
export function classifyHeroArrays(match) {
  const teams = [match.radiant_team, match.dire_team];
  const nullArray = teams.some((team) => !Array.isArray(team));
  const present = teams.filter(Array.isArray);
  const incomplete = !nullArray && present.some((team) => team.length !== 5);
  const nullElement = present.some((team) => team.some((hero) => hero === null || hero === undefined));
  const zeroed = present.some((team) => team.some((hero) => hero === 0));
  const flags = { nullArray, incomplete, nullElement, zeroed };
  const primary = nullArray ? 'NULL_ARRAY' : incomplete ? 'INCOMPLETE_ARRAY' : nullElement ? 'NULL_ELEMENT' : zeroed ? 'ZEROED_HERO' : 'COMPLETE';
  return { primary, flags, classifiable: primary === 'COMPLETE' };
}

export function summarizeHeroArrays(matches) {
  const byClass = Object.fromEntries(HERO_ARRAY_CLASSES.map((name) => [name, 0]));
  const flags = { nullArray: 0, incomplete: 0, nullElement: 0, zeroed: 0 };
  for (const match of matches) {
    const result = classifyHeroArrays(match);
    byClass[result.primary] += 1;
    for (const [name, value] of Object.entries(result.flags)) if (value) flags[name] += 1;
  }
  return { records: matches.length, byClass, flags, unclassifiable: matches.length - byClass.COMPLETE };
}

// ---------------------------------------------------------------------------
// 4. SQL (read-only) and range statistics
// ---------------------------------------------------------------------------

const HERO_CLASS_SQL = `CASE WHEN radiant_team IS NULL OR dire_team IS NULL THEN 'NULL_ARRAY'
 WHEN cardinality(radiant_team) <> 5 OR cardinality(dire_team) <> 5 THEN 'INCOMPLETE_ARRAY'
 WHEN array_position(radiant_team, NULL) IS NOT NULL OR array_position(dire_team, NULL) IS NOT NULL THEN 'NULL_ELEMENT'
 WHEN 0 = ANY(radiant_team) OR 0 = ANY(dire_team) THEN 'ZEROED_HERO'
 ELSE 'COMPLETE' END`.replace(/\s+/g, ' ');

const CLASS_COLUMN = { NULL_ARRAY: 'null_array', INCOMPLETE_ARRAY: 'incomplete', NULL_ELEMENT: 'null_element', ZEROED_HERO: 'zeroed', COMPLETE: 'complete' };

/** One read-only SELECT per match_id range: counts, hero-array classes and ordering statistics. */
export function coverageStatsSql(fromId, toId, buckets, { largeJumpSec = 3600 } = {}) {
  const ws = buckets[0] * BUCKET_SEC;
  const we = (buckets.at(-1) + 1) * BUCKET_SEC;
  const iw = `start_time >= ${ws} AND start_time < ${we}`;
  const cols = [
    'count(*) AS rows', 'min(start_time) AS min_t', 'max(start_time) AS max_t',
    'min(match_id) AS min_id', 'max(match_id) AS max_id',
    `count(*) FILTER (WHERE start_time < ${ws}) AS before_window`,
    `count(*) FILTER (WHERE start_time >= ${we}) AS after_window`,
    `count(*) FILTER (WHERE ${iw}) AS iw`,
    `count(*) FILTER (WHERE ${iw} AND lobby_type = 7) AS iw_ranked`,
    `min(match_id) FILTER (WHERE ${iw}) AS iw_min_id`,
    `max(match_id) FILTER (WHERE ${iw}) AS iw_max_id`,
    ...Object.entries(CLASS_COLUMN).flatMap(([name, column]) => [
      `count(*) FILTER (WHERE cls = '${name}') AS all_${column}`,
      `count(*) FILTER (WHERE ${iw} AND cls = '${name}') AS iw_${column}`,
    ]),
    `count(*) FILTER (WHERE ${iw} AND (0 = ANY(radiant_team) OR 0 = ANY(dire_team))) AS iw_zero_flag`,
    ...buckets.flatMap((bucket) => {
      const t = `start_time >= ${bucket * BUCKET_SEC} AND start_time < ${(bucket + 1) * BUCKET_SEC}`;
      return [
        `count(*) FILTER (WHERE ${t}) AS b${bucket}_matches`,
        `count(*) FILTER (WHERE ${t} AND lobby_type = 7) AS b${bucket}_ranked`,
        `count(*) FILTER (WHERE ${t} AND (0 = ANY(radiant_team) OR 0 = ANY(dire_team))) AS b${bucket}_zero_hero`,
        `count(*) FILTER (WHERE ${t} AND cls <> 'COMPLETE') AS b${bucket}_unclassifiable`,
      ];
    }),
    'count(*) FILTER (WHERE start_time < pt) AS backward_steps',
    'count(*) FILTER (WHERE start_time = pt) AS equal_steps',
    'count(*) FILTER (WHERE start_time > pt) AS forward_steps',
    'max(pt - start_time) AS max_backward_step',
    'max(start_time - pt) AS max_forward_step',
    `count(*) FILTER (WHERE abs(start_time - pt) >= ${largeJumpSec}) AS large_jumps`,
    'count(*) FILTER (WHERE start_time < rmax) AS below_running_max',
    'max(rmax - start_time) AS max_drop_below_running_max',
  ];
  const inner = `SELECT match_id, start_time, lobby_type, radiant_team, dire_team, ${HERO_CLASS_SQL} AS cls, `
    + 'lag(start_time) OVER (ORDER BY match_id) AS pt, '
    + 'max(start_time) OVER (ORDER BY match_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS rmax '
    + `FROM public_matches WHERE match_id >= ${fromId} AND match_id < ${toId}`;
  return `SELECT ${cols.join(', ')} FROM (${inner}) s`;
}

const num = (value) => (value === null || value === undefined ? null : Number(value));

/** Parse one explorer result row of coverageStatsSql into a stable shape. */
export function parseStatsRow(row, buckets) {
  const heroArrays = (prefix) => Object.fromEntries(Object.entries(CLASS_COLUMN).map(([name, column]) => [name, num(row[`${prefix}_${column}`]) ?? 0]));
  return {
    rows: num(row.rows),
    minStart: num(row.min_t),
    maxStart: num(row.max_t),
    minMatchId: num(row.min_id),
    maxMatchId: num(row.max_id),
    beforeWindow: num(row.before_window),
    afterWindow: num(row.after_window),
    inWindow: num(row.iw),
    inWindowRanked: num(row.iw_ranked),
    inWindowMinMatchId: num(row.iw_min_id),
    inWindowMaxMatchId: num(row.iw_max_id),
    heroArraysAll: heroArrays('all'),
    heroArraysInWindow: heroArrays('iw'),
    inWindowZeroFlag: num(row.iw_zero_flag),
    buckets: Object.fromEntries(buckets.map((bucket) => [`b${bucket}`, {
      matches: num(row[`b${bucket}_matches`]),
      ranked: num(row[`b${bucket}_ranked`]),
      zeroHero: num(row[`b${bucket}_zero_hero`]),
      unclassifiable: num(row[`b${bucket}_unclassifiable`]),
    }])),
    order: {
      backwardSteps: num(row.backward_steps),
      equalSteps: num(row.equal_steps),
      forwardSteps: num(row.forward_steps),
      maxBackwardStepSec: Math.max(0, num(row.max_backward_step) ?? 0),
      maxForwardStepSec: Math.max(0, num(row.max_forward_step) ?? 0),
      largeJumps: num(row.large_jumps),
      belowRunningMax: num(row.below_running_max),
      maxDropBelowRunningMaxSec: Math.max(0, num(row.max_drop_below_running_max) ?? 0),
    },
  };
}

/** Merge statistics of sub-ranges (used when a range had to be split on timeout). */
export function mergeStats(list) {
  const sum = (get) => list.reduce((total, item) => total + (get(item) ?? 0), 0);
  const pick = (get, fn) => {
    const values = list.map(get).filter((value) => value !== null && value !== undefined);
    return values.length ? fn(...values) : null;
  };
  const first = list[0];
  const classes = (key) => Object.fromEntries(Object.keys(first[key]).map((name) => [name, sum((item) => item[key][name])]));
  return {
    rows: sum((item) => item.rows),
    minStart: pick((item) => item.minStart, Math.min),
    maxStart: pick((item) => item.maxStart, Math.max),
    minMatchId: pick((item) => item.minMatchId, Math.min),
    maxMatchId: pick((item) => item.maxMatchId, Math.max),
    beforeWindow: sum((item) => item.beforeWindow),
    afterWindow: sum((item) => item.afterWindow),
    inWindow: sum((item) => item.inWindow),
    inWindowRanked: sum((item) => item.inWindowRanked),
    inWindowMinMatchId: pick((item) => item.inWindowMinMatchId, Math.min),
    inWindowMaxMatchId: pick((item) => item.inWindowMaxMatchId, Math.max),
    heroArraysAll: classes('heroArraysAll'),
    heroArraysInWindow: classes('heroArraysInWindow'),
    inWindowZeroFlag: sum((item) => item.inWindowZeroFlag),
    buckets: Object.fromEntries(Object.keys(first.buckets).map((key) => [key, Object.fromEntries(Object.keys(first.buckets[key])
      .map((field) => [field, sum((item) => item.buckets[key][field])]))])),
    order: {
      backwardSteps: sum((item) => item.order.backwardSteps),
      equalSteps: sum((item) => item.order.equalSteps),
      forwardSteps: sum((item) => item.order.forwardSteps),
      maxBackwardStepSec: Math.max(...list.map((item) => item.order.maxBackwardStepSec)),
      maxForwardStepSec: Math.max(...list.map((item) => item.order.maxForwardStepSec)),
      largeJumps: sum((item) => item.order.largeJumps),
      belowRunningMax: sum((item) => item.order.belowRunningMax),
      maxDropBelowRunningMaxSec: Math.max(...list.map((item) => item.order.maxDropBelowRunningMaxSec)),
      note: list.length > 1 ? `Merged from ${list.length} sub-ranges; steps across sub-range borders are covered by the cross-range analysis.` : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// 5. totals consistency, boundaries, missed IDs, coverage status
// ---------------------------------------------------------------------------

/** Compare FIX15 per-range totals and records with the FIX16 re-measurement of the same ranges. */
export function checkTotalsConsistency(fix15Chunks, statsByRange, buckets) {
  const perRange = fix15Chunks.map((chunk) => {
    const stats = statsByRange.get(`${chunk.fromId}:${chunk.toId}`) ?? null;
    const records = chunk.rows.map((row) => ({ match_id: row[0], start_time: row[1] }));
    const recordsOutsideRange = records.filter((record) => record.match_id < chunk.fromId || record.match_id >= chunk.toId).length;
    const bucketDiffs = stats ? buckets.flatMap((bucket) => ['matches', 'ranked', 'zeroHero']
      .filter((field) => chunk.totals[`b${bucket}`][field] !== stats.buckets[`b${bucket}`][field])
      .map((field) => ({ bucket, field, fix15: chunk.totals[`b${bucket}`][field], fix16: stats.buckets[`b${bucket}`][field] }))) : [];
    return {
      fromId: chunk.fromId,
      toId: chunk.toId,
      fix15RangeRows: chunk.rangeRows,
      fix16RangeRows: stats?.rows ?? null,
      pairRecords: records.length,
      recordsOutsideRange,
      pairRecordsWithinRangeRows: chunk.rangeRows === null ? null : records.length <= chunk.rangeRows,
      fix15MinMaxWithinRange: records.every((record) => record.start_time >= chunk.rangeMinStart && record.start_time <= chunk.rangeMaxStart),
      bucketSumWithinRangeRows: buckets.reduce((sum, bucket) => sum + chunk.totals[`b${bucket}`].matches, 0) <= chunk.rangeRows,
      bucketDiffs,
      measured: Boolean(stats),
    };
  });
  const measured = perRange.filter((item) => item.measured);
  const rowDrift = measured.filter((item) => item.fix15RangeRows !== item.fix16RangeRows);
  const bucketDrift = measured.filter((item) => item.bucketDiffs.length);
  const internal = perRange.every((item) => item.recordsOutsideRange === 0 && item.pairRecordsWithinRangeRows && item.fix15MinMaxWithinRange && item.bucketSumWithinRangeRows);
  return {
    status: !internal ? 'INCONSISTENT' : measured.length !== perRange.length ? 'PARTIALLY_REMEASURED'
      : rowDrift.length || bucketDrift.length ? 'CONSISTENT_WITH_DRIFT' : 'CONSISTENT',
    ranges: perRange.length,
    remeasuredRanges: measured.length,
    fix15RangeRowsTotal: perRange.reduce((sum, item) => sum + (item.fix15RangeRows ?? 0), 0),
    fix16RangeRowsTotal: measured.reduce((sum, item) => sum + item.fix16RangeRows, 0),
    rangesWithRowDrift: rowDrift.map((item) => ({ fromId: item.fromId, toId: item.toId, fix15: item.fix15RangeRows, fix16: item.fix16RangeRows })),
    rangesWithBucketDrift: bucketDrift.map((item) => ({ fromId: item.fromId, toId: item.toId, diffs: item.bucketDiffs })),
    pairRecordsTotal: perRange.reduce((sum, item) => sum + item.pairRecords, 0),
    pairRecordsOutsideTheirRange: perRange.reduce((sum, item) => sum + item.recordsOutsideRange, 0),
    internalChecks: internal ? 'PASS' : 'FAIL',
  };
}

/**
 * Where the enumerated match_id range sits relative to the time window, and
 * whether the observed ordering noise is small compared to the margins.
 */
export function assessBoundaries({ windowStart, windowEnd, enumerated, extensions, maxObservedDropSec }) {
  const lowerMarginSec = windowStart - enumerated.firstStart;
  const upperMarginSec = enumerated.lastStart - windowEnd;
  const extensionSide = (side) => {
    const items = extensions.filter((item) => item.side === side);
    const measured = items.filter((item) => item.stats);
    return {
      ranges: items.map((item) => [item.fromId, item.toId]),
      measured: measured.length,
      failed: items.length - measured.length,
      rows: measured.reduce((sum, item) => sum + item.stats.rows, 0),
      inWindowRows: measured.reduce((sum, item) => sum + item.stats.inWindow, 0),
      minStart: measured.length ? Math.min(...measured.map((item) => item.stats.minStart).filter(Number.isFinite)) : null,
      maxStart: measured.length ? Math.max(...measured.map((item) => item.stats.maxStart).filter(Number.isFinite)) : null,
    };
  };
  const below = extensionSide('below');
  const above = extensionSide('above');
  const minMargin = Math.min(lowerMarginSec, upperMarginSec);
  return {
    window: { startSecInclusive: windowStart, endSecExclusive: windowEnd },
    enumerated,
    lowerMarginSec,
    upperMarginSec,
    lowerMarginDays: Number((lowerMarginSec / 86400).toFixed(4)),
    upperMarginDays: Number((upperMarginSec / 86400).toFixed(4)),
    firstInWindowMatchIdDistanceFromRangeStart: enumerated.firstInWindowMatchId === null ? null : enumerated.firstInWindowMatchId - enumerated.fromId,
    lastInWindowMatchIdDistanceFromRangeEnd: enumerated.lastInWindowMatchId === null ? null : enumerated.toId - 1 - enumerated.lastInWindowMatchId,
    maxObservedDropSec,
    marginToMaxObservedDrop: maxObservedDropSec > 0 ? Number((minMargin / maxObservedDropSec).toFixed(1)) : null,
    extensionBelow: below,
    extensionAbove: above,
    inWindowRowsFoundOutsideEnumeratedRange: below.inWindowRows + above.inWindowRows,
    status: lowerMarginSec > 0 && upperMarginSec > 0 && below.failed === 0 && above.failed === 0 && below.inWindowRows + above.inWindowRows === 0
      && maxObservedDropSec < minMargin ? 'BOUNDARIES_EMPIRICALLY_SUPPORTED' : 'BOUNDARIES_NOT_SUPPORTED',
    proof: 'NOT_A_PROOF',
    note: 'Observed ordering noise and empty extension probes support, but do not prove, that no in-window match has a match_id outside the enumerated range: the extensions cover a finite ID span and the table can still receive late rows.',
  };
}

/** Enumerate the known and unknown ways an in-window match could be absent from the FIX15 records. */
export function potentiallyMissedMatchIds({ continuity, failedRanges, boundaries, inWindowUnclassifiable, rowDrift }) {
  return {
    gapIds: continuity.gaps.reduce((sum, gap) => sum + gap.ids, 0),
    overlapIds: continuity.overlaps.reduce((sum, item) => sum + item.ids, 0),
    failedRangeIds: failedRanges.reduce((sum, [from, to]) => sum + (to - from), 0),
    inWindowRowsFoundInExtensions: boundaries.inWindowRowsFoundOutsideEnumeratedRange,
    beyondExtensions: 'UNQUANTIFIED',
    inWindowRowsWithUnclassifiableHeroArrays: inWindowUnclassifiable,
    rowCountDriftSinceFix15: rowDrift,
    notInPublicMatches: 'UNQUANTIFIED — completeness of public_matches relative to all matchmaking games is not documented by OpenDota',
  };
}

/**
 * Coverage status of the external source. Integrity checks can only keep the
 * status at PARTIAL or flag problems; this function never returns COMPLETE —
 * completeness of OpenDota public_matches is not documented and cannot be
 * established from the data alone.
 */
export function deriveCoverageStatus({ continuity, consistency, boundaries, heroArrays }) {
  const reasons = ['SOURCE_COMPLETENESS_UNDOCUMENTED', 'COVERAGE_RELATIVE_TO_STRATZ_UNVERIFIED'];
  if (continuity.status !== 'CONTIGUOUS') reasons.push('MATCH_ID_RANGE_GAPS_OR_OVERLAPS');
  if (consistency.status === 'INCONSISTENT') reasons.push('TOTALS_INCONSISTENT');
  if (consistency.status === 'CONSISTENT_WITH_DRIFT') reasons.push('SOURCE_ROWS_CHANGED_SINCE_FIX15');
  if (boundaries.status !== 'BOUNDARIES_EMPIRICALLY_SUPPORTED') reasons.push('BOUNDARIES_NOT_SUPPORTED');
  reasons.push('BOUNDARY_COMPLETENESS_NOT_PROVEN');
  if (heroArrays.unclassifiable > 0) reasons.push('UNCLASSIFIABLE_HERO_ARRAYS');
  return {
    status: 'PARTIAL',
    classification: 'PARTIAL_MATCH_COVERAGE',
    enumerationIntegrity: continuity.status === 'CONTIGUOUS' && consistency.internalChecks === 'PASS' ? 'PASS' : 'FAIL',
    reasons,
    completeRequires: 'Documented completeness of the source plus filters equivalent to STRATZ; not set automatically.',
  };
}

// ---------------------------------------------------------------------------
// 6. escalation v2
// ---------------------------------------------------------------------------

export function buildIndependentReference(fix15Evidence) {
  const example = fix15Evidence.reconciliation.find((row) => row.canonicalPairId === '58:61' && row.bucket === 2963);
  const ratios = fix15Evidence.reconciliation.flatMap((row) => [row.comparison?.stratzToExternalRatioAtoB, row.comparison?.stratzToExternalRatioBtoA]);
  const finite = ratios.filter(Number.isFinite);
  const window = fix15Evidence.bucketTotals.find((item) => item.bucket === 2963).window;
  return {
    provider: 'OpenDota explorer, table public_matches',
    referenceSubset: example.comparison.referenceSubset,
    referenceSubsetDefinition: 'lobby_type = 7 (ranked matchmaking) and per-match average rank (avg_rank_tier) in Herald–Immortal; A and B on opposing teams; the count has no direction',
    example: {
      canonicalPairId: example.canonicalPairId,
      heroA: { id: 58, name: 'Enchantress' },
      heroB: { id: 61, name: 'Broodmother' },
      bucket: example.bucket,
      window,
      stratzMatchCountAtoB: example.stratz.gamesAtoB,
      stratzMatchCountBtoA: example.stratz.gamesBtoA,
      externalMatches: example.comparison.externalMatches,
    },
    ratio: {
      pairWeeks: fix15Evidence.reconciliation.length,
      values: finite.length,
      min: Math.min(...finite),
      max: Math.max(...finite),
      median: median(finite),
      displayRange: `${Math.min(...finite).toFixed(2)}–${Math.max(...finite).toFixed(2)}`,
      stratzNotAboveExternalPairWeeks: fix15Evidence.reconciliationSummary.stratzWithinExternalReference,
    },
    caveats: [
      { id: 'partial-source-coverage', text: 'Partial source coverage: OpenDota does not document how complete public_matches is, and about 0.5% of in-window rows have incomplete or zeroed hero arrays (no null arrays were observed) and cannot be attributed to any pair.' },
      { id: 'match-average-rank', text: 'Rank is the match-average avg_rank_tier, not a per-player rank; we do not know whether bracketBasicIds is applied per player or per match, so the rank filters are not equivalent.' },
      { id: 'lobby-game-mode', text: 'Lobby type and game mode semantics differ or are unknown: we do not know which lobby types and game modes matchCount includes; the reference subset is our own choice.' },
      { id: 'no-direct-link', text: 'There is no direct link between the external match IDs and STRATZ rows: matchUp exposes no match IDs, so we cannot tell which external matches are counted in either direction.' },
    ],
    interpretation: 'Context only. This comparison does not show that STRATZ is missing matches; the two counts are not directly comparable.',
    sourceArtifact: { path: FIX15_PATHS.externalEvidence, sha256: FIX15_FROZEN_ARTIFACT_SHA256[FIX15_PATHS.externalEvidence] },
  };
}

export function renderIndependentReference(reference) {
  const ex = reference.example;
  const fmt = (value) => value.toFixed(2);
  return [
    '## Independent OpenDota reference',
    '',
    'For context only, we also counted matches for the same pairs and weeks in OpenDota\'s public `public_matches` table (via the OpenDota explorer). We selected matches with `lobby_type = 7` (ranked matchmaking), a match-average rank (`avg_rank_tier`) in Herald–Immortal, and the two heroes on opposing teams. Such a count has no direction: one match counts once for the pair.',
    '',
    `Example: ${ex.heroA.name} (${ex.heroA.id}) / ${ex.heroB.name} (${ex.heroB.id}), week ${ex.bucket} (${ex.window.startUtc} – ${ex.window.endUtcExclusive}, end exclusive):`,
    '',
    `- STRATZ \`matchCount\`: ${ex.stratzMatchCountAtoB} (A→B) / ${ex.stratzMatchCountBtoA} (B→A)`,
    `- OpenDota reference subset: ${ex.externalMatches} matches`,
    '',
    `Across the ${reference.ratio.pairWeeks} pair-weeks studied, the ratio of STRATZ \`matchCount\` to this OpenDota count ranged from ${fmt(reference.ratio.min)} to ${fmt(reference.ratio.max)} (median ${fmt(reference.ratio.median)}).`,
    '',
    'We do not read this as STRATZ missing matches. The two numbers are not directly comparable:',
    '',
    ...reference.caveats.map((caveat) => `- ${caveat.text}`),
    '',
    'We mention it only because it may be relevant to question 10 below (whether the aggregate is based on a subset of matches).',
    '',
  ];
}

export function renderEscalationV2Markdown(record) {
  const base = renderEscalationMarkdown(record);
  const marker = '## Questions\n';
  if (!base.includes(marker)) throw new Error('Escalation template has no Questions section');
  return base.replace(marker, `${renderIndependentReference(record.independentReference).join('\n')}\n${marker}`);
}

// ---------------------------------------------------------------------------
// 7. build
// ---------------------------------------------------------------------------

const readJson = (relative, read) => JSON.parse(read(path.join(ROOT, relative), 'utf8'));

export function buildFix16({ read = readFileSync } = {}) {
  const before = captureProtectedHashes(read);
  verifyProtectedHashes(before);
  const fix11 = readJson('research/data-quality/stratz-reverse-pair-root-cause-evidence.json', read);
  const fix12 = readJson('research/data-quality/stratz-reverse-pair-bracket-semantics-evidence.json', read);
  const fix13 = readJson('research/data-quality/stratz-reverse-pair-partition-semantics-evidence.json', read);
  const fix14 = readJson('research/data-quality/stratz-reverse-pair-match-level-evidence.json', read);
  const fix15Evidence = readJson(FIX15_PATHS.externalEvidence, read);
  const fix15Escalation = readJson(FIX15_PATHS.escalationJson, read);
  const fix15Raw = readJson(FIX15_PATHS.externalRaw, read);
  const rawBytes = read(path.join(ROOT, FIX16_PATHS.raw));
  const raw = JSON.parse(rawBytes.toString('utf8'));
  const rawSha256 = sha256(rawBytes);
  if (raw.fix15RawSha256 !== FIX15_FROZEN_ARTIFACT_SHA256[FIX15_PATHS.externalRaw]) throw new Error('FIX16 raw archive does not refer to the protected FIX15 raw archive');

  const buckets = fix13.buckets;
  const windowStart = buckets[0] * BUCKET_SEC;
  const windowEnd = (buckets.at(-1) + 1) * BUCKET_SEC;
  const fix15Chunks = fix15Raw.opendota.chunks;
  const { lower, upper } = fix15Raw.opendota.boundaries;

  // Range continuity: FIX15 enumeration and FIX16 re-measurement.
  const continuity = checkRangeContinuity(fix15Chunks, { fromId: lower.matchId, toId: upper.matchId });
  const okRanges = raw.ranges.filter((item) => item.status === 'OK');
  const remeasureContinuity = checkRangeContinuity(raw.ranges.filter((item) => item.role === 'fix15-range'), { fromId: lower.matchId, toId: upper.matchId });
  const statsByRange = new Map();
  for (const chunk of fix15Chunks) {
    const parts = okRanges.filter((item) => item.role === 'fix15-range' && item.fromId >= chunk.fromId && item.toId <= chunk.toId);
    const coveredIds = parts.reduce((sum, item) => sum + (item.toId - item.fromId), 0);
    if (parts.length && coveredIds === chunk.toId - chunk.fromId) statsByRange.set(`${chunk.fromId}:${chunk.toId}`, mergeStats(parts.map((item) => item.stats)));
  }
  const consistency = checkTotalsConsistency(fix15Chunks, statsByRange, buckets);
  const failedRanges = raw.ranges.filter((item) => item.status !== 'OK').map((item) => [item.fromId, item.toId]);
  const rangeStatus = {
    fix16Ranges: raw.ranges.length,
    byRole: Object.fromEntries(['fix15-range', 'extension'].map((role) => [role, raw.ranges.filter((item) => item.role === role).length])),
    ok: raw.ranges.filter((item) => item.status === 'OK').length,
    failed: failedRanges.length,
    fix15RangesFullyRemeasured: statsByRange.size,
    fix15RangesIncomplete: fix15Chunks.filter((chunk) => !statsByRange.has(`${chunk.fromId}:${chunk.toId}`)).map((chunk) => [chunk.fromId, chunk.toId]),
    timeoutSplits: raw.ranges.filter((item) => item.role === 'fix15-range').length - fix15Chunks.length,
    fix15ChunkStatus: { ok: fix15Chunks.filter((chunk) => chunk.status === 'OK').length, failed: fix15Chunks.filter((chunk) => chunk.status !== 'OK').length },
  };

  // Ordering: in-range SQL statistics, borders between all measured ranges
  // (FIX15 chunk borders, timeout sub-range borders, extensions) and pair records.
  const measured = [...statsByRange.values()];
  const withinRange = mergeStats(measured).order;
  const groups = analyzeMonotonicityGroups(raw.ranges, fix15Chunks.map((chunk) => [chunk.fromId, chunk.toId]));
  const fix15CrossRange = analyzeRangeTimeOrder(fix15Chunks.map((chunk) => ({ fromId: chunk.fromId, minStart: chunk.rangeMinStart, maxStart: chunk.rangeMaxStart })));
  const pairRecords = fix15Chunks.flatMap((chunk) => chunk.rows.map((row) => Object.fromEntries(MATCH_FIELDS.map((field, index) => [field, row[index]]))));
  const pairRecordOrder = analyzeTimeOrder(pairRecords);
  const maxObservedDropSec = Math.max(groups.globalMaxDropBelowRunningMaxSec, fix15CrossRange.maxCrossRangeDropSec, pairRecordOrder.maxDropBelowRunningMaxSec);
  const steps = withinRange.backwardSteps + withinRange.equalSteps + withinRange.forwardSteps;
  const anyBackward = Object.values(groups.withinRanges).some((g) => g.backwardSteps > 0)
    || Object.values(groups.acrossBorders).some((b) => b.maxDropBelowRunningMaxSec > 0);
  const monotonicity = {
    hypothesis: 'start_time is non-decreasing in match_id',
    result: anyBackward ? 'REFUTED_STRICT_MONOTONICITY' : 'NOT_REFUTED',
    boundedNonMonotonicity: maxObservedDropSec < 3600 ? 'OBSERVED_BOUNDED' : 'LARGE_DEVIATIONS_OBSERVED',
    maxDropByGroupSec: {
      ...Object.fromEntries(Object.entries(groups.withinRanges).map(([name, g]) => [`within:${name}`, g.maxDropBelowRunningMaxSec])),
      ...Object.fromEntries(Object.entries(groups.acrossBorders).map(([name, b]) => [`border:${name}`, b.maxDropBelowRunningMaxSec])),
      pairRecords: pairRecordOrder.maxDropBelowRunningMaxSec,
    },
    groups,
    allRowsWithinMainRanges: { ...withinRange, steps, backwardShare: steps ? Number((withinRange.backwardSteps / steps).toFixed(6)) : null, equalShare: steps ? Number((withinRange.equalSteps / steps).toFixed(6)) : null },
    fix15RangeAggregates: fix15CrossRange,
    pairRecords: pairRecordOrder,
    maxObservedDropSec,
    interpretation: 'match_id is not strictly time-ordered: later IDs can carry earlier start_time. The exact maximum drop over all measured rows (main ranges, sub-range borders, extensions) is compared with the boundary margins; it bounds the observed rows only, not unobserved IDs.',
  };

  // Boundaries.
  const firstChunk = fix15Chunks[0];
  const lastChunk = fix15Chunks.at(-1);
  const inWindowIds = measured.flatMap((stats) => [stats.inWindowMinMatchId, stats.inWindowMaxMatchId]).filter(Number.isFinite);
  const boundaries = assessBoundaries({
    windowStart,
    windowEnd,
    enumerated: {
      fromId: lower.matchId,
      toId: upper.matchId,
      firstStart: firstChunk.rangeMinStart,
      lastStart: lastChunk.rangeMaxStart,
      configuredMarginSec: fix15Raw.opendota.boundaryMarginSec,
      firstInWindowMatchId: inWindowIds.length ? Math.min(...inWindowIds) : null,
      lastInWindowMatchId: inWindowIds.length ? Math.max(...inWindowIds) : null,
    },
    extensions: raw.ranges.filter((item) => item.role === 'extension').map((item) => ({ side: item.side, fromId: item.fromId, toId: item.toId, stats: item.status === 'OK' ? item.stats : null })),
    maxObservedDropSec,
  });
  const boundaryRecords = {
    pairRecordsBeforeWindow: pairRecords.filter((record) => record.start_time < windowStart).length,
    pairRecordsAfterWindow: pairRecords.filter((record) => record.start_time >= windowEnd).length,
    pairRecordsWithinObservedDropOfWindowEdges: pairRecords.filter((record) => Math.abs(record.start_time - windowStart) <= maxObservedDropSec
      || Math.abs(record.start_time - windowEnd) <= maxObservedDropSec).length,
    rowsBeforeWindow: measured.reduce((sum, stats) => sum + stats.beforeWindow, 0),
    rowsAfterWindow: measured.reduce((sum, stats) => sum + stats.afterWindow, 0),
  };

  // Hero arrays.
  const allStats = mergeStats(measured);
  const heroArraysInWindow = { byClass: allStats.heroArraysInWindow, unclassifiable: allStats.inWindow - allStats.heroArraysInWindow.COMPLETE, zeroFlagNonExclusive: allStats.inWindowZeroFlag, rows: allStats.inWindow };
  const heroArrays = {
    definitions: {
      NULL_ARRAY: 'radiant_team or dire_team is NULL (absent); never counted as zeroed',
      INCOMPLETE_ARRAY: 'both arrays present but at least one does not have exactly 5 elements',
      NULL_ELEMENT: 'arrays have 5 elements but contain a NULL hero',
      ZEROED_HERO: 'arrays complete but contain hero id 0',
      COMPLETE: 'two arrays of 5 non-zero hero ids',
      precedence: HERO_ARRAY_CLASSES.join(' > '),
    },
    allRows: { rows: allStats.rows, byClass: allStats.heroArraysAll, unclassifiable: allStats.rows - allStats.heroArraysAll.COMPLETE },
    inWindow: heroArraysInWindow,
    inWindowByBucket: buckets.map((bucket) => ({ bucket, matches: allStats.buckets[`b${bucket}`].matches, unclassifiable: allStats.buckets[`b${bucket}`].unclassifiable, zeroHeroFlag: allStats.buckets[`b${bucket}`].zeroHero })),
    pairRecords: summarizeHeroArrays(pairRecords),
    matchesNotClassifiableByTwoHeroes: heroArraysInWindow.unclassifiable,
    note: 'Unclassifiable rows cannot be attributed to any pair; some of them may involve the studied heroes, so pair counts are lower bounds within the observed rows.',
  };

  const continuityAll = { fix15Enumeration: continuity, fix16Remeasurement: remeasureContinuity };
  const missed = potentiallyMissedMatchIds({
    continuity,
    failedRanges,
    boundaries,
    inWindowUnclassifiable: heroArraysInWindow.unclassifiable,
    rowDrift: consistency.fix16RangeRowsTotal - consistency.fix15RangeRowsTotal,
  });
  const coverage = deriveCoverageStatus({ continuity, consistency, boundaries, heroArrays: heroArraysInWindow });

  const ratios = fix15Evidence.reconciliation.flatMap((row) => [row.comparison?.stratzToExternalRatioAtoB, row.comparison?.stratzToExternalRatioBtoA]).filter(Number.isFinite);
  const medianCorrection = {
    values: ratios.length,
    fix15Recorded: fix15Evidence.reconciliationSummary.stratzToExternalRatio.median,
    fix15Method: 'sorted[floor(n / 2)] (upper central element for even n)',
    corrected: median(ratios),
    correctedMethod: 'mean of the two central elements for even n',
    centralValues: [...ratios].sort((a, b) => a - b).slice(ratios.length / 2 - 1, ratios.length / 2 + 1),
    min: Math.min(...ratios),
    max: Math.max(...ratios),
    fix15ArtifactUnchanged: true,
  };

  // Escalation v2.
  const sourceHashes = captureSourceHashes(read);
  const base = buildEscalation({ fix11, fix12, fix13, fix14, sourceHashes });
  const independentReference = buildIndependentReference(fix15Evidence);
  const escalation = {
    ...base,
    kind: 'STRATZ_SUPPORT_ESCALATION',
    version: 2,
    status: 'DRAFTED',
    statusHistory: [{ status: 'DRAFTED', confirmedBy: 'generator', at: raw.finishedAt, reference: 'FIX16: finalized draft with Independent OpenDota reference; not sent' }],
    supersedes: { path: FIX15_PATHS.escalationJson, sha256: FIX15_FROZEN_ARTIFACT_SHA256[FIX15_PATHS.escalationJson], status: fix15Escalation.status },
    independentReference,
    evidenceReferences: { ...base.evidenceReferences, fix15ExternalEvidence: { path: FIX15_PATHS.externalEvidence, physicalSha256: FIX15_FROZEN_ARTIFACT_SHA256[FIX15_PATHS.externalEvidence] } },
  };
  const markdown = renderEscalationV2Markdown(escalation);
  let token = null;
  try { token = process.env.STRATZ_API_TOKEN?.trim() || null; } catch { token = null; }
  const credentialFindings = scanForCredentials(`${markdown}\n${JSON.stringify(escalation)}\n${rawBytes.toString('utf8')}`, [token]);
  if (credentialFindings.length) throw new Error(`Credential-like content found: ${credentialFindings.join(', ')}`);

  const evidence = {
    schemaVersion: 1,
    kind: 'OPENDOTA_COVERAGE_VALIDATION',
    datasetSource: 'EXTERNAL_MATCH_SOURCE',
    provider: 'OpenDota explorer, table public_matches',
    window: { buckets, startSecInclusive: windowStart, endSecExclusive: windowEnd, bucketSeconds: BUCKET_SEC },
    inputs: {
      fix15Raw: { path: FIX15_PATHS.externalRaw, sha256: FIX15_FROZEN_ARTIFACT_SHA256[FIX15_PATHS.externalRaw], retrievedAt: fix15Raw.retrievedAt },
      fix15Evidence: { path: FIX15_PATHS.externalEvidence, sha256: FIX15_FROZEN_ARTIFACT_SHA256[FIX15_PATHS.externalEvidence] },
      fix16Raw: { path: FIX16_PATHS.raw, sha256: rawSha256, retrievedAt: raw.retrievedAt, finishedAt: raw.finishedAt, requestCount: raw.requestCount, failedRanges },
    },
    medianCorrection,
    rangeContinuity: continuityAll,
    rangeStatus,
    totalsConsistency: consistency,
    timestampMonotonicity: monotonicity,
    boundaries: { ...boundaries, records: boundaryRecords },
    heroArrays,
    externalCoverageLimitations: {
      totalSqlRowCounts: { enumeratedRangeRows: consistency.fix16RangeRowsTotal, fix15EnumeratedRangeRows: consistency.fix15RangeRowsTotal, inWindowRows: allStats.inWindow, byBucket: fix15Evidence.bucketTotals.map((item) => ({ bucket: item.bucket, matches: item.matches })) },
      rankedMatchCounts: { inWindow: allStats.inWindowRanked, byBucket: buckets.map((bucket) => ({ bucket, ranked: allStats.buckets[`b${bucket}`].ranked })) },
      zeroedHeroArrays: { inWindowExclusive: heroArraysInWindow.byClass.ZEROED_HERO, inWindowNonExclusiveFlag: heroArraysInWindow.zeroFlagNonExclusive, fix15ReportedZeroHero: fix15Evidence.bucketTotals.reduce((sum, item) => sum + item.zeroHeroMatches, 0) },
      nullOrIncompleteHeroArrays: { nullArray: heroArraysInWindow.byClass.NULL_ARRAY, incompleteArray: heroArraysInWindow.byClass.INCOMPLETE_ARRAY, nullElement: heroArraysInWindow.byClass.NULL_ELEMENT },
      selectedPairMatchRecords: { records: pairRecords.length, uniqueMatchIds: fix15Evidence.dataset.uniqueMatchIds, inWindow: fix15Evidence.dataset.inWindowPairCandidateMatches },
      outOfWindowRecords: { pairRecords: fix15Evidence.dataset.outOfWindowRecords, rowsBeforeWindow: boundaryRecords.rowsBeforeWindow, rowsAfterWindow: boundaryRecords.rowsAfterWindow },
      boundaryMargins: { lowerDays: boundaries.lowerMarginDays, upperDays: boundaries.upperMarginDays, maxObservedDropSec, status: boundaries.status },
      potentiallyMissedMatchIds: missed,
    },
    sourceCoverage: coverage,
    productionThresholdApplied: false,
    productionThresholdNote: 'External coverage is partial; the production asymmetry threshold is not applied to external counts.',
    escalation: { path: FIX16_PATHS.escalationJson, status: escalation.status },
    protectedHashes: before,
    evidenceSha256: '',
  };
  const rootCause = classifyRootCause({ escalation, externalEvidence: evidence });
  evidence.rootCause = rootCause;
  evidence.evidenceSha256 = canonicalJsonSha256(evidence, 'evidenceSha256');

  const escalationJson = {
    ...escalation,
    markdown: { path: FIX16_PATHS.escalationMd, sha256: sha256(markdown) },
    credentialScan: { status: 'CLEAN', scope: 'escalation markdown, escalation JSON, FIX16 raw archive' },
    coverageValidation: { path: FIX16_PATHS.evidence, evidenceSha256: evidence.evidenceSha256, sourceCoverage: coverage.classification },
    rootCause,
    evidenceSha256: '',
  };
  escalationJson.evidenceSha256 = canonicalJsonSha256(escalationJson, 'evidenceSha256');

  const after = captureProtectedHashes(read);
  verifyProtectedHashes(after);
  return {
    [FIX16_PATHS.evidence]: `${JSON.stringify(evidence, null, 2)}\n`,
    [FIX16_PATHS.escalationMd]: markdown,
    [FIX16_PATHS.escalationJson]: `${JSON.stringify(escalationJson, null, 2)}\n`,
  };
}

// ---------------------------------------------------------------------------
// 8. network collector (OpenDota only)
// ---------------------------------------------------------------------------

const OPENDOTA = 'https://api.opendota.com/api';
const USER_AGENT = 'research-client';
const RATE_HEADERS = ['x-rate-limit-remaining-minute', 'x-rate-limit-remaining-day'];

async function collect({ fix13, fix15Raw, fetchImpl = fetch, log = console.log, delayMs = 1100, extensionChunk = 300000, extensionChunks = 2 }) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let requests = 0;
  const rateLimits = [];
  const explorer = async (sql) => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      if (requests > 0) await sleep(delayMs);
      requests += 1;
      const response = await fetchImpl(`${OPENDOTA}/explorer?sql=${encodeURIComponent(sql)}`, { headers: { 'user-agent': USER_AGENT } });
      const text = await response.text();
      rateLimits.push(Object.fromEntries(RATE_HEADERS.map((name) => [name, response.headers.get(name)])));
      if ((response.status === 429 || response.status >= 500) && attempt < 4) { await sleep(5000 * attempt); continue; }
      let body;
      try { body = JSON.parse(text); } catch { body = { err: `non-JSON response (HTTP ${response.status})` }; }
      if (response.status !== 200 || body?.err) return { ok: false, error: String(body?.err ?? `HTTP ${response.status}`), httpStatus: response.status };
      return { ok: true, rows: body.rows, httpStatus: response.status };
    }
    throw new Error('unreachable');
  };
  const buckets = fix13.buckets;
  const retrievedAt = new Date().toISOString();
  const { lower, upper } = fix15Raw.opendota.boundaries;
  const headSql = `SELECT max(match_id) AS max_id, max(start_time) AS max_t FROM public_matches WHERE match_id >= ${upper.matchId}`;
  const head = await explorer(headSql);
  if (!head.ok) throw new Error(`Table head probe failed: ${head.error}`);
  const headId = Number(head.rows[0].max_id ?? upper.matchId - 1);

  const queue = fix15Raw.opendota.chunks.map((chunk) => ({ role: 'fix15-range', side: null, fromId: chunk.fromId, toId: chunk.toId }));
  for (let index = extensionChunks; index >= 1; index -= 1) {
    queue.push({ role: 'extension', side: 'below', fromId: lower.matchId - index * extensionChunk, toId: lower.matchId - (index - 1) * extensionChunk });
  }
  for (let from = upper.matchId, index = 0; from <= headId && index < extensionChunks; from += extensionChunk, index += 1) {
    queue.push({ role: 'extension', side: 'above', fromId: from, toId: Math.min(from + extensionChunk, headId + 1) });
  }
  const ranges = [];
  while (queue.length) {
    const item = queue.shift();
    const sql = coverageStatsSql(item.fromId, item.toId, buckets);
    const result = await explorer(sql);
    if (!result.ok && /timeout/i.test(result.error) && item.toId - item.fromId > 50000) {
      const mid = Math.floor((item.fromId + item.toId) / 2);
      queue.unshift({ ...item, toId: mid }, { ...item, fromId: mid });
      continue;
    }
    ranges.push({
      ...item,
      sqlSha256: sha256(sql),
      status: result.ok ? 'OK' : 'FAILED',
      error: result.ok ? null : result.error,
      stats: result.ok ? parseStatsRow(result.rows[0], buckets) : null,
    });
    if (ranges.length % 20 === 0) log(`[FIX16] ranges ${ranges.length}, remaining ${queue.length}`);
  }
  ranges.sort((a, b) => a.fromId - b.fromId || a.toId - b.toId);
  return {
    schemaVersion: 1,
    kind: 'OPENDOTA_COVERAGE_VALIDATION_RAW',
    retrievedAt,
    finishedAt: new Date().toISOString(),
    source: 'OpenDota public explorer (anonymous, read-only SELECT over public_matches); STRATZ not contacted',
    clientIdentification: `user-agent "${USER_AGENT}"; response headers other than rate-limit counters are not stored`,
    requestCount: requests,
    fix15RawSha256: FIX15_FROZEN_ARTIFACT_SHA256[FIX15_PATHS.externalRaw],
    statsSqlTemplate: coverageStatsSql('<fromId>', '<toId>', buckets),
    tableHead: { sql: headSql, maxMatchId: headId, maxStart: Number(head.rows[0].max_t ?? 0) || null },
    rateLimitLast: rateLimits.at(-1) ?? null,
    ranges,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

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
    const target = path.join(ROOT, FIX16_PATHS.raw);
    if (existsSync(target)) throw new Error('FIX16 raw archive already exists; refusing to overwrite');
    verifyProtectedHashes(captureProtectedHashes());
    const raw = await collect({
      fix13: readJson('research/data-quality/stratz-reverse-pair-partition-semantics-evidence.json', readFileSync),
      fix15Raw: readJson(FIX15_PATHS.externalRaw, readFileSync),
    });
    const text = `${JSON.stringify(raw)}\n`;
    const findings = scanForCredentials(text, [process.env.STRATZ_API_TOKEN?.trim()]);
    if (findings.length) throw new Error(`Raw archive contains credential-like content: ${findings.join(', ')}`);
    writeFileSync(target, text, { flag: 'wx' });
    verifyProtectedHashes(captureProtectedHashes());
    console.log(JSON.stringify({ requests: raw.requestCount, ranges: raw.ranges.length, failed: raw.ranges.filter((item) => item.status !== 'OK').length, sha256: sha256(text) }, null, 2));
    return;
  }
  if (command === 'check') {
    // FIX16 artifacts are frozen (see FIX16_FROZEN_ARTIFACT_SHA256).
    verifyProtectedHashes(captureProtectedHashes());
    const result = {};
    for (const [relative, expected] of Object.entries(FIX16_FROZEN_ARTIFACT_SHA256)) {
      if (sha256(readFileSync(path.join(ROOT, relative))) !== expected) throw new Error(`${relative} changed`);
      result[relative] = 'FROZEN_HASH_OK';
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'build') {
    const outputs = buildFix16();
    const result = {};
    for (const [relative, content] of Object.entries(outputs)) {
      result[relative] = writeOnce(relative, content);
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error('Usage: node scripts/stratz-opendota-coverage-validation.mjs <collect|build|check>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[STRATZ FIX16] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
