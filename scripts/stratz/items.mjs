/**
 * Production item data — LEVEL 1 only: Hero + Position → Item (ТЗ №12).
 *
 * This layer deliberately stops at "what does this hero buy on this lane".
 * It is NOT item-vs-enemy data and NOT a build recommendation: no enemy
 * conditioning, no counter logic, no slot optimisation. See docs/item-data.md.
 *
 * Three facts from the ТЗ №10/№11 research drive the whole design:
 *
 *  1. `positionIds` is a real filter but the `position` field in the RESPONSE is
 *     a lying echo (always POSITION_1 on a non-empty result). Position must be
 *     taken from the REQUEST.
 *  2. A single request covering all five positions returns a dataset that is NOT
 *     the union of the five per-position requests (measured: 223 keys vs 154, zero
 *     matching counts). The unit of work is (hero, position, week) and the
 *     position is always known from what we asked for.
 *  3. `matchCount` is a PURCHASE-EVENT count, not a distinct-game count. It can
 *     exceed the hero's games (measured: Battle Fury 218 715 purchases vs 167 925
 *     games = 130%). Nothing here may divide it by a game count and call the
 *     result a rate.
 */
import { BUCKET_SEC, BRACKETS, StratzTransport } from '../update-data-stratz.mjs';

export { BRACKETS };

/** Positions in a fixed order — the dataset key comes from this list, never from a response. */
export const LANES = [1, 2, 3, 4, 5];

/** How many heroes to alias into one GraphQL operation. */
export const HERO_CHUNK = 20;

/** STRATZ time buckets are game minutes; the research measured 0..51. */
export const MAX_PLAUSIBLE_MINUTE = 90;

const positionEnum = (n) => `POSITION_${n}`;

/** One aliased operation covering up to HERO_CHUNK heroes at ONE position and ONE week. */
export function buildItemStatsQuery(heroIds, position, bucket) {
  const aliases = heroIds
    .map(
      (id, i) => `h${i}: itemFullPurchase(heroId: ${id}, week: ${bucket * BUCKET_SEC}, ` +
        `bracketBasicIds: [${BRACKETS.join(', ')}], positionIds: [${positionEnum(position)}]) ` +
        `{ itemId instance time matchCount winCount }`,
    )
    .join('\n      ');
  return `{ heroStats {\n      ${aliases}\n    } }`;
}

/**
 * Item metadata for the whole catalogue, minus recipes.
 *
 * Recipes are synthesis steps, not things a player buys, and STRATZ already
 * omits them from purchase data — so they are dropped here.
 *
 * Everything else is kept, INCLUDING `isPurchasable: false` entries such as
 * neutral items (Healing Lotus, 4205/4206). Those are not shop items but they
 * are genuinely purchased and genuinely end up in inventories; filtering on
 * isPurchasable alone produced orphan ids in the statistics and failed the
 * contract. `pruneItemCatalogue` then narrows the catalogue to what is actually
 * reachable, which is where the isPurchasable signal belongs.
 */
export async function fetchItemsMetadata({ token, log = console.log } = {}) {
  const t = new StratzTransport(token);
  await t.init();
  try {
    log('    Fetching item catalogue (STRATZ constants.items)…');
    const res = await t.query(`{ constants { items(language: ENGLISH) {
      id name displayName shortName isSupportFullItem image
      stat { cost isPurchasable isRecipe needsComponents stockMax isStackable isSideShop }
      components { index componentId }
    } } }`);
    const all = res.data?.constants?.items ?? [];
    const items = {};
    for (const it of all) {
      const stat = it.stat ?? {};
      if (stat.isRecipe === true) continue;
      if (it.id === null || it.id === undefined) continue;
      items[String(it.id)] = {
        id: it.id,
        name: it.displayName || it.name,
        dname: it.name,
        shortName: it.shortName ?? '',
        cost: stat.cost ?? 0,
        isPurchasable: stat.isPurchasable === true,
        isStackable: stat.isStackable === true,
        isSideShop: stat.isSideShop === true,
        stockMax: stat.stockMax ?? 0,
        isSupportFullItem: it.isSupportFullItem === true,
        image: it.image ?? '',
        components: (it.components ?? []).sort((a, b) => a.index - b.index).map((c) => c.componentId),
      };
    }
    log(`    Catalogue: ${all.length} entries -> ${Object.keys(items).length} after dropping recipes`);
    return items;
  } finally {
    await t.close();
  }
}

/**
 * Narrow the catalogue to items that are actually reachable: shop items
 * (`isPurchasable`) plus anything the statistics show being bought. This removes
 * internal-only entities (cheese, courier, flying courier, upgrade variants) that
 * are neither purchasable nor ever purchased, while keeping neutral items.
 */
export function pruneItemCatalogue(items, itemStats) {
  const used = new Set();
  for (const byPos of Object.values(itemStats)) {
    for (const byItem of Object.values(byPos)) for (const id of Object.keys(byItem)) used.add(id);
  }
  const kept = {};
  let shopOnly = 0;
  let statsOnly = 0;
  for (const [id, it] of Object.entries(items)) {
    const buyable = it.isPurchasable === true;
    const bought = used.has(id);
    if (!buyable && !bought) continue;
    if (buyable) shopOnly += 1;
    if (!buyable && bought) statsOnly += 1;
    kept[id] = it;
  }
  return { items: kept, keptCount: Object.keys(kept).length, shopOnly, nonShopButBought: statsOnly };
}


/**
 * Fetch and aggregate item purchase statistics over the same complete-bucket
 * window the matchups and positions use.
 *
 * `heroGamesByPosition` comes from the ALREADY VALIDATED position statistics —
 * the item endpoint cannot supply it, and summing purchases would be nonsense.
 * Keyed `"<heroId>:<position>"`.
 */
export async function fetchItemStats(
  heroIds,
  windowInfo,
  { token, log = console.log, heroGamesByPosition = new Map(), concurrency = 2, retries = 3 } = {},
) {
  const t = new StratzTransport(token);
  await t.init();

  const stats = new Map();
  const bump = (heroId, position, row) => {
    if (!stats.has(heroId)) stats.set(heroId, {});
    const byPos = stats.get(heroId);
    if (!byPos[position]) byPos[position] = {};
    const byItem = byPos[position];
    const id = String(row.itemId);
    if (!byItem[id]) byItem[id] = { purchases: 0, wins: 0, byMinute: {}, instances: {} };
    const cell = byItem[id];
    const purchases = row.matchCount ?? 0;
    cell.purchases += purchases;
    cell.wins += row.winCount ?? 0;
    const minute = String(row.time);
    cell.byMinute[minute] = (cell.byMinute[minute] ?? 0) + purchases;
    const inst = String(row.instance ?? 0);
    cell.instances[inst] = (cell.instances[inst] ?? 0) + purchases;
  };

  try {
    // One (position, week) group; inside it, heroes are aliased. Never all
    // positions in one request — see the module header.
    const groups = [];
    for (const position of LANES) {
      for (const bucket of windowInfo.buckets) {
        for (let i = 0; i < heroIds.length; i += HERO_CHUNK) {
          groups.push({ position, bucket, chunk: heroIds.slice(i, i + HERO_CHUNK) });
        }
      }
    }

    let done = 0;
    const t0 = Date.now();
    const runGroup = async (g) => {
      const query = buildItemStatsQuery(g.chunk, g.position, g.bucket);
      let lastErr;
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
          const res = await t.query(query);
          for (let i = 0; i < g.chunk.length; i += 1) {
            const rows = res.data?.heroStats?.[`h${i}`] ?? [];
            // Position comes from `g.position` — the REQUEST. Never row.position.
            for (const row of rows) bump(g.chunk[i], g.position, row);
          }
          lastErr = undefined;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < retries) {
            log(`    [retry ${attempt}/${retries}] pos${g.position} w${g.bucket}: ${String(e.message).slice(0, 130)}`);
            await new Promise((r) => setTimeout(r, 1500 * 2 ** (attempt - 1)));
          }
        }
      }
      if (lastErr) {
        throw new Error(`item stats batch failed permanently (pos${g.position} week ${g.bucket}): ${lastErr.message}`);
      }
      done += 1;
      if (done % 40 === 0 || done === groups.length) {
        log(`    ${done}/${groups.length} batches (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      }
    };

    // Bounded concurrency: no unbounded fan-out against a Cloudflare-fronted API.
    const queue = groups.slice();
    await Promise.all(
      Array.from({ length: Math.max(1, concurrency) }, async () => {
        while (queue.length) await runGroup(queue.shift());
      }),
    );
    log(`    ${done} item batches in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    await t.close();
  }

  // Shape into the published contract, attaching heroGames from the position layer.
  const out = {};
  for (const heroId of heroIds) {
    const byPos = stats.get(heroId);
    if (!byPos) continue;
    out[String(heroId)] = {};
    for (const position of LANES) {
      const byItem = byPos[position];
      // §9: absence stays absence. No hero-global fallback, no role substitution.
      if (!byItem || Object.keys(byItem).length === 0) continue;
      out[String(heroId)][String(position)] = {};
      for (const [itemId, cell] of Object.entries(byItem)) {
        out[String(heroId)][String(position)][itemId] = {
          purchases: cell.purchases,
          wins: cell.wins,
          heroGames: heroGamesByPosition.get(`${heroId}:${position}`) ?? 0,
          byMinute: cell.byMinute,
          instances: cell.instances,
        };
      }
    }
  }
  return out;
}

/**
 * Item data contract (ТЗ №12 §15–§18).
 *
 * Two rules are counter-intuitive and are why this function exists:
 *  - `purchases <= heroGames` is NOT checked and must never be. matchCount counts
 *    purchase EVENTS, so a hero can legitimately exceed its game count (measured:
 *    Battle Fury 130%). Asserting the opposite would reject correct data.
 *  - `wins <= purchases` IS checked, because wins are a subset of purchase events.
 */
export function validateItemData(items, itemStats, { heroes, windowInfo, brackets = BRACKETS }) {
  const problems = [];
  const heroSet = new Set(heroes.map((h) => h.id));
  const itemIds = new Set(Object.keys(items));

  if (itemIds.size === 0) problems.push('items.json is empty — the catalogue fetch produced nothing');
  for (const [id, it] of Object.entries(items)) {
    if (String(it.id) !== id) problems.push(`item ${id}: id field (${it.id}) disagrees with its key`);
    if (it.isRecipe === true) problems.push(`item ${id}: recipe present in the item catalogue`);
    for (const f of ['name', 'dname', 'cost', 'isPurchasable', 'isStackable', 'isSupportFullItem', 'image', 'components']) {
      if (!(f in it)) problems.push(`item ${id}: missing field "${f}"`);
    }
    if (!Number.isFinite(it.cost) || it.cost < 0) problems.push(`item ${id}: cost must be non-negative, got ${it.cost}`);
    if (!Array.isArray(it.components)) problems.push(`item ${id}: components must be an array`);
    for (const c of it.components ?? []) {
      if (!itemIds.has(String(c))) problems.push(`item ${id}: component ${c} is not in the catalogue (orphan)`);
    }
  }

  for (const [hid, byPos] of Object.entries(itemStats)) {
    if (!heroSet.has(Number(hid))) {
      problems.push(`item-stats: entry for unknown hero ${hid}`);
      continue;
    }
    for (const [pos, byItem] of Object.entries(byPos)) {
      if (!LANES.map(String).includes(pos)) {
        problems.push(`item-stats hero ${hid}: position key "${pos}" is not 1..5`);
        continue;
      }
      if (Object.keys(byItem).length === 0) {
        problems.push(`item-stats hero ${hid} pos ${pos}: empty item map (omit the key instead)`);
      }
      for (const [iid, cell] of Object.entries(byItem)) {
        const where = `item-stats hero ${hid} pos ${pos} item ${iid}`;
        if (!itemIds.has(iid)) problems.push(`${where}: item id is not in items.json (unknown/orphan)`);
        if (!Number.isInteger(cell.purchases) || cell.purchases < 0) {
          problems.push(`${where}: purchases must be a non-negative integer, got ${cell.purchases}`);
        }
        if (!Number.isInteger(cell.wins) || cell.wins < 0) {
          problems.push(`${where}: wins must be a non-negative integer, got ${cell.wins}`);
        }
        // wins are a subset of purchases; purchases vs heroGames is NOT checked.
        if (cell.wins > cell.purchases) {
          problems.push(`${where}: wins ${cell.wins} exceed purchases ${cell.purchases}`);
        }
        if (!Number.isInteger(cell.heroGames) || cell.heroGames < 0) {
          problems.push(`${where}: heroGames must be a non-negative integer, got ${cell.heroGames}`);
        }
        for (const [t, n] of Object.entries(cell.byMinute ?? {})) {
          const minute = Number(t);
          if (!Number.isInteger(minute) || minute < 0) {
            problems.push(`${where}: byMinute key "${t}" is not a non-negative integer minute`);
          } else if (minute > MAX_PLAUSIBLE_MINUTE) {
            // Fail loudly rather than silently clamping: a value like 900 means
            // the time field is not what we think it is.
            problems.push(`${where}: byMinute ${t} exceeds the plausible maximum ${MAX_PLAUSIBLE_MINUTE}`);
          }
          if (!Number.isInteger(n) || n < 0) problems.push(`${where}: byMinute["${t}"] must be a non-negative integer, got ${n}`);
        }
        for (const [i, n] of Object.entries(cell.instances ?? {})) {
          if (!Number.isInteger(Number(i)) || Number(i) < 0) {
            problems.push(`${where}: instance "${i}" must be a non-negative integer`);
          }
          if (!Number.isInteger(n) || n < 0) problems.push(`${where}: instances["${i}"] must be a non-negative integer, got ${n}`);
        }
        // Every purchase must be attributable to a minute and to an instance copy.
        const minuteSum = Object.values(cell.byMinute ?? {}).reduce((a, b) => a + b, 0);
        const instSum = Object.values(cell.instances ?? {}).reduce((a, b) => a + b, 0);
        if (minuteSum !== cell.purchases) {
          problems.push(`${where}: byMinute sums to ${minuteSum} but purchases is ${cell.purchases}`);
        }
        if (instSum !== cell.purchases) {
          problems.push(`${where}: instances sum to ${instSum} but purchases is ${cell.purchases}`);
        }
      }
    }
  }

  if (!Array.isArray(windowInfo?.buckets) || windowInfo.buckets.length === 0) {
    problems.push('item data contract failed: no weekly buckets supplied');
  }
  const unexpected = brackets.filter((b) => !BRACKETS.includes(b));
  if (unexpected.length > 0) {
    problems.push(`item data contract failed: brackets ${unexpected.join(', ')} are outside the production population`);
  }
  if (problems.length > 0) {
    throw new Error(`Item data contract failed (${problems.length}):\n  - ${problems.slice(0, 25).join('\n  - ')}`);
  }

  const positions = Object.values(itemStats).reduce((s, byPos) => s + Object.keys(byPos).length, 0);
  const cells = Object.values(itemStats)
    .flatMap((byPos) => Object.values(byPos))
    .reduce((s, byItem) => s + Object.keys(byItem).length, 0);
  return { itemCount: itemIds.size, heroesWithData: Object.keys(itemStats).length, positions, cells };
}


