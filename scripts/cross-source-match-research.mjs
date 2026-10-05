#!/usr/bin/env node
/**
 * ТЗ §27 — cross-source match bridge feasibility (GET-first pilot).
 *
 *   node scripts/cross-source-match-research.mjs plan
 *   node scripts/cross-source-match-research.mjs all
 *
 * Question: OpenDota's `/publicMatches` gives global rank-filtered discovery and
 * a match_id. STRATZ gives position, teams, result and final items for a match_id.
 * Can the two be joined for the SAME match — without waiting on OpenDota's
 * parser, whose availability measured ~2% in ТЗ №26?
 *
 * Nothing here is production code. No dataset is written, no scoring is
 * attempted, and there is deliberately no `winrate`, `lift`, `core`, `mustBuy`
 * or `recommended` anywhere in this study.
 *
 * ── On POST vs GET ──────────────────────────────────────────────────────────
 * OpenDota is accessed with GET only. STRATZ GraphQL is not: the query travels
 * in a request BODY, so the API requires POST, and the endpoint sits behind a
 * Cloudflare challenge that rejects plain `fetch` (403 "Just a moment…") for
 * BOTH verbs. There is no GET equivalent to substitute.
 *
 * This was an explicit scope deviation, authorised as read-only. "Read-only"
 * is enforced in code, not by convention: the single query this script sends
 * lives in `STRATZ_MATCH_QUERY`, is asserted mutation-free by
 * `assertReadOnlyQuery()`, and a unit test fails the build if this file ever
 * contains the word "mutation" or an inline GraphQL string. A GraphQL `query`
 * has no side effects; nothing is created, changed or deleted on STRATZ.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROAD_BUCKETS as BUCKETS, broadBucketOf, bracketLabel } from './opendota/rank-buckets.mjs';
import { StratzTransport } from './update-data-stratz.mjs';
import {
  BRIDGE_FAILURE,
  STRATZ_MATCH_QUERY,
  assertReadOnlyQuery,
  classifyBridgeFailure,
  extractEnemies,
  inventoryMultiset,
  parseStratzPosition,
  resultFromOpenDota,
  sameRoster,
  splitInventory,
  validatePositions,
} from './cross-source-match-lib.mjs';

// §26 — refuse to run at all if the query is not read-only.
assertReadOnlyQuery(STRATZ_MATCH_QUERY);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPENDOTA = 'https://api.opendota.com/api';
const CACHE = '/tmp/opendota-cross-source-research';
mkdirSync(CACHE, { recursive: true });

/** §3 — a small, pre-declared sample. Not enlarged after seeing the data. */
const PER_BUCKET = 6;
const MAX_PAGES_PER_BUCKET = 12;

/**
 * §23 — discovery starts at a DECLARED cursor, not at the newest matches.
 *
 * Measured, not assumed: STRATZ returned `match: null` for every id from the
 * first pages of `/publicMatches`, while an older id hydrated with all 10
 * players. STRATZ ingests on a lag, so a sample taken from the live head of
 * `/publicMatches` would score 0% and prove nothing about the bridge.
 *
 * A bisection put the ingest frontier at roughly `9_029_947_349` (present) to
 * `9_029_977_049` (absent). The cursor below sits safely inside the ingested
 * region. It is a PARAMETER OF THE METHOD, reported in the output: a hit rate
 * measured here applies to matches of this age, not to matches that finished
 * five minutes ago. Override with `--cursor=<matchId>` to re-measure.
 */
const DEFAULT_DISCOVERY_CURSOR = 9029900000;

const cursorArg = process.argv.find((a) => a.startsWith('--cursor='));
const DISCOVERY_CURSOR = cursorArg ? Number(cursorArg.split('=')[1]) : DEFAULT_DISCOVERY_CURSOR;

const MODE_NAMES = { 1: 'All Pick', 2: 'Captains Mode', 13: 'All Pick (13)', 22: 'All Draft', 23: 'Turbo' };
const modeLabel = (id) => MODE_NAMES[id] ?? (typeof id === 'string' ? id : `mode_${id}`);

/**
 * §7 — STRATZ reports enums (`ALL_PICK_RANKED`, `RANKED`), OpenDota reports
 * numbers (22, 7). The mapping is NOT guessed: the report prints both raw
 * values and only compares them through this explicit table, so an unmapped
 * pair is reported as a mapping gap rather than silently called a mismatch.
 */
const STRATZ_MODE_TO_OD = {
  ALL_PICK: 1, ALL_PICK_RANKED: 1, ALL_DRAFT: 22, ALL_DRAFT_RANKED: 22,
  CAPTAINS_MODE: 2, CAPTAINS_MODE_RANKED: 2, TURBO: 23, ARENA: 24, ASSAULT: 25,
};
const STRATZ_LOBBY_TO_OD = { RANKED: 7, CASUAL: 0, COOP: 1, TUTORIAL: 2, BATTLE_CUP: 8 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => process.stderr.write(`${a.join(' ')}\n`);

/** §26 — env first, then .env. The token is never written to cache or logs. */
function loadToken() {
  const fromEnv = process.env.STRATZ_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*STRATZ_API_TOKEN\s*=\s*(.*?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  } catch { /* no .env */ }
  return null;
}

/** OpenDota is paced; STRATZ goes through the shared browser transport. */
let lastOdRequest = 0;
async function odGet(url) {
  const f = path.join(CACHE, url.replace(/^https?:\/\/[^/]+/, '').replace(/[^a-z0-9]+/gi, '_').slice(-150) + '.json');
  if (existsSync(f)) return { ok: true, cached: true, data: JSON.parse(readFileSync(f, 'utf8')) };
  for (let a = 1; a <= 4; a += 1) {
    const gap = 1300 - (Date.now() - lastOdRequest);
    if (gap > 0) await sleep(gap);
    lastOdRequest = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (res.status === 429) { await sleep(6000 * a); continue; }
      if (!res.ok) return { ok: false, reason: BRIDGE_FAILURE.OPENDOTA_DETAIL_FAILED };
      const json = await res.json();
      if (json && json.error) return { ok: false, reason: BRIDGE_FAILURE.OPENDOTA_DETAIL_FAILED };
      writeFileSync(f, JSON.stringify(json));
      return { ok: true, cached: false, data: json };
    } catch {
      if (a === 4) return { ok: false, reason: BRIDGE_FAILURE.OPENDOTA_DETAIL_FAILED };
      await sleep(2000 * a);
    }
  }
  return { ok: false, reason: BRIDGE_FAILURE.OPENDOTA_DETAIL_FAILED };
}

/**
 * §2/§3/§23 — rank-filtered discovery, taken from the FIRST eligible rows.
 *
 * No hand-picking and no "matches STRATZ probably has": selecting the sample
 * by anything other than rank would bias the very hit rate §6 measures.
 */
async function discover(startCursor) {
  const picked = [];
  const rejected = {};
  let cursor = startCursor;
  for (let page = 0; page < MAX_PAGES_PER_BUCKET; page += 1) {
    const res = await odGet(`${OPENDOTA}/publicMatches?less_than_match_id=${cursor}`);
    if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) break;
    for (const m of res.data) {
      if (typeof m?.avg_rank_tier !== 'number') continue;
      const bucket = broadBucketOf(m.avg_rank_tier);
      if (!bucket) continue;
      // §1 — `leagueid` is already on the discovery row, so a league or pro
      // match can be rejected at SELECTION. Checking it only after hydration
      // let a non-public match occupy one of the six bucket slots before being
      // discarded, quietly shrinking the sample. A missing `leagueid` is
      // "unknown", which is not eligible.
      if (m.leagueid !== 0) {
        rejected.league = (rejected.league ?? 0) + 1;
        if (m.leagueid === null || m.leagueid === undefined) rejected.leagueUnknown = (rejected.leagueUnknown ?? 0) + 1;
        continue;
      }
      if (picked.filter((p) => p.bucket === bucket.key).length >= PER_BUCKET) continue;
      rejected.full = (rejected.full ?? 0) + 1;
      picked.push({
        matchId: m.match_id,
        avgRankTier: m.avg_rank_tier,
        bucket: bucket.key,
        bracket: bracketLabel(m.avg_rank_tier),
        leagueid: m.leagueid,
        startTime: m.start_time ?? null,
      });
    }
    if (BUCKETS.every((b) => picked.filter((p) => p.bucket === b.key).length >= PER_BUCKET)) break;
    const ids = res.data.map((r) => r.match_id).filter((x) => typeof x === 'number');
    if (!ids.length) break;
    cursor = Math.min(...ids);
  }
  return { picked, rejected };
}

/** §4 — OpenDota baseline for the same match ids. Not an authoritative rank source. */
async function hydrateOpenDota(picked) {
  const out = [];
  for (const row of picked) {
    const res = await odGet(`${OPENDOTA}/matches/${row.matchId}`);
    const d = res.ok ? res.data : null;
    out.push({
      ...row,
      ok: Boolean(d),
      leagueid: d?.leagueid ?? null,
      gameMode: d?.game_mode ?? null,
      lobbyType: d?.lobby_type ?? null,
      duration: d?.duration ?? null,
      radiantWin: typeof d?.radiant_win === 'boolean' ? d.radiant_win : null,
      hasApi: Boolean(d && Object.keys(d).length),
      hasGcdata: Boolean(d?.od_data),
      hasParsed: d?.od_data?.has_parsed === true,
      players: d?.players ?? [],
    });
  }
  return out;
}

/** §5/§6 — one STRATZ hydration, typed by outcome. */
async function hydrateStratz(transport, matchId) {
  try {
    const res = await transport.query(STRATZ_MATCH_QUERY, { id: matchId });
    const m = res?.data?.match;
    if (!m) return { ok: false, reason: BRIDGE_FAILURE.STRATZ_NOT_FOUND, match: null };
    // §3 — the bridge joins id to id. A response for a different match is not
    // a success with odd data, it is a failed join: accepting it would let one
    // match's players be attributed to another match's row.
    if (Number(m.id) !== Number(matchId)) {
      return { ok: false, reason: BRIDGE_FAILURE.STRATZ_ID_MISMATCH, match: null };
    }
    return { ok: true, reason: null, match: m };
  } catch (e) {
    const msg = String(e?.message ?? '');
    const reason = /429/.test(msg) ? BRIDGE_FAILURE.STRATZ_HTTP_ERROR
      : /GraphQL errors/i.test(msg) ? BRIDGE_FAILURE.STRATZ_GRAPHQL_ERROR
        : BRIDGE_FAILURE.STRATZ_HTTP_ERROR;
    return { ok: false, reason, match: null };
  }
}

/**
 * §7/§8/§9/§10/§12/§13/§14 — cross-check one match.
 *
 * Every disagreement is RECORDED rather than resolved: a mismatch here is a
 * measurement about source agreement, not a defect to be papered over.
 */
function bridgeMatch(od, st) {
  const m = st.match;
  const players = m?.players ?? [];
  // OpenDota players expose `hero_id` / `player_slot`; STRATZ exposes
  // `heroId` / `isRadiant`. Normalising here is what lets one roster key serve
  // both sources — reading `heroId` off an OpenDota player silently yields 0
  // matches for every match.
  const odRoster = (od.players ?? [])
    .filter((p) => p?.hero_id !== undefined)
    .map((p) => ({
      // Keep the ORIGINAL OpenDota player: `player_slot`, `item_0..item_5` and
      // `radiant_win` live on it, and the result and item cross-checks read
      // from there. A stripped-down {heroId, isRadiant} made both of them
      // compare against nothing and report a unanimous 100% mismatch.
      src: p,
      heroId: p.hero_id,
      isRadiant: (p.player_slot ?? 0) < 128,
    }));
  const roster = sameRoster(odRoster, players);
  const positions = validatePositions(players);

  // §7 — mode/lobby are compared only through the explicit mapping table.
  const odMode = od.gameMode;
  const stMode = m?.gameMode ?? null;
  const mappedMode = stMode === null ? null : (STRATZ_MODE_TO_OD[stMode] ?? null);
  const odLobby = od.lobbyType;
  const stLobby = m?.lobbyType ?? null;
  const mappedLobby = stLobby === null ? null : (STRATZ_LOBBY_TO_OD[stLobby] ?? null);
  const modeComparable = mappedMode !== null && odMode !== null;
  const lobbyComparable = mappedLobby !== null && odLobby !== null;

  // §14 — result agreement, player by player.
  const odByKey = new Map();
  for (const p of odRoster) odByKey.set(`${p.heroId}:${p.isRadiant ? 'R' : 'D'}`, p.src);

  let resultChecked = 0;
  let resultMismatches = 0;
  let itemCompared = 0;
  let itemMismatch = 0;
  const itemStatuses = [];

  for (const sp of players) {
    const key = `${sp?.heroId}:${sp?.isRadiant ? 'R' : 'D'}`;
    const op = odByKey.get(key);
    if (!op) continue;

    const odWin = resultFromOpenDota(op, od.radiantWin);
    if (odWin !== null && typeof sp.isVictory === 'boolean') {
      resultChecked += 1;
      if (odWin !== sp.isVictory) resultMismatches += 1;
    }

    const odItems = [0, 1, 2, 3, 4, 5]
      .map((i) => op[`item_${i}`])
      .filter((x) => typeof x === 'number' && x > 0);
    const stItems = splitInventory(sp).finalInventory;
    if (odItems.length || stItems.length) {
      itemCompared += 1;
      const cmp = inventoryMultiset(odItems, stItems);
      itemStatuses.push(cmp.status);
      if (cmp.status !== 'exact') itemMismatch += 1;
    }
  }

  const failure = classifyBridgeFailure({
    ok: st.ok,
    reason: st.reason,
    rosterExact: roster.exact,
    positions,
    resultMismatches,
    itemMismatch,
  });

  return {
    matchId: od.matchId,
    bucket: od.bucket,
    bracket: od.bracket,
    ok: st.ok,
    reason: st.reason,
    failure,
    stratzMatchId: m?.id ?? null,
    stratzDuration: m?.durationSeconds ?? null,
    stratzAverageRank: m?.averageRank ?? null,
    didRadiantWin: m?.didRadiantWin ?? null,
    mode: {
      openDota: odMode, stratz: stMode, mappedStratz: mappedMode,
      openDotaLabel: modeLabel(odMode), stratzLabel: modeLabel(stMode),
      comparable: modeComparable,
      mismatch: modeComparable ? mappedMode !== odMode : null,
    },
    lobby: {
      openDota: odLobby, stratz: stLobby, mappedStratz: mappedLobby,
      comparable: lobbyComparable,
      mismatch: lobbyComparable ? mappedLobby !== odLobby : null,
    },
    roster,
    positions,
    resultChecked,
    resultMismatches,
    itemCompared,
    itemMismatch,
    itemStatuses,
    openDota: {
      leagueid: od.leagueid, hasApi: od.hasApi, hasGcdata: od.hasGcdata, hasParsed: od.hasParsed,
    },
  };
}

/** §11/§17/§18 — the raw tuple this bridge exists to make possible. */
function playerRows(bridged, stMatchById) {
  const rows = [];
  for (const b of bridged) {
    if (!b.ok || !b.roster.exact) continue;
    const players = stMatchById.get(b.matchId)?.players ?? [];
    if (players.length !== 10) continue;
    for (const sp of players) {
      const position = parseStratzPosition(sp?.position);
      const enemies = extractEnemies(players, sp);
      const inv = splitInventory(sp);

      // §2 — a row with no position is kept, but it contributes NO cells.
      // Emitting `Hero|"null"|Enemy` would have counted an unknown position as
      // a distinct relational key and handed the next study a support figure
      // for a position that was never observed.
      const positional = position !== null && enemies !== null;
      const cells = [];
      const itemCells = [];
      if (positional) {
        for (const e of enemies) cells.push(`${sp.heroId}|${position}|${e}`);
        for (const e of enemies) {
          for (const it of inv.finalInventory) itemCells.push(`${sp.heroId}|${position}|${e}|${it}`);
        }
      }
      rows.push({
        matchId: b.matchId,
        heroId: sp?.heroId ?? null,
        position,
        positionRaw: sp?.position ?? null,
        positional,
        isRadiant: Boolean(sp?.isRadiant),
        isVictory: typeof sp?.isVictory === 'boolean' ? sp.isVictory : null,
        enemyHeroIds: enemies,
        finalInventory: inv.finalInventory,
        backpack: inv.backpack,
        neutral: inv.neutral,
        cells,
        itemCells,
      });
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ report */

const pct1 = (x) => (x === null || x === undefined ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const H = (t) => `\n=== ${t} ===`;
const layer = (name, n, total) => `  ${name.padEnd(28)} ${String(n).padStart(4)} / ${total}   ${total ? pct1(n / total) : 'n/a'}`;

function printReport(state) {
  const { bridged, rows } = state;
  const o = [];
  const p = (s = '') => o.push(s);
  const total = bridged.length;
  const ok = bridged.filter((b) => b.ok);

  p(H('Bridge feasibility (ТЗ §27)'));
  p(`requested       : ${total}`);
  p(`stratz_match_ok : ${ok.length}`);
  p(`hit rate        : ${total ? pct1(ok.length / total) : 'n/a'}`);
  const rej = state.rejected ?? {};
  p(`selection       : leagueid !== 0 rejected at discovery = ${rej.league ?? 0}${rej.leagueUnknown ? ` (of which leagueid missing/unknown: ${rej.leagueUnknown})` : ''}`);

  p(H('Failure taxonomy (§21)'));
  const reasons = {};
  for (const b of bridged) {
    const k = b.failure ?? 'NONE';
    reasons[k] = (reasons[k] ?? 0) + 1;
  }
  for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) p(`  ${k.padEnd(26)} ${v}`);

  p(H('Population integrity (§7)'));
  const modeCmp = ok.filter((b) => b.mode.comparable);
  const lobbyCmp = ok.filter((b) => b.lobby.comparable);
  p(`mode comparable  : ${modeCmp.length}/${ok.length}   mismatched: ${modeCmp.filter((b) => b.mode.mismatch).length}`);
  p(`lobby comparable : ${lobbyCmp.length}/${ok.length}   mismatched: ${lobbyCmp.filter((b) => b.lobby.mismatch).length}`);
  const rawModes = new Set(ok.map((b) => `${b.mode.openDota}:${b.mode.stratz}`));
  p(`mode pairs (openDota:stratz): ${[...rawModes].sort().join(', ') || 'n/a'}`);
  p('unmapped STRATZ values are reported, never silently called a match.');
  p(`STRATZ averageRank null: ${ok.filter((b) => b.stratzAverageRank === null).length}/${ok.length}  (rank stays from OpenDota discovery, §2)`);

  p(H('Roster cross-check (§8)'));
  p(`  exact match : ${ok.filter((b) => b.roster.exact).length}/${ok.length}`);
  for (const b of ok.filter((x) => !x.roster.exact)) {
    p(`  match ${b.matchId}: missingInStratz=[${b.roster.missingInStratz}] missingInOpenDota=[${b.roster.missingInOpenDota}]`);
  }

  p(H('Position coverage (§9/§10)'));
  const posMatches = ok.filter((b) => b.positions.covered > 0);
  p(`  matches with any position : ${posMatches.length}/${ok.length}`);
  if (posMatches.length) {
    const cov = posMatches.map((b) => b.positions.covered);
    p(`  players with position     : ${cov.join(', ')} of 10`);
    p(`  matches at 10/10          : ${cov.filter((c) => c === 10).length}/${posMatches.length}`);
    p(`  matches below 10/10       : ${cov.filter((c) => c < 10).length}/${posMatches.length}  -> POSITION_MISSING`);
  }
  p(`  teams balanced 5v5        : ${ok.filter((b) => b.positions.teamsBalanced).length}/${ok.length}`);
  p(`  distinct 1..5 per team    : ${ok.filter((b) => b.positions.allPositionsDistinctPerTeam).length}/${ok.length}  (recorded, NOT a validity rule)`);
  const dist = {};
  for (const b of ok) for (const [k, v] of Object.entries(b.positions.distribution)) dist[k] = (dist[k] ?? 0) + v;
  p(`  position distribution: ${Object.entries(dist).sort().map(([k, v]) => `${k}=${v}`).join('  ') || 'n/a'}`);
  for (const b of ok.filter((x) => !x.positions.allPositionsDistinctPerTeam && x.positions.covered > 0)) {
    p(`  match ${b.matchId}: R dup=[${b.positions.perTeam.R.duplicated}] R missing=[${b.positions.perTeam.R.missing}] D dup=[${b.positions.perTeam.D.duplicated}] D missing=[${b.positions.perTeam.D.missing}]`);
  }

  p(H('Result cross-check (§14)'));
  const rc = ok.reduce((a, b) => a + b.resultChecked, 0);
  const rm = ok.reduce((a, b) => a + b.resultMismatches, 0);
  p(`  player rows compared : ${rc}`);
  p(`  result mismatches    : ${rm}  ${rm === 0 ? '-> sources agree on who won' : '-> RESULT_MISMATCH'}`);

  p(H('Item cross-check (§12/§13)'));
  const ic = ok.reduce((a, b) => a + b.itemCompared, 0);
  const st2 = {};
  for (const b of ok) for (const s of b.itemStatuses) st2[s] = (st2[s] ?? 0) + 1;
  p(`  player rows compared : ${ic}`);
  p(`  status               : ${Object.entries(st2).sort().map(([k, v]) => `${k}=${v}`).join('  ') || 'n/a'}`);
  p('  inventory / backpack / neutral kept SEPARATE; compared as MULTISETS.');
  p('  mismatches are measured, not attributed to either source.');

  p(H('Cross-source cells (§17)'));
  const positionalRows = rows.filter((r) => r.position !== null && r.position !== undefined);
  const nonPositional = rows.filter((r) => r.position === null || r.position === undefined);
  p(`  player rows (total)                  : ${rows.length}`);
  p(`  rows WITH a valid position (1..5)    : ${positionalRows.length}`);
  p(`  rows WITHOUT a valid position        : ${nonPositional.length}`);
  p(`  unique Hero x Position x Enemy       : ${new Set(positionalRows.flatMap((r) => r.cells)).size}`);
  p(`  unique Hero x Position x Enemy x Item: ${new Set(positionalRows.flatMap((r) => r.itemCells)).size}`);
  p('  §2/27.1: only rows with a real position contribute cells. A row without a');
  p('  position is retained above but contributes none — "null" is not a position.');
  if (rows.length && rows.some((r) => r.positional === undefined)) {
    p('  NOTE: this report came from a cache written before the 27.1 flag existed,');
    p('  so its `cells` may still contain null-position rows. Cell counts recomputed');
    p('  here are position-filtered; re-run `all` to regenerate rows under 27.1.');
  }
p(H('Rank-bucket coverage (§19)'));
  p('  bucket           discovered  stratz  validRoster  fullPosition');
  for (const bk of BUCKETS) {
    const mine = bridged.filter((b) => b.bucket === bk.key);
    const good = mine.filter((b) => b.ok);
    p(`  ${bk.label.padEnd(16)} ${String(mine.length).padStart(9)}  ${String(good.length).padStart(6)}  ${String(good.filter((b) => b.roster.exact).length).padStart(11)}  ${String(good.filter((b) => b.positions.covered === 10).length).padStart(12)}`);
  }

  p(H('Mode split (§20)'));
  const modes = new Map();
  for (const b of ok) {
    const k = `${b.mode.openDota} (${b.mode.openDotaLabel ?? '?'}) -> ${b.mode.stratz}`;
    modes.set(k, (modes.get(k) ?? 0) + 1);
  }
  for (const [k, v] of [...modes.entries()].sort((a, b) => b[1] - a[1])) {
    p(`  ${k.padEnd(48)} n=${v}${v < 30 ? '  insufficient sample' : ''}`);
  }
  p('  bridge feasibility only; no mode statistics drawn.');

  p(H('Purchase timing (§15)'));
  const parsed = bridged.filter((b) => b.openDota.hasParsed).length;
  p(`  OpenDota has_parsed : ${parsed}/${total}  (${pct1(total ? parsed / total : null)})`);
  p('  missing purchase_log does NOT invalidate a STRATZ match: the bridge under');
  p('  test delivers position + enemy + items + result; timing is enrichment.');

  p(H('Funnel (§16)'));
  // Match-level layers divide by matches; per-player layers divide by player
  // rows. Mixing the two produced a meaningless "1000%" against a match total.
  const rowTotal = rows.length;
  p(layer('OpenDota discovery', total, total));
  p(layer('OpenDota detail', bridged.filter((b) => b.openDota.leagueid !== null).length, total));
  p(layer('STRATZ match', ok.length, total));
  p(layer('10-player roster', ok.filter((b) => b.roster.exact).length, total));
  p(layer('position coverage > 0', posMatches.length, total));
  p(layer('position coverage = 10/10', ok.filter((b) => b.positions.covered === 10).length, total));
  p(layer('enemy reconstruction (rows)', rows.filter((r) => r.enemyHeroIds?.length === 5).length, rowTotal));
  p(layer('final inventory (rows)', rows.filter((r) => r.finalInventory.length > 0).length, rowTotal));
  p(layer('result (rows)', rows.filter((r) => r.isVictory !== null).length, rowTotal));
  p(layer('optional purchase_log (matches)', parsed, total));

  p(H('Verdict (§27)'));
  printVerdict(p, state);
  console.log(o.join('\n'));
}

/**
 * §27 — the verdict is derived from the layers, not chosen.
 *
 * BRIDGE_VIABLE is deliberately NOT reachable from a 24-match pilot: §28 says
 * this run cannot justify a production dataset regardless of how clean it looks,
 * so the strongest verdict available here is BRIDGE_PROMISING.
 */
function printVerdict(p, { bridged, rows }) {
  const total = bridged.length;
  const ok = bridged.filter((b) => b.ok);
  const roster = ok.filter((b) => b.roster.exact).length;
  const fullPos = ok.filter((b) => b.positions.covered === 10).length;
  const anyPos = ok.filter((b) => b.positions.covered > 0).length;
  const resultOk = ok.reduce((a, b) => a + b.resultMismatches, 0) === 0;
  const hit = total ? ok.length / total : 0;

  let verdict;
  if (total === 0) verdict = 'BRIDGE_BLOCKED';
  else if (hit === 0) verdict = 'BRIDGE_BLOCKED';
  else if (roster === 0 || anyPos === 0) verdict = 'BRIDGE_BLOCKED';
  else if (fullPos < ok.length || !resultOk) verdict = 'BRIDGE_PARTIAL';
  else verdict = 'BRIDGE_PROMISING';

  p(`VERDICT: ${verdict}`);
  p(`  stratz hydration    : ${ok.length}/${total}`);
  p(`  exact roster        : ${roster}/${ok.length}`);
  p(`  full position 10/10 : ${fullPos}/${ok.length}`);
  p(`  result agreement    : ${resultOk ? 'yes' : 'no'}`);
  if (verdict === 'BRIDGE_PROMISING') {
    p('');
    p('  This establishes that global rank-filtered discovery joins to STRATZ and');
    p('  that position + enemy + items + result arrive together for the SAME match.');
    p('  It does NOT establish anything about volume, cost, or patch stability (§28).');
    p('  No production dataset is built here (§25).');
  }
  p(`  player rows available for later work: ${rows.length}`);
}
/* -------------------------------------------------------------------- main */

const cmd = process.argv[2] ?? 'plan';
const BRIDGE_FILE = path.join(CACHE, 'bridge.json');

if (cmd === 'plan') {
  console.log(H('Cross-source match bridge — plan (ТЗ §27)'));
  console.log(`discovery source       : OpenDota /publicMatches (GET)`);
  console.log(`rank source            : discovery row avg_rank_tier -> ${BUCKETS.map((b) => `${b.label} ${b.min}-${b.max}`).join(' | ')}`);
  console.log(`authoritative rank     : OpenDota discovery row ONLY (never STRATZ averageRank, /matches rank, computed_mmr)`);
  console.log(`hydration source       : STRATZ GraphQL match(id:) — READ-ONLY query`);
  console.log(`position source        : STRATZ players[].position (never lane_role / position_est)`);
  console.log(`sample                 : ${PER_BUCKET} matches per broad bucket (max ${BUCKETS.length * PER_BUCKET} total)`);
  console.log(`max discovery pages    : ${MAX_PAGES_PER_BUCKET}`);
  console.log(`filters                : leagueid === 0, rank tier must map to a broad bucket`);
  console.log(`sample selection       : FIRST eligible discovery rows — no hand-picking (§23)`);
  console.log(`cache                  : ${CACHE}`);
  console.log('');
  console.log('POST vs GET:');
  console.log('  OpenDota is GET only.');
  console.log('  STRATZ GraphQL requires POST — the query travels in a request body, and');
  console.log('  Cloudflare rejects plain fetch for BOTH verbs. There is no GET substitute.');
  console.log('  This was authorised as READ-ONLY. The single query has no write');
  console.log('  operations, asserted at startup and covered by a unit test (§26).');
  console.log('');
  console.log('Out of scope (§25): no winrate, lift, score, core, mustBuy, recommended,');
  console.log('and no Hero + Position + Enemy + Item production dataset.');
  // `process.exitCode`, not `process.exit()`: Node does not flush a pending
  // stdout write to a pipe before an explicit exit, so `plan` printed nothing
  // when redirected to a file. Letting the process end naturally fixes it.
  process.exitCode = 0;
} else if (cmd === 'all') {
  if (existsSync(BRIDGE_FILE) && process.argv.includes('--cached')) {
    log(`[bridge] reusing ${BRIDGE_FILE}`);
    printReport(JSON.parse(readFileSync(BRIDGE_FILE, 'utf8')));
  } else {
    const token = loadToken();
    if (!token) {
      log('FATAL: STRATZ_API_TOKEN not found in environment or .env — cannot hydrate STRATZ.');
      process.exit(2);
    }
    log('[bridge] STRATZ_API_TOKEN -> REDACTED');

    const { picked, rejected } = await discover(DISCOVERY_CURSOR);
    log(`[bridge] discovery: ${picked.length} matches across ${new Set(picked.map((p) => p.bucket)).size} buckets`);
    if (picked.length === 0) {
      log('[bridge] no eligible discovery rows — stopping before any STRATZ request');
      process.exit(3);
    }

    const odRows = await hydrateOpenDota(picked);
    log(`[bridge] OpenDota detail: ${odRows.filter((r) => r.ok).length}/${odRows.length}`);

    const transport = new StratzTransport(token);
    const stMatchById = new Map();
    const bridged = [];
    try {
      await transport.init();
      for (const od of odRows) {
        const st = await hydrateStratz(transport, od.matchId);
        if (st.match) stMatchById.set(od.matchId, st.match);
        bridged.push(bridgeMatch(od, st));
      }
    } finally {
      await transport.close();
    }
    log(`[bridge] STRATZ: ${bridged.filter((b) => b.ok).length}/${bridged.length}`);

    const rows = playerRows(bridged, stMatchById);
    const state = { bridged, rows, rejected };
    writeFileSync(BRIDGE_FILE, JSON.stringify(state));
    log(`[bridge] wrote ${BRIDGE_FILE}`);
    printReport(state);
  }
  process.exitCode = 0;
} else {
  console.error(`unknown command: ${cmd}`);
  console.error('usage: node scripts/cross-source-match-research.mjs [plan|all] [--cached]');
  process.exitCode = 1;
}