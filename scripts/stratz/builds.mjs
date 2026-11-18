/**
 * Hero builds from STRATZ purchase / skill statistics (MVP: no enemy adaptation).
 *
 * For one hero, one STRATZ request per weekly bucket asks — for every position
 * the hero is really played at and every rank bracket — for:
 *   itemStartingPurchase  starting items (per copy: instance 0, 1, …)
 *   itemBootPurchase      boots, average purchase time
 *   itemFullPurchase      every completed purchase, by game minute
 *   talent                talent picks
 *   abilityMaxLevel       hero level at which each ability was maxed
 *   abilityMinLevel       hero level at which each ability was first taken
 *   laneOutcome(isWith)   laning-stage result (win / draw / loss) with each
 *                         teammate who shared the lane — "who lanes well with
 *                         this hero at this position"
 *
 * Denominator. The item endpoints count a different (larger) population than
 * heroStats.stats, so dividing by the position's match count gives >100%.
 * Every basic ability is taken at least once in (almost) every match, so the
 * per-ability totals of abilityMinLevel agree to ~0.1% (Lion: 27 289 / 27 292 /
 * 27 264 / 27 275) — that total is the match count of the item population.
 */

export const BUILD_FIELDS = ['s', 'b', 'f', 't', 'x', 'n'];

export function buildHeroQuery(heroId, bucketWeekSec, positions, brackets) {
  const parts = [];
  for (const b of brackets) {
    for (const p of positions) {
      const a = `heroId: ${heroId}, week: ${bucketWeekSec}, bracketBasicIds: [${b}], positionIds: [POSITION_${p}]`;
      const k = `${b}_${p}`;
      parts.push(`s_${k}: itemStartingPurchase(${a}) { itemId instance wasGiven matchCount winCount }`);
      parts.push(`b_${k}: itemBootPurchase(${a}) { itemId timeAverage matchCount winCount }`);
      parts.push(`f_${k}: itemFullPurchase(${a}, matchLimit: 10) { itemId instance time matchCount winCount }`);
      parts.push(`t_${k}: talent(${a}) { abilityId matchCount winCount }`);
      parts.push(`x_${k}: abilityMaxLevel(${a}) { abilityId level matchCount }`);
      parts.push(`n_${k}: abilityMinLevel(${a}) { abilityId matchCount }`);
      parts.push(`l_${k}: laneOutcome(heroId: ${heroId}, isWith: true, week: ${bucketWeekSec}, bracketBasicIds: [${b}], positionIds: [POSITION_${p}]) { heroId2 matchCount winCount lossCount }`);
    }
  }
  return `{ heroStats {\n${parts.join('\n')}\n} }`;
}

function emptyCell() {
  return { start: new Map(), boots: new Map(), full: new Map(), talent: new Map(), amax: new Map(), amin: new Map(), lane: new Map() };
}

/** raw[pos][bracket] = cell; weighted sums (rolling-window bucket weight). */
export function accumulateHero(raw, response, positions, brackets, weight = 1) {
  const h = response?.data?.heroStats ?? {};
  for (const b of brackets) {
    for (const p of positions) {
      const k = `${b}_${p}`;
      raw[p] ??= {};
      const cell = (raw[p][b] ??= emptyCell());
      for (const r of h[`s_${k}`] ?? []) {
        if (r.wasGiven) continue; // a courier/teammate gift is not a purchase
        const key = `${r.itemId}:${r.instance ?? 0}`;
        const c = cell.start.get(key) ?? [0, 0];
        c[0] += weight * r.matchCount;
        c[1] += weight * r.winCount;
        cell.start.set(key, c);
      }
      for (const r of h[`b_${k}`] ?? []) {
        const c = cell.boots.get(r.itemId) ?? { g: 0, w: 0, t: 0 };
        c.g += weight * r.matchCount;
        c.w += weight * r.winCount;
        c.t += weight * r.matchCount * Number(r.timeAverage ?? 0);
        cell.boots.set(r.itemId, c);
      }
      for (const r of h[`f_${k}`] ?? []) {
        if ((r.instance ?? 0) !== 0) continue; // first copy only
        const c = cell.full.get(r.itemId) ?? { g: 0, w: 0, minutes: new Map() };
        c.g += weight * r.matchCount;
        c.w += weight * r.winCount;
        c.minutes.set(r.time, (c.minutes.get(r.time) ?? 0) + weight * r.matchCount);
        cell.full.set(r.itemId, c);
      }
      for (const r of h[`t_${k}`] ?? []) {
        const c = cell.talent.get(r.abilityId) ?? [0, 0];
        c[0] += weight * r.matchCount;
        c[1] += weight * r.winCount;
        cell.talent.set(r.abilityId, c);
      }
      for (const r of h[`x_${k}`] ?? []) {
        const m = cell.amax.get(r.abilityId) ?? new Map();
        m.set(r.level, (m.get(r.level) ?? 0) + weight * r.matchCount);
        cell.amax.set(r.abilityId, m);
      }
      for (const r of h[`n_${k}`] ?? []) {
        cell.amin.set(r.abilityId, (cell.amin.get(r.abilityId) ?? 0) + weight * r.matchCount);
      }
      for (const r of h[`l_${k}`] ?? []) {
        const c = cell.lane.get(r.heroId2) ?? [0, 0, 0];
        c[0] += weight * r.matchCount;
        c[1] += weight * r.winCount;
        c[2] += weight * r.lossCount;
        cell.lane.set(r.heroId2, c);
      }
    }
  }
  return raw;
}

/** "ALL" cell per position = sum of the bracket cells. */
export function addAllRanks(raw, brackets) {
  for (const p of Object.keys(raw)) {
    const all = emptyCell();
    for (const b of brackets) {
      const c = raw[p][b];
      if (!c) continue;
      for (const [k, v] of c.start) { const a = all.start.get(k) ?? [0, 0]; a[0] += v[0]; a[1] += v[1]; all.start.set(k, a); }
      for (const [k, v] of c.boots) { const a = all.boots.get(k) ?? { g: 0, w: 0, t: 0 }; a.g += v.g; a.w += v.w; a.t += v.t; all.boots.set(k, a); }
      for (const [k, v] of c.full) {
        const a = all.full.get(k) ?? { g: 0, w: 0, minutes: new Map() };
        a.g += v.g; a.w += v.w;
        for (const [m, g] of v.minutes) a.minutes.set(m, (a.minutes.get(m) ?? 0) + g);
        all.full.set(k, a);
      }
      for (const [k, v] of c.talent) { const a = all.talent.get(k) ?? [0, 0]; a[0] += v[0]; a[1] += v[1]; all.talent.set(k, a); }
      for (const [k, v] of c.amax) {
        const a = all.amax.get(k) ?? new Map();
        for (const [l, g] of v) a.set(l, (a.get(l) ?? 0) + g);
        all.amax.set(k, a);
      }
      for (const [k, v] of c.amin) all.amin.set(k, (all.amin.get(k) ?? 0) + v);
      for (const [k, v] of c.lane) {
        const a = all.lane.get(k) ?? [0, 0, 0];
        a[0] += v[0]; a[1] += v[1]; a[2] += v[2];
        all.lane.set(k, a);
      }
    }
    raw[p].ALL = all;
  }
  return raw;
}

function weightedMedian(hist) {
  const entries = [...hist.entries()].sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((s, [, g]) => s + g, 0);
  let acc = 0;
  for (const [v, g] of entries) {
    acc += g;
    if (acc >= total / 2) return v;
  }
  return entries.length ? entries[entries.length - 1][0] : 0;
}

const r3 = (x) => Math.round(x * 1000) / 1000;
const r1 = (x) => Math.round(x * 10) / 10;

export const BUILD_LIMITS = {
  startMinPct: 0.15,
  bootsMinPct: 0.05,
  itemMinPct: 0.05,
  lowDataMatches: 300,
};

/**
 * One build from one cell.
 * ctx: { abilityIds: number[] (basic abilities in slot order),
 *        talents: { id, level }[] (level 1..4 = hero level 10/15/20/25),
 *        items: Map(id -> { qual, cost }) }
 * Output (compact, per file size):
 *   m        matches in the item population
 *   start    [itemId, pct, qty]       qty = copies bought by most players
 *   boots    [itemId, pct, minute]
 *   items    [itemId, pct, medianMinute, winrate]
 *   talents  [heroLevel, [id, pct, wr], [id, pct, wr]]
 *   skills   [abilityId, medianLevelMaxed, pctMaxed]  in maxing order
 */
export function summarizeBuild(cell, ctx) {
  const m = Math.max(0, ...ctx.abilityIds.map((id) => cell.amin.get(id) ?? 0));
  if (!(m > 0)) return null;

  // starting items: copies 0, 1, 2… → quantity bought by at least half of the players
  const byItem = new Map();
  for (const [key, [g]] of cell.start) {
    const [id, inst] = key.split(':').map(Number);
    const e = byItem.get(id) ?? [];
    e[inst] = g;
    byItem.set(id, e);
  }
  const start = [];
  for (const [id, copies] of byItem) {
    const first = (copies[0] ?? 0) / m;
    if (first < BUILD_LIMITS.startMinPct) continue;
    let qty = 1;
    while ((copies[qty] ?? 0) / m >= 0.5) qty += 1;
    start.push([id, r3(Math.min(1, first)), qty]);
  }
  start.sort((a, b) => b[1] - a[1]);

  const bootIds = new Set(cell.boots.keys());
  const boots = [...cell.boots.entries()]
    .map(([id, v]) => [id, r3(Math.min(1, v.g / m)), v.g ? Math.round(v.t / v.g / 60) : 0])
    .filter((b) => b[1] >= BUILD_LIMITS.bootsMinPct)
    .sort((a, b) => b[1] - a[1]);

  const items = [];
  for (const [id, v] of cell.full) {
    const meta = ctx.items.get(id);
    if (!meta || meta.qual === 'consumable' || !(meta.cost > 0) || bootIds.has(id)) continue;
    const pct = v.g / m;
    if (pct < BUILD_LIMITS.itemMinPct) continue;
    items.push([id, r3(Math.min(1, pct)), weightedMedian(v.minutes), r1(v.g ? (100 * v.w) / v.g : 0)]);
  }
  items.sort((a, b) => a[2] - b[2] || b[1] - a[1]);

  const talents = [];
  for (const level of [4, 3, 2, 1]) {
    const pair = ctx.talents.filter((t) => t.level === level);
    if (pair.length !== 2) continue;
    const g = pair.map((t) => cell.talent.get(t.id) ?? [0, 0]);
    const sum = g[0][0] + g[1][0];
    if (!sum) continue;
    talents.push([
      [10, 15, 20, 25][level - 1],
      ...pair.map((t, i) => [t.id, r3(g[i][0] / sum), r1(g[i][0] ? (100 * g[i][1]) / g[i][0] : 0)]),
    ]);
  }

  const skills = ctx.abilityIds
    .filter((id) => (cell.amin.get(id) ?? 0) >= 0.5 * m && cell.amax.get(id))
    .map((id) => {
      const hist = cell.amax.get(id);
      const maxed = [...hist.values()].reduce((s, g) => s + g, 0);
      return [id, weightedMedian(hist), r3(Math.min(1, maxed / m))];
    })
    .sort((a, b) => a[1] - b[1]);

  return { m: Math.round(m), low: m < BUILD_LIMITS.lowDataMatches, start, boots, items, talents, skills };
}

/**
 * Sanity contract for a finished build set. A broken response (wrong ids,
 * mis-mapped positions, empty arrays) shows up as heroes without starting items
 * or with "items" far above 100% of matches.
 */
export function validateBuilds(builds, { minHeroes = 100 } = {}) {
  const problems = [];
  const ids = Object.keys(builds);
  if (ids.length < minHeroes) problems.push(`only ${ids.length} heroes have builds`);
  let noStart = 0;
  for (const [id, b] of Object.entries(builds)) {
    const positions = Object.entries(b.positions ?? {});
    if (!positions.length) { problems.push(`hero ${id}: no positions`); continue; }
    for (const [pos, byRank] of positions) {
      const all = byRank.ALL;
      if (!all || !(all.m > 0)) { problems.push(`hero ${id} pos ${pos}: no all-ranks build`); continue; }
      if (!all.start.length) noStart += 1;
      if (!all.skills.length) problems.push(`hero ${id} pos ${pos}: no skill order`);
      for (const it of [...all.items, ...all.boots, ...all.start]) {
        if (!(it[1] >= 0 && it[1] <= 1)) problems.push(`hero ${id} pos ${pos}: share ${it[1]} for item ${it[0]}`);
      }
    }
    if (problems.length > 20) break;
  }
  if (noStart > ids.length * 0.05) problems.push(`${noStart} position builds without starting items`);
  if (problems.length) throw new Error(`Build contract failed: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ''}`);
  return { heroes: ids.length };
}

/** Lane partners with at least this many shared lanes are kept. */
export const LANE_MIN_MATCHES = 30;

/**
 * Laning results of this hero/position with each lane partner:
 * { partnerId: [lanes, won, lost] } (draws = lanes − won − lost). Thin pairs
 * are dropped; `avg` is the lane win share (won / (won + lost)) over all
 * partners — what "a usual partner" gets.
 */
export function summarizeLanes(cell) {
  const partners = {};
  let w = 0;
  let l = 0;
  for (const [id, [m, won, lost]] of cell.lane) {
    w += won;
    l += lost;
    if (m >= LANE_MIN_MATCHES) partners[id] = [Math.round(m), Math.round(won), Math.round(lost)];
  }
  if (!Object.keys(partners).length) return null;
  return { avg: w + l ? Math.round((1000 * w) / (w + l)) / 1000 : 0.5, partners };
}
