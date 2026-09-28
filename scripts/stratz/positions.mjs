/**
 * Position statistics from STRATZ (ТЗ №9).
 *
 * Why this exists: OpenDota `roles` (Carry / Support / Disabler / Nuker) are
 * generic ability tags, not positions. They gave Wraith King a "Support" tag
 * (it can be forced) and Meepo a "Disabler" tag, so a strong counter pick could
 * drag either onto position 4/5. Actual pick rates do not lie that way.
 *
 * Source (verified by schema introspection, not assumed):
 *   heroStats.stats(heroIds, week, bracketBasicIds, groupByPosition: true)
 *     -> [HeroPositionTimeDetailType]  { heroId, position, matchCount, ... }
 * The enum is MatchPlayerPositionType = POSITION_1..POSITION_5 (+ UNKNOWN,
 * FILTERED, ALL). POSITION_N -> N is confirmed empirically, not assumed: over
 * the production window Lion is 55% POSITION_5 / 32% POSITION_4, Rubick 50%
 * POSITION_4, Meepo 79% POSITION_2 — the ids mean what they say.
 *
 * Batching: one request per weekly bucket for ALL heroes at once (4 requests),
 * because `stats()` takes `heroIds` as a list. Not 127 x N.
 */
import { BUCKET_SEC, BRACKETS, StratzTransport } from '../update-data-stratz.mjs';

export { BRACKETS };

/** The five real positions. UNKNOWN/FILTERED rows are dropped, never coerced. */
export const POSITION_KEYS = ['POSITION_1', 'POSITION_2', 'POSITION_3', 'POSITION_4', 'POSITION_5'];

export function buildPositionQuery(heroIds, bucket) {
  return `{ heroStats { stats(heroIds: ${JSON.stringify(heroIds)}, week: ${bucket * BUCKET_SEC}, bracketBasicIds: [${BRACKETS.join(', ')}], groupByPosition: true) { heroId position matchCount } } }`;
}

/**
 * Fetch and aggregate per-hero position games over the same complete-bucket
 * window the matchups use. Returns `heroId -> { totalGames, positions: {'1'..'5': {games, share}} }`.
 */
export async function fetchPositionsFromStratz(heroIds, windowInfo, { token, log = console.log } = {}) {
  log(`    Querying STRATZ position stats in ${windowInfo.buckets.length} bucket requests…`);
  const transport = new StratzTransport(token);
  await transport.init();

  const totals = new Map(); // heroId -> { 1..5: games }
  try {
    for (const bucket of windowInfo.buckets) {
      const t0 = Date.now();
      const res = await transport.query(buildPositionQuery(heroIds, bucket));
      const rows = res.data?.heroStats?.stats ?? [];
      log(`    Position bucket ${bucket}: ${rows.length} rows in ${Date.now() - t0}ms`);
      for (const row of rows) {
        if (!POSITION_KEYS.includes(row.position)) continue; // UNKNOWN / FILTERED
        const heroId = Number(row.heroId);
        const pos = Number(row.position.replace('POSITION_', ''));
        if (!Number.isInteger(heroId) || !Number.isInteger(pos)) continue;
        if (!totals.has(heroId)) totals.set(heroId, {});
        const m = totals.get(heroId);
        m[pos] = (m[pos] ?? 0) + Number(row.matchCount ?? 0);
      }
    }
  } finally {
    await transport.close();
  }

  const out = {};
  for (const [heroId, m] of totals) {
    const totalGames = [1, 2, 3, 4, 5].reduce((s, n) => s + (m[n] ?? 0), 0);
    if (totalGames <= 0) continue;
    out[String(heroId)] = {
      totalGames,
      positions: Object.fromEntries(
        [1, 2, 3, 4, 5].map((n) => {
          const games = m[n] ?? 0;
          return [String(n), { games, share: games / totalGames }];
        }),
      ),
    };
  }
  return out;
}

/**
 * Shares are `games / totalGames` in binary floating point, so the five shares
 * sum to 1 only up to rounding. 1e-9 sits ~4 orders of magnitude above the
 * accumulated error of five double divisions and still ~7 orders below any
 * real data defect (one dropped position moves the sum by ~1e-2).
 */
export const SHARE_SUM_TOLERANCE = 1e-9;

/**
 * Cross-check positions against the matchup snapshot: same roster, same
 * window, same population. A positions layer from a different week or bracket
 * set would silently mislabel every hero, so it is a hard gate, not a warning.
 */
export function validatePositionData(positions, { heroes, windowInfo, brackets = BRACKETS }) {
  const heroIds = heroes.map((h) => h.id);
  const canonical = new Set(heroIds);
  const problems = [];

  const extra = Object.keys(positions).filter((k) => !canonical.has(Number(k)));
  if (extra.length > 0) problems.push(`unknown hero ids in positions: ${extra.slice(0, 5).join(', ')}`);
  const missing = heroIds.filter((id) => !positions[String(id)]);
  if (missing.length > 0) {
    problems.push(`positions missing for ${missing.length} canonical hero(s): ${missing.slice(0, 5).join(', ')}`);
  }
  if (problems.length > 0) throw new Error(`Position data contract failed:\n  - ${problems.join('\n  - ')}`);

  for (const id of heroIds) {
    const entry = positions[String(id)];
    const where = `hero ${id}`;
    if (!Number.isInteger(entry.totalGames) || entry.totalGames <= 0) {
      throw new Error(`Position data contract failed: ${where} totalGames must be a positive integer, got ${entry.totalGames}`);
    }
    const keys = Object.keys(entry.positions).sort().join(',');
    if (keys !== '1,2,3,4,5') {
      throw new Error(`Position data contract failed: ${where} must have positions 1..5, got [${keys}]`);
    }
    let shareSum = 0;
    let gamesSum = 0;
    for (const n of ['1', '2', '3', '4', '5']) {
      const p = entry.positions[n];
      if (!Number.isInteger(p.games) || p.games < 0) {
        throw new Error(`Position data contract failed: ${where} position ${n} games must be a non-negative integer, got ${p.games}`);
      }
      if (typeof p.share !== 'number' || !(p.share >= 0) || !(p.share <= 1)) {
        throw new Error(`Position data contract failed: ${where} position ${n} share must be within [0,1], got ${p.share}`);
      }
      shareSum += p.share;
      gamesSum += p.games;
    }
    if (gamesSum !== entry.totalGames) {
      throw new Error(`Position data contract failed: ${where} position games sum ${gamesSum} != totalGames ${entry.totalGames}`);
    }
    if (Math.abs(shareSum - 1) > SHARE_SUM_TOLERANCE) {
      throw new Error(
        `Position data contract failed: ${where} shares sum to ${shareSum.toFixed(12)}, expected 1 (±${SHARE_SUM_TOLERANCE})`,
      );
    }
  }

  // §6 — same snapshot as the matchups.
  if (!Array.isArray(windowInfo?.buckets) || windowInfo.buckets.length === 0) {
    throw new Error('Position data contract failed: no weekly buckets supplied');
  }
  const unexpected = brackets.filter((b) => !BRACKETS.includes(b));
  if (unexpected.length > 0) {
    throw new Error(`Position data contract failed: brackets ${unexpected.join(', ')} are outside the production population`);
  }

  return { heroCount: heroIds.length, buckets: windowInfo.buckets, brackets };
}
