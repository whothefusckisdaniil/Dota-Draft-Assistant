/**
 * Per-position win rates by rank ("top supports right now").
 *
 * The same STRATZ endpoint as positions.mjs — heroStats.stats(groupByPosition)
 * — also returns winCount, and it can be filtered by rank bracket. One request
 * per weekly bucket asks for all four brackets at once (aliases), so this
 * layer costs as many requests as there are buckets (4–5).
 *
 * Output (public/data/role-stats.json):
 *   { "ALL" | <bracket>: { <heroId>: [[games, wins] × positions 1..5] } }
 * "ALL" is the sum of the four brackets (they partition the population).
 * Weighted by the rolling-window bucket weights like every other layer.
 */
import { BUCKET_SEC, BRACKETS, StratzTransport } from '../update-data-stratz.mjs';

const POSITIONS = ['POSITION_1', 'POSITION_2', 'POSITION_3', 'POSITION_4', 'POSITION_5'];

export function buildRoleStatsQuery(heroIds, bucket, brackets = BRACKETS) {
  const body = brackets
    .map((b) => `${b}: stats(heroIds: ${JSON.stringify(heroIds)}, week: ${bucket * BUCKET_SEC}, bracketBasicIds: [${b}], groupByPosition: true) { heroId position matchCount winCount }`)
    .join('\n    ');
  return `{ heroStats {\n    ${body}\n  } }`;
}

/** Raw weighted sums: { bracket: Map(heroId -> [[g, w] × 5]) }. */
export async function fetchRoleStatsFromStratz(heroIds, windowInfo, { token, log = console.log, brackets = BRACKETS } = {}) {
  log(`    Querying STRATZ per-position win rates in ${windowInfo.buckets.length} bucket requests (${brackets.length} brackets each)…`);
  const transport = new StratzTransport(token);
  await transport.init();
  const out = Object.fromEntries(brackets.map((b) => [b, {}]));
  try {
    for (const bucket of windowInfo.buckets) {
      const weight = windowInfo.weights?.[bucket] ?? 1;
      const res = await transport.query(buildRoleStatsQuery(heroIds, bucket, brackets));
      for (const b of brackets) {
        for (const row of res.data?.heroStats?.[b] ?? []) {
          const p = POSITIONS.indexOf(row.position);
          if (p < 0) continue; // UNKNOWN / FILTERED
          const id = Number(row.heroId);
          if (!Number.isInteger(id)) continue;
          const cells = (out[b][id] ??= [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]);
          cells[p][0] += weight * Number(row.matchCount ?? 0);
          cells[p][1] += weight * Number(row.winCount ?? 0);
        }
      }
    }
  } finally {
    await transport.close();
  }
  return out;
}

/** Integers, every hero present (zeros for a hero nobody played), plus "ALL". */
export function finalizeRoleStats(raw, heroes) {
  const ids = heroes.map((h) => h.id);
  const out = {};
  for (const [bracket, table] of Object.entries(raw)) {
    out[bracket] = {};
    for (const id of ids) {
      const cells = table[id] ?? table[String(id)] ?? [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]];
      out[bracket][id] = cells.map(([g, w]) => {
        const games = Math.round(g);
        return [games, Math.min(games, Math.round(w))];
      });
    }
  }
  out.ALL = {};
  for (const id of ids) {
    out.ALL[id] = [0, 1, 2, 3, 4].map((p) => {
      let g = 0;
      let w = 0;
      for (const b of Object.keys(raw)) {
        g += out[b][id][p][0];
        w += out[b][id][p][1];
      }
      return [g, w];
    });
  }
  return out;
}

/**
 * Sanity contract. Every match has exactly two players at each position, so
 * the five position totals of a bracket must be (nearly) equal; a broken or
 * mis-mapped response breaks that immediately. Per-position win rates of the
 * whole population must sit near 50%.
 */
export function validateRoleStats(stats, heroes, { brackets = BRACKETS } = {}) {
  const ids = heroes.map((h) => h.id);
  const problems = [];
  for (const bracket of ['ALL', ...brackets]) {
    const table = stats[bracket];
    if (!table) { problems.push(`no ${bracket} table`); continue; }
    if (Object.keys(table).length !== ids.length || ids.some((id) => !table[id])) problems.push(`${bracket}: roster mismatch`);
    const totals = [0, 0, 0, 0, 0];
    const wins = [0, 0, 0, 0, 0];
    for (const id of ids) {
      const cells = table[id];
      if (!Array.isArray(cells) || cells.length !== 5) { problems.push(`${bracket}: hero ${id} malformed`); continue; }
      cells.forEach(([g, w], p) => {
        if (!Number.isInteger(g) || !Number.isInteger(w) || g < 0 || w < 0 || w > g) problems.push(`${bracket}: hero ${id} pos ${p + 1} [${g}, ${w}]`);
        totals[p] += g;
        wins[p] += w;
      });
    }
    const mean = totals.reduce((a, b) => a + b, 0) / 5;
    if (mean < 1000) problems.push(`${bracket}: only ${Math.round(mean)} games per position`);
    for (let p = 0; p < 5; p++) {
      if (mean > 0 && Math.abs(totals[p] - mean) / mean > 0.1) problems.push(`${bracket}: position ${p + 1} has ${totals[p]} games vs mean ${Math.round(mean)}`);
      const wr = totals[p] ? (100 * wins[p]) / totals[p] : 50;
      if (wr < 45 || wr > 55) problems.push(`${bracket}: position ${p + 1} population win rate ${wr.toFixed(1)}%`);
    }
    if (problems.length > 20) break;
  }
  if (problems.length) throw new Error(`Role stats contract failed: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ''}`);
  return { brackets: ['ALL', ...brackets] };
}
