/**
 * ТЗ №11 research — Item × Enemy effectiveness data.
 *
 * READ-ONLY. Touches nothing in production. Responses cached under
 * /tmp/stratz-research/cache. The token is only read from the environment and
 * is never logged, cached or written to disk.
 *
 *   node scripts/item-enemy-research.mjs stratz-schema   # §2  match-level in STRATZ?
 *   node scripts/item-enemy-research.mjs opendota         # §4  match-level in OpenDota?
 *   node scripts/item-enemy-research.mjs experiment      # §7  Sniper pos1 vs PA / Axe
 *   node scripts/item-enemy-research.mjs sample-size     # §13 what full coverage costs
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { StratzTransport, loadToken, BUCKET_SEC, BRACKETS } from './update-data-stratz.mjs';
import { getCompleteWeeklyBuckets } from './stratz/buckets.mjs';

const CACHE_DIR = '/tmp/stratz-research/cache';
const OD = 'https://api.opendota.com/api';
const WI = getCompleteWeeklyBuckets(new Date(), 4);
const heroes = JSON.parse(readFileSync('public/data/heroes.json', 'utf8'));
const idOf = (n) => {
  const h = heroes.find((x) => x.name === n);
  if (!h) throw new Error(`hero not found: ${n}`);
  return h.id;
};

function cachePath(tag) {
  mkdirSync(CACHE_DIR, { recursive: true });
  return path.join(CACHE_DIR, `${tag}.json`);
}
function readCache(tag) {
  try { return JSON.parse(readFileSync(cachePath(tag), 'utf8')); } catch { return null; }
}
function writeCache(tag, v) { writeFileSync(cachePath(tag), JSON.stringify(v)); return v; }

// ---------------------------------------------------------------- §2 STRATZ
async function stratzSchema() {
  const t = new StratzTransport(loadToken());
  await t.init();
  try {
    const root = await t.query('{ __schema { queryType { fields { name args { name type { name kind ofType { name } } } type { name kind ofType { name } } } } } }');
    console.log('=== STRATZ Query root: match-level candidates ===');
    for (const f of root.data.__schema.queryType.fields) {
      if (!/match|player|history|recent|parsed/i.test(f.name)) continue;
      const a = f.args.map((x) => `${x.name}:${x.type.name || x.type.ofType?.name}`).join(', ');
      console.log(`  ${f.name}(${a}) -> ${f.type.name || f.type.ofType?.name}`);
    }

    // Any type that carries both an item and a position — the shape we need.
    const all = await t.query('{ __schema { types { name kind fields { name } } } }');
    const types = all.data.__schema.types.filter((x) => x.kind === 'OBJECT' && x.fields);
    const scored = types
      .map((t2) => {
        const names = t2.fields.map((f) => f.name);
        const has = (re) => names.some((n) => re.test(n));
        return {
          name: t2.name,
          item: has(/^items?$|^itemIds$|purchase/i),
          pos: has(/^position|lanerole|isRadiant/i),
          hero: has(/^heroId$/i),
          result: has(/isRadiant|isWin|winner|playerWon/i),
          time: has(/^time$|purchaseTime|gameTime/i),
        };
      })
      .filter((t2) => t2.item);
    console.log('\n=== types with an item-ish field ===');
    for (const t2 of scored) {
      console.log(`  ${t2.name.padEnd(42)} item=${t2.item} pos=${t2.pos} hero=${t2.hero} result=${t2.result} time=${t2.time}`);
    }

    // §3: can a SINGLE match be fetched with per-player items, position and
    // result? If MatchType is rich enough, STRATZ would offer match-level data
    // in the same Herald→Immortal population as the rest of the pipeline.
    const mt = await t.query(`{ __type(name: "MatchType") { fields { name type { name kind ofType { name } } } } }`);
    console.log('\n=== MatchType fields ===');
    for (const f of mt.data.__type.fields) console.log(`  ${f.name}: ${f.type.name || f.type.ofType?.name}`);

    const pt = await t.query(`{ __type(name: "MatchPlayerType") { fields { name type { name kind ofType { name } } } } }`);
    console.log('\n=== MatchPlayerType fields ===');
    for (const f of pt.data.__type.fields) console.log(`  ${f.name}: ${f.type.name || f.type.ofType?.name}`);

    // Try a real match. STRATZ match ids differ from OpenDota's; find one from a
    // real player instead of guessing an id shape.
    const probe = await t.query(`{ __type(name: "PlayerType") { fields { name args { name type { name kind ofType { name } } } type { name kind ofType { name } } } } }`);
    const pmField = probe.data.__type.fields.find((f) => f.name === 'matches');
    console.log('\n=== PlayerType.matches signature ===');
    console.log('  args:', pmField.args.map((a) => `${a.name}:${a.type.name || a.type.ofType?.name}`).join(', '));
    console.log('  returns:', pmField.type.name || pmField.type.ofType?.name);

    const req = await t.query(`{ __type(name: "PlayerMatchesRequestType") { inputFields { name type { name kind ofType { name } } } } }`);
    console.log('  PlayerMatchesRequestType fields:', req.data.__type.inputFields.map((f) => f.name).join(', '));
    const reqFields = req.data.__type.inputFields.map((f) => f.name);

    const hist = reqFields.length
      ? await t.query(`{ player(steamAccountId: 70388657) { steamAccount { name } matches(request: { take: 2 }) { id } } }`)
      : null;
    const ids = (hist?.data?.player?.matches ?? []).map((h) => h.id).filter(Boolean);
    console.log(`\n  player: ${hist?.data?.player?.steamAccount?.name}`);
    console.log(`  match ids: ${JSON.stringify(ids)}`);
    for (const id of [...ids, 8600000000]) {
      try {
        const r = await t.query(`{ match(id: ${id}) { id didRadiantWin durationSeconds averageRank gameMode players { heroId position isRadiant isVictory item0Id item1Id item2Id item3Id item4Id item5Id backpack0Id neutral0Id } } }`);
        const m = r.data?.match;
        if (!m?.players?.length) { console.log(`  match(${id}): null/empty`); continue; }
        console.log(`\n  match(${id}): ${m.players.length} players | radiantWin=${m.didRadiantWin} | dur=${m.durationSeconds}s | avgRank=${m.averageRank} | gameMode=${m.gameMode}`);
        const p0 = m.players[0];
        console.log(`    player[0]: heroId=${p0.heroId} position=${p0.position} victory=${p0.isVictory}`);
        console.log(`      items=[${[p0.item0Id, p0.item1Id, p0.item2Id, p0.item3Id, p0.item4Id, p0.item5Id].join(',')}] backpack0=${p0.backpack0Id} neutral0=${p0.neutral0Id}`);
        const withPos = m.players.filter((p) => p.position).length;
        console.log(`    players carrying a position value: ${withPos}/${m.players.length}`);
        break;
      } catch (e) {
        console.log(`  match(${id}) failed: ${String(e.message).slice(0, 150)}`);
      }
    }

    // THE decisive test. The request type can filter by hero, enemy hero and
    // position simultaneously. Does it return ENOUGH volume in a rank-bracket
    // population that matches the rest of the pipeline?
    console.log('\n=== §13 volume test: hero + enemy + position, bracket-restricted ===');
    const enums = await t.query(`{ __schema { types { name kind enumValues { name } } } }`);
    // take is capped at 100, and bracketIds takes a different enum than the
    // heroStats queries. Read the actual input types instead of guessing.
    const inputTypes = {};
    for (const f of req.data.__type.inputFields) {
      inputTypes[f.name] = f.type.name || f.type.ofType?.name;
    }
    console.log('\n  request field types: heroIds=%s withEnemyHeroIds=%s positionIds=%s bracketIds=%s rankIds=%s',
      inputTypes.heroIds, inputTypes.withEnemyHeroIds, inputTypes.positionIds, inputTypes.bracketIds, inputTypes.rankIds);
    for (const n of ['RankBracketEnum', 'RankBracketBasicEnum']) {
      const ty = enums.data.__schema.types.find((x) => x.name === n);
      if (ty) console.log(`  ${n}: ${ty.enumValues.map((v) => v.name).join(', ')}`);
    }
    const bracketEnumName = String(inputTypes.bracketIds);
    const bEnum = enums.data.__schema.types.find((x) => x.name === bracketEnumName);
    const bValues = (bEnum?.enumValues ?? []).map((v) => v.name)
      .filter((v) => /HERALD|GUARDIAN|CRUSADER|ARCHON|LEGEND|ANC|DIVINE|IMMORTAL|HIGH|GUARDIAN|ARCHON/i.test(v));
    console.log(`  usable bracket values (${bracketEnumName}): ${bValues.slice(0, 12).join(', ')}`);
    const bracketArg = bValues.length ? `, bracketIds: [${bValues.slice(0, 12).map((v) => (v === 'ALL' ? 'ALL' : v)).join(', ')}]` : '';

    const trials = [
      ['Sniper(35) pos1 vs PA(47), no bracket filter', '{ heroIds: [35], withEnemyHeroIds: [47], positionIds: [POSITION_1], take: 100 }'],
      ['Sniper(35) pos1 vs PA(47), rank brackets', `{ heroIds: [35], withEnemyHeroIds: [47], positionIds: [POSITION_1]${bracketArg}, take: 100 }`],
      ['Bane(3) pos5 vs Puck(13), all', '{ heroIds: [3], withEnemyHeroIds: [13], positionIds: [POSITION_5], take: 100 }'],
      ['Bane(3) pos4 vs Puck(13), all', '{ heroIds: [3], withEnemyHeroIds: [13], positionIds: [POSITION_4], take: 100 }'],
      ['Sniper(35) pos1 (no enemy filter)', '{ heroIds: [35], positionIds: [POSITION_1], take: 100 }'],
      ['Rare cell: hero 126 pos1 vs 35', '{ heroIds: [126], withEnemyHeroIds: [35], positionIds: [POSITION_1], take: 100 }'],
    ];
    console.log('');
    for (const [label, reqStr] of trials) {
      try {
        const r = await t.query(`{ player(steamAccountId: 70388657) { matches(request: ${reqStr}) { id } } }`);
        const rows = r.data?.player?.matches ?? [];
        console.log(`  ${label}: ${rows.length} matches`);
      } catch (e) {
        console.log(`  ${label}: FAILED — ${String(e.message).slice(0, 130)}`);
      }
    }

    // The zero above is the key result: `matches(request:)` hangs off
    // `player()`, so the filters CONSTRAIN that player's own history rather than
    // searching globally. Prove it by filtering on the player's own hero.
    console.log('\n=== is matches(request:) a GLOBAL search or player-scoped? ===');
    const m = await t.query(`{ match(id: 8847785956) { players { heroId isVictory } } }`);
    const own = m.data.match.players.map((p) => p.heroId);
    console.log(`  the probe player played heroes: ${JSON.stringify(own)}`);
    for (const h of own.slice(0, 3)) {
      const r = await t.query(`{ player(steamAccountId: 70388657) { matches(request: { heroIds: [${h}], take: 100 }) { id } } }`);
      console.log(`  filter heroIds:[${h}] -> ${r.data.player.matches.length} matches`);
    }
    for (const h of [35, 1, 82]) {
      if (own.includes(h)) continue;
      const r = await t.query(`{ player(steamAccountId: 70388657) { matches(request: { heroIds: [${h}], take: 100 }) { id } } }`);
      console.log(`  filter heroIds:[${h}] (not his hero) -> ${r.data.player.matches.length} matches`);
    }
  } finally {
    await t.close();
  }
}

// ---------------------------------------------------------------- §4 OpenDota
async function opendota() {
  const get = async (url, tag) => {
    const c = readCache(tag);
    if (c) return c;
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
    const j = await r.json();
    return writeCache(tag, j);
  };

  // Where do match ids come from? /constants/matches and /matches/recent are
  // both 404; /parsedMatches works and returns recent PUBLIC match ids.
  const parsed = await get(`${OD}/parsedMatches?take=5`, 'od-parsedMatches');
  console.log('=== /parsedMatches?take=5 ===');
  console.log('  ', Array.isArray(parsed) ? JSON.stringify(parsed.slice(0, 3)) : JSON.stringify(parsed).slice(0, 200));
  const mid = Array.isArray(parsed) ? parsed[0]?.match_id : null;
  if (!mid) return;

  const m = await get(`${OD}/matches/${mid}`, `od-match-${mid}`);
  console.log(`\n=== /matches/${mid} — does it carry the full grain? ===`);
  console.log('  top-level keys:', Object.keys(m).join(', '));
  console.log(`  match_id=${m.match_id} duration=${m.duration} radiant_win=${m.radiant_win} game_mode=${m.game_mode}`);
  console.log(`  patch=${m.patch} patch_id=${m.patch_id} league=${m.league?.name ?? m.leagueid} region=${m.region}`);

  const p = m.players?.[0];
  console.log('  player[0] keys:', Object.keys(p ?? {}).join(', '));
  console.log(`    hero_id=${p?.hero_id} player_slot=${p?.player_slot}`);
  console.log('    items 0..5:', [0, 1, 2, 3, 4, 5].map((i) => p?.[`item_${i}`]).join(', '));
  const pl = p?.purchase_log ?? [];
  console.log('    purchase_log[0..5]:', JSON.stringify(pl.slice(0, 6)));
  console.log('    purchase_log length:', pl.length, '| time types:', [...new Set(pl.map((e) => typeof e.time))].join(','));

  // The decisive question: are BOTH enemy rosters and the result in the same
  // payload? If yes, the whole Hero+Position+Enemy+Item+Result tuple is
  // reconstructible from ONE request per match.
  const heroes_ = (m.players ?? []).map((x) => x.hero_id);
  console.log(`\n  players=${m.players?.length} | all hero_ids present: ${heroes_.filter(Boolean).length}`);
  console.log(`  enemy lineup derivable from the same payload: YES (${heroes_.filter(Boolean).length - 1} opponents)`);
  console.log(`  result derivable: radiant_win=${m.radiant_win} + player_slot=${p?.player_slot}`);
  console.log(`  position: ${m.players?.every((x) => 'lane_role' in x) ? 'lane_role present' : 'NO lane_role field'}`);
  console.log(`  lane_role values: ${(m.players ?? []).map((x) => x.lane_role).join(',')}`);
  console.log(`  is_roaming / lane: ${(m.players ?? []).map((x) => x.lane).join(',')}`);

  // The extra per-item fields that matter for §11/§12.
  console.log('\n  === per-item fields worth checking ===');
  for (const x of m.players ?? []) {
    console.log(`  hero ${x.hero_id} slot ${x.player_slot} lane_role ${x.lane_role} pos_est ${JSON.stringify(x.position_est)} rank_tier ${x.rank_tier} mmr ${x.computed_mmr}`);
    console.log(`    purchase_time: ${JSON.stringify(x.purchase_time).slice(0, 200)}`);
    console.log(`    first_purchase_time: ${JSON.stringify(x.first_purchase_time).slice(0, 160)}`);
    console.log(`    item_win: ${JSON.stringify(x.item_win).slice(0, 200)}`);
    console.log(`    shard=${x.aghanims_shard} scepter=${x.aghanims_scepter} moonshard=${x.moonshard} neutral=${x.item_neutral}/${x.item_neutral2}`);
    console.log(`    neutral_item_history: ${JSON.stringify(x.neutral_item_history).slice(0, 180)}`);
    break;
  }
  // Timing semantics: negative times appeared in purchase_log. Confirm.
  const allTimes = (m.players ?? []).flatMap((x) => (x.purchase_log ?? []).map((e) => e.time));
  console.log(`\n  purchase_log time range across all players: ${Math.min(...allTimes)} .. ${Math.max(...allTimes)} seconds`);
  console.log(`  negative values = pre-horn purchases; match duration ${m.duration}s`);

  // §13: how do we FIND matches with a given hero? The explorer is the only
  // queryable surface; probe the table schema before relying on it.
  console.log('\n=== explorer: can we select matches by hero? ===');
  const probe = async (sql, tag) => {
    const r = await get(`${OD}/explorer?sql=${encodeURIComponent(sql)}`, tag);
    return r;
  };

  const basic = await probe('SELECT match_id, radiant_win, duration FROM matches WHERE radiant_win IS NOT NULL ORDER BY match_id DESC LIMIT 3', 'od-explorer-probe');
  console.log('  basic SELECT ok:', Array.isArray(basic?.rows) ? `${basic.rows.length} rows` : JSON.stringify(basic).slice(0, 200));

  // What does the matches table actually look like? Ask, do not guess.
  for (const col of ['heroes', 'game_mode', 'leagueid', 'start_time', 'region', 'lobby_type']) {
    const r = await probe(`SELECT ${col} FROM matches ORDER BY match_id DESC LIMIT 1`, `od-col-${col}`);
    console.log(`  column "${col}":`, Array.isArray(r?.rows) ? 'EXISTS' : `NO — ${String(r?.error ?? r?.err ?? JSON.stringify(r)).slice(0, 110)}`);
  }

  // Are the recent public matches pro or ranked? game_mode 2 = capitans,
  // 22 = ranked, 23 = all pick/captains mode.
  const modes = await probe('SELECT game_mode, count(*) FROM matches WHERE start_time > 1750000000 GROUP BY game_mode ORDER BY 2 DESC LIMIT 8', 'od-modes');
  console.log('  game_mode distribution (recent):', JSON.stringify(modes?.rows ?? modes).slice(0, 300));
  const leagues = await probe('SELECT leagueid, count(*) FROM matches WHERE start_time > 1750000000 GROUP BY leagueid ORDER BY 2 DESC LIMIT 8', 'od-leagues');
  console.log('  leagueid distribution (recent):', JSON.stringify(leagues?.rows ?? leagues).slice(0, 300));
  const withHeroes = await probe('SELECT match_id, heroes FROM matches ORDER BY match_id DESC LIMIT 3', 'od-withheroes');
  console.log('  heroes column sample:', JSON.stringify(withHeroes?.rows ?? withHeroes).slice(0, 400));

  // §13 continued. The explorer is evidently a PRO-match database (game_mode 2
  // dominates, every leagueid non-zero). Is there any table that can find a
  // PUBLIC/RANKED match containing a given hero? Try the known table names
  // rather than inventing one.
  console.log('\n=== explorer: other tables that might carry hero ids ===');
  for (const t of ['player_matches', 'players', 'match_patch', 'scenarios', 'player_performances']) {
    const r = await probe(`SELECT * FROM ${t} LIMIT 1`, `od-tbl-${t}`);
    if (Array.isArray(r?.rows)) {
      console.log(`  ${t}: EXISTS, fields = ${(r.fields ?? []).map((f) => f.name).join(', ').slice(0, 220)}`);
    } else {
      console.log(`  ${t}: NO — ${String(r?.error ?? r?.err ?? '').slice(0, 90)}`);
    }
  }

  // /parsedMatches is the public-match source. Does it filter by anything?
  console.log('\n=== /parsedMatches filtering ===');
  const pm = await get(`${OD}/parsedMatches?take=2`, 'od-parsedMatches');
  console.log('  response shape:', JSON.stringify(pm).slice(0, 200));
  for (const q of ['?hero_id=35&take=2', '?featured=1&take=2']) {
    const r = await get(`${OD}/parsedMatches${q}`, `od-pm${q.replace(/[^a-z0-9]/gi, '_')}`);
    console.log(`  ${q} ->`, Array.isArray(r) ? `${r.length} entries` : JSON.stringify(r).slice(0, 120));
  }

  // player_matches is the discovery surface. Full field list first — is there a
  // position or a purchase time in it?
  console.log('\n=== player_matches: full schema ===');
  const r0 = await probe('SELECT * FROM player_matches LIMIT 1', 'od-tbl-player_matches');
  const fields = (r0.fields ?? []).map((f) => f.name);
  console.log('  all fields:', fields.join(', '));
  for (const c of ['lane_role', 'purchase_time', 'purchase_log', 'rank_tier', 'start_time', 'duration']) {
    console.log(`  has "${c}": ${fields.includes(c)}`);
  }

  // §7 in one SQL statement: Hero + Enemy + Item + Result, joined.
  console.log('\n=== §7 SQL: Sniper (35) with his enemy lineup, items and result ===');
  const sql = `
    SELECT pm.match_id, pm.player_slot, pm.hero_id,
           pm.item_0, pm.item_1, pm.item_2, pm.item_3,
           m.radiant_win, m.duration, m.leagueid, m.game_mode,
           e.hero_id AS enemy_hero_id
    FROM player_matches pm
    JOIN matches m ON m.match_id = pm.match_id
    JOIN player_matches e ON e.match_id = pm.match_id AND e.player_slot <> pm.player_slot
    WHERE pm.hero_id = 35
    ORDER BY pm.match_id DESC
    LIMIT 12`;
  const j = await probe(sql, 'od-join-sniper');
  if (Array.isArray(j?.rows)) {
    console.log(`  ${j.rows.length} rows returned`);
    for (const r of j.rows.slice(0, 6)) {
      console.log(
        `    match ${r.match_id} slot ${r.player_slot} items=[${r.item_0},${r.item_1},${r.item_2},${r.item_3}] ` +
        `radiant_win=${r.radiant_win} dur=${r.duration} gm=${r.game_mode} enemy=${r.enemy_hero_id}`,
      );
    }
    const heroesSeen = new Set(j.rows.map((r) => r.enemy_hero_id));
    console.log(`  distinct enemy hero ids in this slice: ${heroesSeen.size}`);
  } else {
    console.log('  FAILED:', JSON.stringify(j).slice(0, 300));
  }

  // Can it be narrowed to one enemy — the §7 question verbatim?
  console.log('\n=== §7 SQL: Sniper (35) vs Phantom Assassin (47) specifically ===');
  const sql2 = `
    SELECT pm.match_id, pm.player_slot, pm.item_0, pm.item_1, pm.item_2, pm.item_3, pm.item_4, pm.item_5,
           m.radiant_win, m.duration
    FROM player_matches pm
    JOIN matches m ON m.match_id = pm.match_id
    WHERE pm.hero_id = 35
      AND EXISTS (SELECT 1 FROM player_matches e
                  WHERE e.match_id = pm.match_id AND e.player_slot <> pm.player_slot AND e.hero_id = 47)
    ORDER BY pm.match_id DESC
    LIMIT 10`;
  const j2 = await probe(sql2, 'od-join-sniper-pa');
  console.log(Array.isArray(j2?.rows) ? `  ${j2.rows.length} matches found` : `  ${JSON.stringify(j2).slice(0, 250)}`);
  for (const r of (j2?.rows ?? []).slice(0, 5)) {
    const won = r.player_slot < 128 ? r.radiant_win : !r.radiant_win;
    console.log(`    match ${r.match_id} ${won ? 'WIN ' : 'LOSS'} items=[${[r.item_0, r.item_1, r.item_2, r.item_3, r.item_4, r.item_5].join(',')}] dur=${r.duration}`);
  }
}

/** §7 — the actual experiment, over a real sample with position filtering. */
async function experiment() {
  const get = async (url, tag) => {
    const c = readCache(tag);
    if (c) return c;
    const r = await fetch(url, { signal: AbortSignal.timeout(90000) });
    const j = await r.json();
    return writeCache(tag, j);
  };
  const probe = (sql, tag) => get(`${OD}/explorer?sql=${encodeURIComponent(sql)}`, tag);
  const itemNames = await get(`${OD}/constants/items`, 'od-const-items');
  const nameOf = (id) => itemNames?.[`item_${id}`]?.dname ?? `id${id}`;

  const cases = [
    ['Sniper', 1, 'Phantom Assassin'],
    ['Sniper', 1, 'Axe'],
    ['Bane', 5, 'Puck'],
  ];

  for (const [heroName, lane, enemyName] of cases) {
    const heroId = idOf(heroName);
    const enemyId = idOf(enemyName);
    const sql = `
      SELECT pm.match_id, pm.player_slot, pm.lane_role, pm.purchase_log,
             pm.item_0, pm.item_1, pm.item_2, pm.item_3, pm.item_4, pm.item_5,
             pm.backpack_0, pm.backpack_1, pm.item_neutral, pm.neutral_item_history,
             m.radiant_win, m.duration, m.game_mode, m.leagueid, m.start_time
      FROM player_matches pm
      JOIN matches m ON m.match_id = pm.match_id
      WHERE pm.hero_id = ${heroId}
        AND EXISTS (SELECT 1 FROM player_matches e
                    WHERE e.match_id = pm.match_id AND e.player_slot <> pm.player_slot AND e.hero_id = ${enemyId})
      ORDER BY pm.match_id DESC
      LIMIT 200`;
    const r = await probe(sql, `od-exp-${heroName.replace(/\s/g, '')}-${enemyName.replace(/\s/g, '')}`);
    const rows = r?.rows ?? [];
    console.log(`\n=== §7 ${heroName} vs ${enemyName} (target position ${lane}) ===`);
    console.log(`  matches found: ${rows.length}`);

    const inLane = rows.filter((x) => x.lane_role === lane);
    console.log(`  of those, lane_role=${lane}: ${inLane.length}`);
    const modes = {};
    for (const x of rows) modes[x.game_mode] = (modes[x.game_mode] ?? 0) + 1;
    console.log(`  game_mode distribution: ${JSON.stringify(modes)}`);

    const use = inLane.length >= 5 ? inLane : rows;
    const wins = use.filter((x) => (x.player_slot < 128 ? x.radiant_win : !x.radiant_win)).length;
    console.log(`  analysing ${use.length} matches (${use === inLane ? 'position-filtered' : 'position NOT applied — sample too thin'}), wins ${wins}`);

    const items = new Map();
    const times = [];
    let withTiming = 0;
    for (const x of use) {
      for (let i = 0; i < 6; i += 1) {
        const v = x[`item_${i}`];
        if (v) items.set(v, (items.get(v) ?? 0) + 1);
      }
      const log = x.purchase_log;
      if (Array.isArray(log) && log.length) {
        withTiming += 1;
        for (const e of log) if (typeof e.time === 'number' && e.time >= 0) times.push(e.time);
      }
    }
    const top = [...items].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`  top items: ${top.map(([i, c]) => `${nameOf(i)} ${c}/${use.length}`).join(', ')}`);
    console.log(`  matches carrying purchase_log: ${withTiming}/${use.length}`);
    if (times.length) {
      const s = [...times].sort((a, b) => a - b);
      const bucket = [0, 0, 0, 0, 0];
      for (const t of s) bucket[Math.min(4, Math.floor(t / 600))] += 1;
      console.log(`  timing buckets 0-10/10-20/20-30/30-40/40+ min: ${bucket.join(' / ')} (n=${s.length})`);
    }

    // §10 confounder: are late purchases happening in already-decided games?
    const late = use.filter((x) => Array.isArray(x.purchase_log) && x.purchase_log.some((e) => e.time > 1800));
    console.log(`  matches with any purchase after 30:00: ${late.length}/${use.length} (post-hoc buying risk)`);
    const durs = use.map((x) => x.duration).filter(Boolean);
    if (durs.length) {
      console.log(`  duration: min ${Math.min(...durs)}s  median ${durs.sort((a, b) => a - b)[Math.floor(durs.length / 2)]}s  max ${Math.max(...durs)}s`);
    }
  }
}




/** §13 — how many matches actually exist per (hero, enemy) cell? */
async function sampleSize() {
  const get = async (url, tag) => {
    const c = readCache(tag);
    if (c) return c;
    const r = await fetch(url, { signal: AbortSignal.timeout(90000) });
    const j = await r.json();
    return writeCache(tag, j);
  };
  const probe = (sql, tag) => get(`${OD}/explorer?sql=${encodeURIComponent(sql)}`, tag);

  // Total inventory in the explorer.
  const tot = await probe('SELECT count(*) AS n FROM matches', 'od-count-matches');
  console.log('=== explorer inventory ===');
  console.log('  total matches rows:', JSON.stringify(tot?.rows ?? tot).slice(0, 120));
  const since = await probe("SELECT count(*) AS n FROM matches WHERE start_time > 1750000000", 'od-count-recent');
  console.log('  matches since ~2025-06:', JSON.stringify(since?.rows ?? since).slice(0, 120));

  // Per-hero match counts: how many observations does a hero even have?
  console.log('\n=== matches per hero (top / median) ===');
  const perHero = await probe(
    'SELECT hero_id, count(*) AS n FROM player_matches GROUP BY hero_id ORDER BY n DESC LIMIT 5',
    'od-perhero-top');
  const perHeroLow = await probe(
    'SELECT hero_id, count(*) AS n FROM player_matches GROUP BY hero_id ORDER BY n ASC LIMIT 5',
    'od-perhero-low');
  console.log('  most-played:', JSON.stringify(perHero?.rows));
  console.log('  least-played:', JSON.stringify(perHeroLow?.rows));

  // The decisive number: (hero, enemy) pair volume. A Dota draft has BOTH
  // teams, so hero A and enemy B co-occur roughly (2 x pickRate / 126) of the
  // time — measure it instead of guessing.
  console.log('\n=== (hero, enemy) pair volume — the real granularity cost ===');
  const pairs = [[35, 47], [35, 2], [3, 13], [82, 1], [1, 35], [126, 126]];
  for (const [a, b] of pairs) {
    const r = await probe(
      `SELECT count(*) AS n FROM player_matches pm
       WHERE pm.hero_id = ${a}
         AND EXISTS (SELECT 1 FROM player_matches e WHERE e.match_id = pm.match_id
                     AND e.player_slot <> pm.player_slot AND e.hero_id = ${b})`,
      `od-pair-${a}-${b}`);
    const n = r?.rows?.[0]?.n;
    console.log(`  hero ${a} vs ${b}: ${n === undefined ? 'QUERY FAILED' : n} matches`);
  }

  // Position x enemy: the granularity the ТЗ actually asks for.
  console.log('\n=== (hero, position, enemy) — the LEVEL 2 cell ===');
  for (const [a, lane, b] of [[35, 1, 47], [35, 1, 2], [3, 5, 13], [1, 1, 35]]) {
    const r = await probe(
      `SELECT count(*) AS n FROM player_matches pm
       WHERE pm.hero_id = ${a} AND pm.lane_role = ${lane}
         AND EXISTS (SELECT 1 FROM player_matches e WHERE e.match_id = pm.match_id
                     AND e.player_slot <> pm.player_slot AND e.hero_id = ${b})`,
      `od-cell-${a}-${lane}-${b}`);
    const n = r?.rows?.[0]?.n;
    console.log(`  hero ${a} pos${lane} vs ${b}: ${n === undefined ? 'QUERY FAILED' : n} matches`);
  }

  // Extrapolate: if a (hero,pos,enemy) cell needs ~200 observations for a
  // stable rate, what does full coverage imply?
  const cells = 127 * 5 * 126;
  console.log(`\n  cells needed for hero+position+enemy: 127 x 5 x 126 = ${cells.toLocaleString()}`);
  for (const need of [50, 200, 1000]) {
    console.log(`    at ${need} observations per cell -> ${(cells * need).toLocaleString()} hero-match observations`);
  }
}

const cmd = process.argv[2];
try {
  if (cmd === 'stratz-schema') await stratzSchema();
  else if (cmd === 'opendota') await opendota();
  else if (cmd === 'experiment') await experiment();
  else if (cmd === 'sample-size') await sampleSize();
  else console.log('commands: stratz-schema | opendota | experiment | sample-size');
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
}

