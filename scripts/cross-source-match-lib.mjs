/**
 * Cross-source match bridge — pure helpers (ТЗ §27).
 *
 * The question this file exists to answer: can match ids discovered through
 * OpenDota's rank-filtered `/publicMatches` be hydrated from STRATZ, so that
 * `position`, `enemy`, `items` and `result` all arrive for the SAME match —
 * without waiting for OpenDota's parser, whose availability measured ~2%?
 *
 * No network and no filesystem here. Everything is a pure function so the
 * bridge's failure modes are unit-testable rather than discovered during a
 * crawl.
 *
 * The helper is deliberately free of any `winrate`, `lift`, `score` or
 * recommendation vocabulary. This study measures whether a bridge EXISTS; it
 * does not score anything.
 */

/** §21 — exhaustive failure taxonomy. Nothing collapses into "failed". */
export const BRIDGE_FAILURE = {
  DISCOVERY_FAILED: 'DISCOVERY_FAILED',
  OPENDOTA_DETAIL_FAILED: 'OPENDOTA_DETAIL_FAILED',
  STRATZ_NOT_FOUND: 'STRATZ_NOT_FOUND',
  STRATZ_HTTP_ERROR: 'STRATZ_HTTP_ERROR',
  STRATZ_GRAPHQL_ERROR: 'STRATZ_GRAPHQL_ERROR',
  INVALID_ROSTER: 'INVALID_ROSTER',
  POSITION_MISSING: 'POSITION_MISSING',
  ROSTER_MISMATCH: 'ROSTER_MISMATCH',
  RESULT_MISMATCH: 'RESULT_MISMATCH',
  ITEM_MISMATCH: 'ITEM_MISMATCH',
  TIMING_UNAVAILABLE: 'TIMING_UNAVAILABLE',
};

/** §5 — the ONE query this study is allowed to send. Read-only, no mutations. */
export const STRATZ_MATCH_QUERY = `query CrossSourceMatch($id: Long!) {
  match(id: $id) {
    id
    didRadiantWin
    durationSeconds
    gameMode
    lobbyType
    averageRank
    players {
      heroId
      position
      isRadiant
      isVictory
      item0Id item1Id item2Id item3Id item4Id item5Id
      backpack0Id backpack1Id backpack2Id
      neutral0Id
    }
  }
}`;

/**
 * §26 — a read-only guard, checked by a unit test against the query above.
 *
 * GraphQL is served over POST, so "no POST" cannot be enforced at the HTTP
 * layer. What CAN be enforced is that the payload never mutates anything: no
 * mutation operation, no mutation field name. If this ever trips, the study has
 * silently acquired a write path.
 */
export function assertReadOnlyQuery(query) {
  const problems = [];
  if (/\bmutation\b/i.test(query)) problems.push('query declares a mutation operation');
  for (const field of ['createMatch', 'updateMatch', 'deleteMatch', 'bulkCreate', 'mutate']) {
    if (new RegExp(`\\b${field}\\b`, 'i').test(query)) problems.push(`query references mutation field "${field}"`);
  }
  if (problems.length) throw new Error(`STRATZ query is not read-only: ${problems.join('; ')}`);
  return true;
}

/**
 * §9 — STRATZ reports `position` as `POSITION_1..POSITION_5`.
 *
 * Returns null for anything outside 1..5, including `POSITION_UNKNOWN` and
 * null. Coverage is measured rather than imputed, so an unusable value must
 * stay null instead of defaulting to 0 or 1.
 */
export function parseStratzPosition(raw) {
  if (raw === null || raw === undefined) return null;
  const m = String(raw).match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

/**
 * §8 — a roster is identified by (heroId, side), NEVER by player order.
 * OpenDota and STRATZ list players in different orders, and position ordering
 * is the whole point of the bridge, so order is not an identity.
 */
export function extractRosterKey(player) {
  const heroId = player?.heroId ?? null;
  if (heroId === null) return null;
  const side = player?.isRadiant ? 'R' : 'D';
  return `${heroId}:${side}`;
}

export function rosterKeys(players) {
  return (players ?? []).map(extractRosterKey).filter(Boolean);
}

/**
 * §8 — exact roster comparison as multisets.
 *
 * Returns which side lost which heroes so a mismatch is reportable rather
 * than merely flagged.
 */
export function sameRoster(openDotaPlayers, stratzPlayers) {
  const od = rosterKeys(openDotaPlayers);
  const st = rosterKeys(stratzPlayers);
  const tally = (list) => {
    const m = new Map();
    for (const k of list) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const a = tally(od);
  const b = tally(st);
  const keys = new Set([...a.keys(), ...b.keys()]);
  const missingInStratz = [];
  const missingInOpenDota = [];
  for (const k of keys) {
    // d > 0 means STRATZ has MORE copies than OpenDota, so OpenDota is the one
    // that is missing an occurrence. Getting this sign backwards reported
    // "missing in STRATZ" for players STRATZ was perfectly fine without.
    const d = (b.get(k) ?? 0) - (a.get(k) ?? 0);
    if (d > 0) missingInOpenDota.push(k);
    if (d < 0) missingInStratz.push(k);
  }
  return {
    exact: missingInStratz.length === 0 && missingInOpenDota.length === 0,
    missingInStratz,
    missingInOpenDota,
    openDotaCount: od.length,
    stratzCount: st.length,
  };
}
/**
 * §11 — enemy reconstruction from sides.
 *
 * Only defined once the roster is exact: with a mismatched roster the enemy
 * list is unknowable, and guessing would fabricate the exact relation the
 * bridge is supposed to establish.
 */
export function extractEnemies(stratzPlayers, player) {
  if (!stratzPlayers || !player) return null;
  const rosterOk = stratzPlayers.length === 10
    && stratzPlayers.filter((p) => p?.isRadiant).length === 5;
  if (!rosterOk) return null;
  return stratzPlayers
    .filter((p) => Boolean(p?.isRadiant) !== Boolean(player.isRadiant))
    .map((p) => p?.heroId)
    .filter((h) => h !== null && h !== undefined);
}

/**
 * §10 — team structure and position layout, RECORDED as an observation.
 *
 * "Exactly one of each position 1..5" is NOT a validity rule. Real matches can
 * read `1,2,3,4,4`; that must be captured as a finding, not rejected.
 */
export function validatePositions(stratzPlayers) {
  const players = stratzPlayers ?? [];
  const parsed = players.map((p) => parseStratzPosition(p?.position));
  const covered = parsed.filter((x) => x !== null).length;
  const perTeam = {};
  for (const side of [true, false]) {
    const sidePositions = players.filter((p) => Boolean(p?.isRadiant) === side)
      .map((p) => parseStratzPosition(p?.position));
    const counts = {};
    for (const x of sidePositions) {
      const k = x === null ? 'null' : x;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    perTeam[side ? 'R' : 'D'] = {
      size: sidePositions.length,
      counts,
      missing: [1, 2, 3, 4, 5].filter((n) => !sidePositions.includes(n)),
      duplicated: Object.entries(counts).filter(([, v]) => v > 1).map(([k, v]) => `${k}x${v}`),
    };
  }
  const distribution = {};
  for (const x of parsed) {
    const k = x === null ? 'null' : String(x);
    distribution[k] = (distribution[k] ?? 0) + 1;
  }
  return {
    total: players.length,
    covered,
    missing: players.length - covered,
    coveragePct: players.length ? (100 * covered) / players.length : null,
    distribution,
    perTeam,
    radiant: perTeam.R.size,
    dire: perTeam.D.size,
    teamsBalanced: perTeam.R.size === 5 && perTeam.D.size === 5,
    allPositionsDistinctPerTeam: [perTeam.R, perTeam.D].every((t) => t.duplicated.length === 0 && t.missing.length === 0),
  };
}

/** §12 — inventory, backpack and neutrals stay SEPARATE. */
export function splitInventory(player) {
  const pick = (prefix, count, i) => {
    const v = player?.[`${prefix}${i}Id`];
    return v === 0 || v === null || v === undefined ? null : v;
  };
  const neutral = player?.neutral0Id;
  return {
    finalInventory: [0, 1, 2, 3, 4, 5].map((i) => pick('item', 6, i)).filter((x) => x !== null),
    backpack: [0, 1, 2].map((i) => pick('backpack', 3, i)).filter((x) => x !== null),
    neutral: neutral === 0 || neutral === null || neutral === undefined ? null : neutral,
  };
}

/**
 * §13 — compare final items as a MULTISET.
 *
 * Slot order is not guaranteed to agree between sources and carries no
 * meaning here, so a positional diff would report differences that are not
 * differences.
 */
export function inventoryMultiset(a, b) {
  const tally = (list) => {
    const m = new Map();
    for (const x of list ?? []) if (x !== null && x !== undefined) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const ta = tally(a);
  const tb = tally(b);
  const keys = new Set([...ta.keys(), ...tb.keys()]);
  if (keys.size === 0) return { status: 'exact', onlyInOpenDota: [], onlyInStratz: [], symmetricDiff: 0 };
  let symmetricDiff = 0;
  for (const k of keys) symmetricDiff += Math.abs((ta.get(k) ?? 0) - (tb.get(k) ?? 0));
  if (symmetricDiff === 0) return { status: 'exact', onlyInOpenDota: [], onlyInStratz: [], symmetricDiff: 0 };
  const disagreeing = [...keys].filter((k) => (ta.get(k) ?? 0) !== (tb.get(k) ?? 0));
  const total = [...ta.values()].reduce((x, y) => x + y, 0);
  const status = symmetricDiff >= total ? 'complete_mismatch' : 'partial_mismatch';
  return {
    status,
    onlyInOpenDota: disagreeing.filter((k) => (ta.get(k) ?? 0) > (tb.get(k) ?? 0)),
    onlyInStratz: disagreeing.filter((k) => (tb.get(k) ?? 0) > (ta.get(k) ?? 0)),
    symmetricDiff,
  };
}

/**
 * §14 — OpenDota's view of who won, derived from `radiant_win` and
 * `player_slot` (slots 0-4 are Radiant, 128-132 are Dire).
 */
export function resultFromOpenDota(player, radiantWin) {
  const slot = player?.player_slot;
  if (typeof slot !== 'number' || typeof radiantWin !== 'boolean') return null;
  return slot < 128 ? radiantWin : !radiantWin;
}

/** §21 — map an outcome onto the taxonomy, one reason at a time. */
export function classifyBridgeFailure(input) {
  if (!input?.ok) return input?.reason ?? BRIDGE_FAILURE.STRATZ_NOT_FOUND;
  if (!input.rosterExact) return BRIDGE_FAILURE.ROSTER_MISMATCH;
  if (!input.positions?.covered) return BRIDGE_FAILURE.POSITION_MISSING;
  if (input.resultMismatches > 0) return BRIDGE_FAILURE.RESULT_MISMATCH;
  if (input.itemMismatch > 0) return BRIDGE_FAILURE.ITEM_MISMATCH;
  return null;
}