/**
 * Controlled Level-2 pilot — pure helpers (ТЗ §28).
 *
 * The bridge in ТЗ №27 proved that an OpenDota-discovered `match_id` can be
 * hydrated from STRATZ. What is still unknown is whether the resulting
 * `Hero × Position × Enemy` layer has enough support to be worth building
 * anything on. This file produces that layer and measures it.
 *
 * Two rules hold throughout:
 *
 *  - **Raw counts only.** `wins` and `losses` are recorded. No winrate, no
 *    lift, no score, no ranking. Deciding what those numbers mean is a
 *    separate study.
 *  - **Position is observed or it is absent.** A player whose position is
 *    `null` never reaches a Level-2 tuple; it is not filed under a "null"
 *    position, which would look like a real stratum.
 *
 * Helpers are shared with the ТЗ №27 bridge (roster keys, enemy extraction,
 * inventory splitting, position parsing) rather than reimplemented.
 */
import { BRIDGE_FAILURE, extractEnemies, parseStratzPosition, sideOf, splitInventory } from './cross-source-match-lib.mjs';

export { BRIDGE_FAILURE };

/** §2 — fixed before the crawl; never revised once it starts. */
export const TARGET_PER_BUCKET = 100;
export const TARGET_TOTAL = 400;

/** §3 — a ceiling on discovery rows EXAMINED, not on hydrations. */
export const MAX_DISCOVERY_ROWS_PER_BUCKET = 5000;

/** §16 — pre-declared support bins. Chosen before any data existed. */
export const SUPPORT_BINS_HE = [
  { label: '0', min: 0, max: 0 }, { label: '1', min: 1, max: 1 },
  { label: '2-4', min: 2, max: 4 }, { label: '5-9', min: 5, max: 9 },
  { label: '10-24', min: 10, max: 24 }, { label: '25-49', min: 25, max: 49 },
  { label: '50+', min: 50, max: Infinity },
];
export const SUPPORT_BINS_HP = [
  { label: '0-4', min: 0, max: 4 }, { label: '5-9', min: 5, max: 9 },
  { label: '10-24', min: 10, max: 24 }, { label: '25-49', min: 25, max: 49 },
  { label: '50+', min: 50, max: Infinity },
];

/** §8 — position coverage is a class, not a pass/fail. */
export const POSITION_CLASS = {
  FULL: 'POSITION_FULL',
  PARTIAL: 'POSITION_PARTIAL',
  NONE: 'POSITION_NONE',
};

export function positionClass(players) {
  const ps = (players ?? []).map((p) => parseStratzPosition(p?.position));
  const covered = ps.filter((x) => x !== null).length;
  if (covered === ps.length && covered > 0) return POSITION_CLASS.FULL;
  if (covered === 0) return POSITION_CLASS.NONE;
  return POSITION_CLASS.PARTIAL;
}

/**
 * §13 — inventory presence with multiplicity kept, scoring not.
 * A physically duplicated item is ONE presence observation; the copy count is
 * retained as metadata so a later study can choose to weight it.
 */
export function dedupeItemPresence(itemIds) {
  const counts = new Map();
  for (const id of itemIds ?? []) {
    if (id === null || id === undefined) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([itemId, copyCount]) => ({ itemId, copyCount }))
    .sort((a, b) => a.itemId - b.itemId);
}

/** §10 — `Hero × Position × Enemy × Match`, one row per (player, enemy). */
export function buildHeroEnemyRows(bridged, playersByMatch) {
  const rows = [];
  const failures = [];
  for (const b of bridged ?? []) {
    // §5/§6 — selection is upstream of hydration. A match that failed to
    // bridge is simply absent; it is never replaced by another candidate.
    if (!b.ok) continue;
    const players = playersByMatch?.get(b.matchId) ?? [];
    for (const p of players) {
      const position = parseStratzPosition(p?.position);
      if (position === null) continue;              // §7 — not in the tuple
      if (sideOf(p) === null) continue;             // §6 — unknown side
      const enemies = extractEnemies(players, p);
      if (!enemies || enemies.length !== 5) {      // §9
        failures.push({ matchId: b.matchId, heroId: p?.heroId ?? null, reason: 'ENEMY_RECONSTRUCTION_FAILED' });
        continue;
      }
      for (const enemyHeroId of enemies) {
        rows.push({
          matchId: b.matchId,
          heroId: p.heroId ?? null,
          position,
          enemyHeroId,
          isVictory: typeof p?.isVictory === 'boolean' ? p.isVictory : null,
          bucket: b.bucket ?? null,
          mode: b.mode ?? null,
        });
      }
    }
  }
  return { rows, failures };
}

/** §11/§12 — `Hero × Position × Enemy × Item × Match`, final inventory only. */
export function buildItemRows(heroEnemyRows, inventoryByMatch) {
  const rows = [];
  for (const r of heroEnemyRows ?? []) {
    const inv = inventoryByMatch?.get(`${r.matchId}|${r.heroId}`);
    if (!inv) continue;
    for (const { itemId, copyCount } of dedupeItemPresence(inv.finalInventory)) {
      rows.push({ ...r, itemId, copyCount });
    }
  }
  return rows;
}

/* --------------------------------------------------------------- aggregates */

const cellKey = (r) => `${r.heroId}|${r.position}|${r.enemyHeroId}`;
const cellItemKey = (r) => `${r.heroId}|${r.position}|${r.enemyHeroId}|${r.itemId}`;
const hpKey = (r) => `${r.heroId}|${r.position}`;

/**
 * §14 — `Hero × Position × Enemy`: matches, wins, losses, uniqueItems.
 *
 * RAW COUNTS ONLY. This is deliberately not a winrate: a cell with 2 matches
 * and 2 wins must not look like a cell with 200 and 150, and only the caller
 * can decide whether any of it is usable. §30 says so explicitly.
 */
export function aggregateSupport(heroEnemyRows, itemRows) {
  const cells = new Map();
  for (const r of heroEnemyRows ?? []) {
    const k = cellKey(r);
    let c = cells.get(k);
    if (!c) {
      c = { key: k, heroId: r.heroId, position: r.position, enemyHeroId: r.enemyHeroId, matches: new Set(), wins: 0, losses: 0, uniqueItems: new Set() };
      cells.set(k, c);
    }
    c.matches.add(r.matchId);
    if (r.isVictory === true) c.wins += 1;
    else if (r.isVictory === false) c.losses += 1;
  }
  for (const r of itemRows ?? []) {
    const c = cells.get(cellKey(r));
    if (c) c.uniqueItems.add(r.itemId);
  }
  const out = [...cells.values()].map((c) => ({
    key: c.key, heroId: c.heroId, position: c.position, enemyHeroId: c.enemyHeroId,
    matches: c.matches.size, wins: c.wins, losses: c.losses, uniqueItems: c.uniqueItems.size,
  }));
  out.sort((a, b) => b.matches - a.matches || a.key.localeCompare(b.key));
  return out;
}

/** §15 — `Hero × Position × Enemy × Item`: raw presence counts. */
export function aggregateItemCells(itemRows) {
  const cells = new Map();
  for (const r of itemRows ?? []) {
    const k = cellItemKey(r);
    let c = cells.get(k);
    if (!c) {
      c = { key: k, heroId: r.heroId, position: r.position, enemyHeroId: r.enemyHeroId, itemId: r.itemId, matches: new Set(), winsWithItem: 0, lossesWithItem: 0 };
      cells.set(k, c);
    }
    c.matches.add(r.matchId);
    if (r.isVictory === true) c.winsWithItem += 1;
    else if (r.isVictory === false) c.lossesWithItem += 1;
  }
  const out = [...cells.values()].map((c) => ({
    key: c.key, heroId: c.heroId, position: c.position, enemyHeroId: c.enemyHeroId, itemId: c.itemId,
    matchesWithItem: c.matches.size, winsWithItem: c.winsWithItem, lossesWithItem: c.lossesWithItem,
  }));
  out.sort((a, b) => b.matchesWithItem - a.matchesWithItem || a.key.localeCompare(b.key));
  return out;
}

/** §17 — `Hero × Position` support, the unit the enemy layer is built on. */
export function aggregateHeroPosition(heroEnemyRows) {
  const cells = new Map();
  for (const r of heroEnemyRows ?? []) {
    const k = hpKey(r);
    let c = cells.get(k);
    if (!c) { c = { key: k, heroId: r.heroId, position: r.position, matches: new Set() }; cells.set(k, c); }
    c.matches.add(r.matchId);
  }
  return [...cells.values()]
    .map((c) => ({ key: c.key, heroId: c.heroId, position: c.position, matches: c.matches.size }))
    .sort((a, b) => b.matches - a.matches || a.key.localeCompare(b.key));
}

/** §16 — the headline number: how the cells distribute across support bins. */
export function bucketSupport(cells, bins, valueOf = (c) => c.matches) {
  const counts = bins.map((b) => ({ ...b, max: b.max === Infinity ? null : b.max, cells: 0, observations: 0 }));
  for (const c of cells ?? []) {
    const v = valueOf(c);
    const bin = counts.find((b) => v >= b.min && (b.max === null ? true : v <= b.max));
    if (bin) { bin.cells += 1; bin.observations += v; }
  }
  return counts;
}

/** §19 — per rank bucket, counts only. Keys are strings, always. */
export function splitByRank(rows, field = 'bucket') {
  const out = new Map();
  for (const r of rows ?? []) {
    const v = r?.[field];
    const k = v === null || v === undefined ? 'unknown' : String(v);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

/** §20 — per game mode, counts only. */
export function splitByMode(rows) {
  return splitByRank(rows, 'mode');
}

/**
 * §18 — does a positional cell exist in the production ontology?
 *
 * Reads the committed STRATZ-derived `positions.json` and reports whether the
 * hero × position pair has production support. It never WRITES to production
 * and never changes eligibility; it only measures the intersection.
 */
export function ontologyIntersection(heroPositionCells, positionsJson) {
  const known = { known: 0, unknown: 0, unknownKeys: [] };
  for (const c of heroPositionCells ?? []) {
    const hero = positionsJson?.[String(c.heroId)];
    const pos = hero?.positions?.[String(c.position)];
    if (pos && (pos.games ?? 0) > 0) known.known += 1;
    else { known.unknown += 1; if (known.unknownKeys.length < 12) known.unknownKeys.push(c.key); }
  }
  return known;
}

/** §26 — overlap between two discovery halves, as a set comparison. */
export function cellOverlap(a, b, keyOf = (c) => c.key) {
  const sa = new Set((a ?? []).map(keyOf));
  const sb = new Set((b ?? []).map(keyOf));
  let inter = 0;
  for (const k of sa) if (sb.has(k)) inter += 1;
  return { a: sa.size, b: sb.size, shared: inter, jaccard: sa.size + sb.size - inter ? inter / (sa.size + sb.size - inter) : null };
}

/**
 * §28.2 §5 — `bridge_ok` is not `tuple_eligible`.
 *
 * A hydrated match can still be unfit for Level-2 tuples: a non-exact roster
 * means the two sources disagree about who played, so every relation derived
 * from it is suspect. The pilot happened to see 310/310 exact rosters, so this
 * gate has never actually fired; it exists so the next run cannot quietly
 * admit a broken roster.
 */
export function isTupleEligible(match) {
  return Boolean(match?.ok) && match?.rosterExact === true;
}

/** §28.2 §5 — a match may only feed RESULT aggregates if both sources agree. */
export function isResultClean(match) {
  return isTupleEligible(match) && (match.resultChecked ?? 0) > 0 && (match.resultMismatches ?? 0) === 0;
}

/** §28.2 §5 — likewise for ITEM aggregates. */
export function isItemClean(match) {
  return isTupleEligible(match) && (match.itemCompared ?? 0) > 0 && (match.itemMismatch ?? 0) === 0;
}

/**
 * §28.2 §1 — A/B is a split of MATCHES, never of expanded player x enemy rows.
 *
 * Splitting `heRows` in half cuts inside the match expansion: 50 rows are
 * emitted per match, so a row split is not a match split and can even land
 * mid-match. The halves must be whole matches, in selection order.
 */
export function splitMatchesAB(matches) {
  const list = matches ?? [];
  const half = Math.floor(list.length / 2);
  return { a: list.slice(0, half), b: list.slice(half), n: list.length, half };
}

/**
 * §28.2 §2/§3 — compare A and B on the MATCH grain, per bucket.
 *
 * Cells come from the canonical aggregators; nothing here re-derives a cell or
 * slices an expanded row array.
 */
export function compareAB(matches, playersByMatch, inventoryByMatch) {
  const { a, b, n, half } = splitMatchesAB(matches);
  const build = (ms) => {
    const { rows } = buildHeroEnemyRows(ms, playersByMatch);
    const itemRows = buildItemRows(rows, inventoryByMatch);
    return {
      rows: rows.length,
      hpCells: aggregateHeroPosition(rows),
      hpeCells: aggregateSupport(rows, itemRows),
    };
  };
  const A = build(a);
  const B = build(b);
  return {
    n, half,
    aMatches: a.length, bMatches: b.length,
    aRows: A.rows, bRows: B.rows,
    hp: cellOverlap(A.hpCells, B.hpCells),
    hpe: cellOverlap(A.hpeCells, B.hpeCells),
  };
}

/** §14 — a support summary WITHOUT any rate, for the verdict to read. */
export function supportSummary(cells, floor) {
  const kept = (cells ?? []).filter((c) => c.matches >= floor);
  const observations = kept.reduce((a, c) => a + c.matches, 0);
  return { floor, cellsKept: kept.length, cellsTotal: (cells ?? []).length, observations };
}