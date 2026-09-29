#!/usr/bin/env node
/**
 * Shared OpenDota hero-metadata loader.
 *
 * Single source of truth for the `/heroes` + `/heroStats` + `/constants/patch`
 * pipeline and for `normalizeHero()`. Both generators import it:
 *
 *   scripts/update-data-stratz.mjs   production: OpenDota metadata + STRATZ matchups
 *   scripts/update-data.mjs          OpenDota-only rollback path
 *
 * Keeping one copy matters: before this module existed the STRATZ generator
 * carried its own (absent) metadata handling and silently reused a stale
 * committed `heroes.json`, which froze new heroes, roles, images, pub/pro
 * stats and the patch number.
 *
 * No deps: global fetch (Node 18+). Nothing here writes to disk.
 */

/**
 * `OPEN_DOTA_API` is env-overridable purely so the failure policy can be
 * integration-tested against an unreachable host (see ТЗ §3: a dead OpenDota
 * must abort the run *before* any STRATZ request is made). Production and CI
 * leave it unset.
 */
export const OPEN_DOTA_API = process.env.OPEN_DOTA_API || 'https://api.opendota.com/api';
export const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com';

/** OpenDota is polled for a handful of JSON documents; retries are cheap. */
export const RETRIES = 6;
export const BASE_BACKOFF_MS = 5000;
const REQUEST_TIMEOUT_MS = 30000;

/** A hero snapshot below this size is a broken response, not a roster change. */
export const MIN_HERO_COUNT = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET + JSON parse with exponential backoff on 429/5xx and transport errors.
 *
 * `backoffMs` is injectable so retry behaviour is testable without the test
 * suite sitting through 5 + 10 + 20s of real sleeping.
 */
export async function fetchJson(
  url,
  { fetchImpl = fetch, retries = RETRIES, backoffMs = BASE_BACKOFF_MS, log = console.warn } = {},
) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
      } else if (!res.ok) {
        // A deterministic 4xx will not fix itself — fail fast.
        throw new Error(`HTTP ${res.status} for ${url}`);
      } else {
        return await res.json();
      }
    } catch (e) {
      lastErr = e;
      if (e instanceof Error && /^HTTP 4\d\d/.test(e.message)) throw e;
    }
    if (attempt < retries) {
      const wait = backoffMs * 2 ** (attempt - 1);
      log(
        `  retry ${attempt}/${retries} after ${Math.round(wait / 1000)}s (${lastErr?.message ?? 'error'})`,
      );
      await sleep(wait);
    }
  }
  throw lastErr;
}

/**
 * The committed `heroes.json` contract. This file contains the normalized
 * OpenDota hero metadata, including the authoritative `key`.
 */
export function normalizeHero(h, statsById) {
  const s = statsById.get(h.id) ?? {};
  return {
    id: h.id,
    // The authoritative Valve/OpenDota internal name, used verbatim as the
    // canonical hero identity. It is NOT derived from `localized_name`:
    // slugifying the display name produces wrong keys for many heroes
    // (Anti-Mage -> npc_dota_hero_anti_mage, but Valve says npc_dota_hero_antimage),
    // and that silently broke the itembuild join for 20 of 127 heroes (ТЗ №18).
    key: h.name,
    name: h.localized_name,
    primaryAttr: h.primary_attr,
    attackType: h.attack_type,
    // Copied, not aliased: the caller must not be able to mutate the parsed
    // OpenDota response through the normalized object.
    roles: Array.isArray(h.roles) ? [...h.roles] : [],
    img: typeof s.img === 'string' ? `${STEAM_CDN}${s.img}` : '',
    icon: typeof s.icon === 'string' ? `${STEAM_CDN}${s.icon}` : '',
    proPick: typeof s.pro_pick === 'number' ? s.pro_pick : 0,
    proWin: typeof s.pro_win === 'number' ? s.pro_win : 0,
    pubPick: typeof s.pub_pick === 'number' ? s.pub_pick : 0,
    pubWin: typeof s.pub_win === 'number' ? s.pub_win : 0,
  };
}

/** `/constants/patch` is keyed by patch name; the newest id is the current one. */
export function latestPatchFrom(patches) {
  const list = Object.values(patches ?? {})
    .filter((p) => p && typeof p.name === 'string')
    .sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  return list[0]?.name ?? '';
}

/**
 * Integrity gates for a freshly fetched OpenDota metadata payload.
 *
 * The point is to fail *here* rather than ship: a truncated `/heroes` response
 * or an empty patch map must abort the whole run, never be papered over with a
 * previous run's values.
 */
export function validateHeroMetadata(heroes, latestPatch) {
  if (!Array.isArray(heroes) || heroes.length < MIN_HERO_COUNT) {
    throw new Error(
      `OpenDota hero metadata incomplete: got ${Array.isArray(heroes) ? heroes.length : 'no array'} heroes, expected >= ${MIN_HERO_COUNT}`,
    );
  }
  const seen = new Set();
  const seenKeys = new Set();
  for (const h of heroes) {
    if (!Number.isInteger(h.id) || h.id <= 0) throw new Error(`invalid hero id: ${h.id}`);
    if (typeof h.name !== 'string' || h.name.length === 0) {
      throw new Error(`invalid name for hero ${h.id}`);
    }
    // The authoritative internal key must be present, well-formed and unique.
    // There is deliberately NO fallback to a display-name slug: a silent
    // fallback is how the 20-hero mismatch came back in the first place.
    if (typeof h.key !== 'string' || h.key.length === 0) {
      throw new Error(
        `missing authoritative npc_dota_hero key for hero ${h.id} (${h.name}) — ` +
        'refusing to derive one from the display name',
      );
    }
    if (!/^npc_dota_hero_[a-z0-9_]+$/.test(h.key)) {
      throw new Error(`malformed hero key "${h.key}" for hero ${h.id} (${h.name})`);
    }
    if (seenKeys.has(h.key)) {
      throw new Error(`duplicate hero key ${h.key} (heroes ${[...seenKeys].indexOf(h.key)} and ${h.id})`);
    }
    seenKeys.add(h.key);
    if (!Array.isArray(h.roles)) throw new Error(`invalid roles for hero ${h.id}`);
    if (typeof h.img !== 'string' || h.img.length === 0) {
      throw new Error(`missing portrait image for hero ${h.id} (${h.name})`);
    }
    if (seen.has(h.id)) throw new Error(`duplicate hero id ${h.id}`);
    seen.add(h.id);
  }
  if (typeof latestPatch !== 'string' || !/^\d+\.\d+/.test(latestPatch)) {
    throw new Error(`OpenDota patch metadata unusable: ${JSON.stringify(latestPatch)}`);
  }
  return { heroCount: heroes.length, heroIds: [...seen], heroKeys: [...seenKeys] };
}

/**
 * Fetch + normalize the canonical hero roster.
 *
 * Resolves to the *only* hero list the run may use: STRATZ is queried for
 * exactly these ids, and the same array is validated and published. Throws on
 * any fetch or validation problem — callers must abort the entire run.
 *
 * @param {{ fetchImpl?: typeof fetch, backoffMs?: number, log?: Function }} [options]
 * @returns {Promise<{ heroes: object[], latestPatch: string, heroCount: number }>}
 */
export async function fetchOpenDotaMetadata({ fetchImpl = fetch, backoffMs, log } = {}) {
  const get = (url) => fetchJson(url, { fetchImpl, backoffMs, log });
  const [list, stats, patches] = await Promise.all([
    get(`${OPEN_DOTA_API}/heroes`),
    get(`${OPEN_DOTA_API}/heroStats`),
    get(`${OPEN_DOTA_API}/constants/patch`),
  ]);
  if (!Array.isArray(list)) throw new Error('OpenDota /heroes did not return an array');
  if (!Array.isArray(stats)) throw new Error('OpenDota /heroStats did not return an array');

  const statsById = new Map(stats.map((s) => [s.id, s]));
  const heroes = list.map((h) => normalizeHero(h, statsById));
  const latestPatch = latestPatchFrom(patches);
  validateHeroMetadata(heroes, latestPatch);

  return { heroes, latestPatch, heroCount: heroes.length };
}
