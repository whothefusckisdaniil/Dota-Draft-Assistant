#!/usr/bin/env node
/**
 * STRATZ reverse-pair asymmetry diagnostic library (TZ #76).
 *
 * Provides pure functions for computing matchup asymmetry metrics,
 * canonical pair IDs, directed vs unordered violation counts, bucket-level
 * breakdowns, and symmetric diagnostic metrics (D_max, D_mean) alongside the
 * existing production validation formula.
 *
 * All functions are offline and deterministic — no network access.
 */
import { createHash } from 'node:crypto';

/**
 * Canonical unordered pair ID: min(A,B):max(B,A).
 * Ensures A->B and B->A map to the same canonical key.
 * @param {number} heroIdA
 * @param {number} heroIdB
 * @returns {string}
 */
export function canonicalPairId(heroIdA, heroIdB) {
  const lo = Math.min(heroIdA, heroIdB);
  const hi = Math.max(heroIdA, heroIdB);
  return `${lo}:${hi}`;
}

/**
 * Relative delta between two game counts: |A - B| / A.
 * Returns 0 when A is 0 (degenerate but safe).
 * @param {number} gamesA
 * @param {number} gamesB
 * @returns {number}
 */
export function relativeDeltaA(gamesA, gamesB) {
  if (gamesA === 0) return 0;
  return Math.abs(gamesA - gamesB) / gamesA;
}

/**
 * Symmetric D_max: |A - B| / max(A, B).
 * @param {number} gamesA
 * @param {number} gamesB
 * @returns {number}
 */
export function symmetricDMax(gamesA, gamesB) {
  const max = Math.max(gamesA, gamesB);
  if (max === 0) return 0;
  return Math.abs(gamesA - gamesB) / max;
}

/**
 * Symmetric D_mean: 2 * |A - B| / (A + B).
 * @param {number} gamesA
 * @param {number} gamesB
 * @returns {number}
 */
export function symmetricDMean(gamesA, gamesB) {
  const sum = gamesA + gamesB;
  if (sum === 0) return 0;
  return (2 * Math.abs(gamesA - gamesB)) / sum;
}

/**
 * Diagnose a single directed matchup row against its reverse.
 *
 * `gamesA`/`winsA` come from the row `enemyId -> opponentId`.
 * `gamesB`/`winsB` come from the reverse row `opponentId -> enemyId`.
 * @param {number} heroIdA
 * @param {number} heroIdB
 * @param {number} gamesA
 * @param {number} winsA
 * @param {number} gamesB
 * @param {number} winsB
 * @returns {Object}
 */
export function diagnosePair(heroIdA, heroIdB, gamesA, winsA, gamesB, winsB) {
  const canonical = canonicalPairId(heroIdA, heroIdB);
  const absGamesDelta = Math.abs(gamesA - gamesB);
  const relA = relativeDeltaA(gamesA, gamesB);
  const relB = relativeDeltaA(gamesB, gamesA);
  const dMax = symmetricDMax(gamesA, gamesB);
  const dMean = symmetricDMean(gamesA, gamesB);
  const winsSumDelta = Math.abs(winsA + winsB - gamesA);
  // Production validation formula: >3% relative AND >15 games absolute.
  const thresholdExceeded = relA > 0.03 && absGamesDelta > 15;
  return {
    canonicalPairId: canonical,
    heroIdA,
    heroIdB,
    gamesA,
    gamesB,
    winsA,
    winsB,
    absoluteGamesDelta: absGamesDelta,
    relativeDeltaA: relA,
    relativeDeltaB: relB,
    symmetricRelativeDeltaDMax: dMax,
    symmetricRelativeDeltaDMean: dMean,
    winsSumDelta: winsSumDelta,
    thresholdExceeded,
    validationStatus: thresholdExceeded ? 'FAIL' : 'PASS',
  };
}

/**
 * Build a diagnosis summary from a matchups dataset.
 *
 * `dataset` maps enemyId string -> array of { hero_id, games_played, wins }.
 * Each entry is a directed row `enemyId -> hero_id`.
 * @param {Record<string, Array<{hero_id:number, games_played:number, wins:number}>>} dataset
 * @returns {Object}
 */
export function diagnoseDataset(dataset) {
  const failingCanonical = new Set();
  let directedViolations = 0;
  const pairRows = new Map();
  const directedRows = new Map();
  const allRows = [];

  for (const [enemyIdStr, rows] of Object.entries(dataset)) {
    const enemyId = Number(enemyIdStr);
    for (const row of rows) {
      const opponentId = row.hero_id;
      const canonical = canonicalPairId(enemyId, opponentId);
      const directionKey = `${enemyId}:${opponentId}`;
      const direction = enemyId < opponentId ? 'A->B' : 'B->A';
      if (!directedRows.has(directionKey)) directedRows.set(directionKey, []);
      directedRows.get(directionKey).push({ enemyId, opponentId, ...row });
      if (!pairRows.has(canonical)) pairRows.set(canonical, []);
      pairRows.get(canonical).push({ enemyId, opponentId, direction, ...row });
    }
  }

  const pairDiagnoses = [];
  let missingReversePairCount = 0;
  let duplicateDirectionCount = 0;

  for (const [canonical, rows] of [...pairRows.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [heroA, heroB] = canonical.split(':').map(Number);
    const aToB = directedRows.get(`${heroA}:${heroB}`) ?? [];
    const bToA = directedRows.get(`${heroB}:${heroA}`) ?? [];
    const hasDuplicates = aToB.length > 1 || bToA.length > 1;
    if (aToB.length > 1) duplicateDirectionCount += 1;
    if (bToA.length > 1) duplicateDirectionCount += 1;

    if (hasDuplicates) {
      pairDiagnoses.push({
        canonicalPairId: canonical,
        status: 'DUPLICATE_DIRECTION',
        gamesA: null,
        gamesB: null,
        winsA: null,
        winsB: null,
        thresholdExceeded: null,
      });
      continue;
    }

    if (aToB.length === 0 || bToA.length === 0) {
      missingReversePairCount += 1;
      const observed = aToB[0] ?? bToA[0];
      pairDiagnoses.push({
        canonicalPairId: canonical,
        heroIdA: observed.enemyId,
        heroIdB: observed.opponentId,
        gamesA: observed.games_played,
        gamesB: null,
        winsA: observed.wins,
        winsB: null,
        status: 'MISSING_REVERSE',
        thresholdExceeded: null,
      });
      continue;
    }

    const forward = diagnosePair(heroA, heroB, aToB[0].games_played, aToB[0].wins, bToA[0].games_played, bToA[0].wins);
    const reverse = diagnosePair(heroB, heroA, bToA[0].games_played, bToA[0].wins, aToB[0].games_played, aToB[0].wins);
    const pairViolationCount = Number(forward.thresholdExceeded) + Number(reverse.thresholdExceeded);
    directedViolations += pairViolationCount;
    if (pairViolationCount > 0) failingCanonical.add(canonical);
    pairDiagnoses.push({
      ...forward,
      status: 'COMPARED',
      directionDiagnoses: [forward, reverse],
      thresholdExceeded: pairViolationCount > 0,
      validationStatus: pairViolationCount > 0 ? 'FAIL' : 'PASS',
    });
  }

  for (const [canonical, rows] of [...pairRows.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [heroA, heroB] = canonical.split(':').map(Number);
    const aToB = directedRows.get(`${heroA}:${heroB}`) ?? [];
    const bToA = directedRows.get(`${heroB}:${heroA}`) ?? [];
    for (const row of rows) {
      const sameDirection = row.direction === 'A->B' ? aToB : bToA;
      const reverseDirection = row.direction === 'A->B' ? bToA : aToB;
      const hasDuplicates = sameDirection.length > 1 || reverseDirection.length > 1;
      const status = hasDuplicates
        ? 'DUPLICATE_DIRECTION'
        : reverseDirection.length === 0
          ? 'MISSING_REVERSE'
          : 'COMPARED';
      allRows.push({
        canonicalPairId: canonical,
        direction: row.direction,
        games: row.games_played,
        wins: row.wins,
        reverseGames: reverseDirection.length === 1 ? reverseDirection[0].games_played : null,
        reverseWins: reverseDirection.length === 1 ? reverseDirection[0].wins : null,
        status,
      });
    }
  }

  return {
    directedViolations,
    uniqueViolationPairs: failingCanonical.size,
    missingReversePairCount,
    // duplicateDirectionCount counts duplicated directed groups, not extra rows.
    duplicateDirectionCount,
    checkedDirectionCount: allRows.filter((row) => row.status === 'COMPARED').length,
    pairDiagnoses,
    allRows,
  };
}

/**
 * Hash a GraphQL query string for diagnostics (no secrets included).
 * @param {string} queryStr
 * @returns {string}
 */
export function hashQuery(queryStr) {
  return createHash('sha256').update(queryStr).digest('hex').slice(0, 16);
}

/**
 * Determine if a raw `vs` row has an orientation problem:
 * neither heroId1 nor heroId2 equals the queried enemyId.
 * @param {number} enemyId
 * @param {number|null} heroId1
 * @param {number|null} heroId2
 * @returns {boolean}
 */
export function rowHasOrientationProblem(enemyId, heroId1, heroId2) {
  if (heroId1 == null || heroId2 == null) return true;
  return heroId1 !== enemyId && heroId2 !== enemyId;
}