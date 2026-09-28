/**
 * Contract tests for the shared OpenDota metadata loader (ТЗ №7 §8A).
 *
 * `heroes.json` is the app's only source of names, roles, portraits and
 * pub/pro stats, and `latestPatch` is shown to the user as "current patch".
 * A silent regression here is invisible in a diff — the file still parses, it
 * is just months out of date — so normalization and the fetch wiring are pinned
 * explicitly. Nothing here touches the network: `fetchImpl` is injected.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  fetchJson,
  fetchOpenDotaMetadata,
  latestPatchFrom,
  normalizeHero,
  validateHeroMetadata,
  STEAM_CDN,
} from './metadata.mjs';

type RawHero = {
  id: number;
  localized_name: string;
  primary_attr?: string;
  attack_type?: string;
  roles?: string[];
};

/** Minimal OpenDota /heroes entry. */
function rawHero(id: number, over: Partial<RawHero> = {}): RawHero {
  return { id, localized_name: `Hero ${id}`, primary_attr: 'STR', attack_type: 'Melee', roles: ['Carry'], ...over };
}

/** Minimal OpenDota /heroStats entry. */
function rawStat(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    img: `/apps/dota2/images/dota_react/heroes/${id}.png`,
    icon: `/x${id}.png`,
    pub_pick: 10, pub_win: 5, pro_pick: 3, pro_win: 2,
    ...over,
  };
}

/** A fetch stub over a fixed route table; `overrides` makes one route fail. */
function stubFetch(
  { heroCount = 120, overrides = {} }: { heroCount?: number; overrides?: Record<string, () => never> } = {},
) {
  const routes: Record<string, unknown> = {
    '/api/heroes': Array.from({ length: heroCount }, (_, i) => rawHero(i + 1)),
    '/api/heroStats': Array.from({ length: heroCount }, (_, i) => rawStat(i + 1)),
    '/api/constants/patch': { '7.38': { id: 12, name: '7.38' }, '7.41': { id: 15, name: '7.41' }, '7.40': { id: 14, name: '7.40' } },
  };
  const fetchImpl = vi.fn(async (url: string) => {
    const key = new URL(url).pathname;
    if (overrides[key]) return overrides[key]();
    if (!(key in routes)) throw new Error(`unexpected request: ${url}`);
    return { ok: true, status: 200, json: async () => routes[key] };
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls: fetchImpl };
}

describe('normalizeHero — the committed heroes.json contract', () => {
  it('maps every field of the published format', () => {
    const h = normalizeHero(rawHero(74, { localized_name: 'Invoker' }), new Map([[74, rawStat(74)]]));
    expect(h).toEqual({
      id: 74,
      name: 'Invoker',
      primaryAttr: 'STR',
      attackType: 'Melee',
      roles: ['Carry'],
      img: `${STEAM_CDN}/apps/dota2/images/dota_react/heroes/74.png`,
      icon: `${STEAM_CDN}/x74.png`,
      proPick: 3,
      proWin: 2,
      pubPick: 10,
      pubWin: 5,
    });
  });

  it('emits exactly the 11 contract keys, in order', () => {
    expect(Object.keys(normalizeHero(rawHero(1), new Map([[1, rawStat(1)]])))).toEqual([
      'id', 'name', 'primaryAttr', 'attackType', 'roles',
      'img', 'icon', 'proPick', 'proWin', 'pubPick', 'pubWin',
    ]);
  });

  it('falls back to an empty roles array when the field is not an array', () => {
    expect(normalizeHero(rawHero(1, { roles: undefined }), new Map()).roles).toEqual([]);
    expect(normalizeHero(rawHero(1, { roles: 'Carry' as never }), new Map()).roles).toEqual([]);
  });

  it('zeroes missing or mistyped stats instead of writing NaN', () => {
    const h = normalizeHero(rawHero(1), new Map([[1, { id: 1, pub_pick: 'lots', pro_win: null }]]));
    // The whole point: a missing stat must not become NaN in the committed JSON.
    for (const k of ['proPick', 'proWin', 'pubPick', 'pubWin'] as const) {
      expect(h[k], k).toBe(0);
      expect(Number.isNaN(h[k])).toBe(false);
    }
    expect(h.img).toBe(''); // no stats row at all -> no portrait, flagged by validation
  });

  it('does not alias the input objects', () => {
    const src = rawHero(1, { roles: ['Carry'] });
    const h = normalizeHero(src, new Map());
    h.roles.push('Support');
    expect(src.roles).toEqual(['Carry']);
  });
});

describe('latestPatchFrom — the displayed "current patch"', () => {
  it('picks the highest patch id, not the last key', () => {
    expect(latestPatchFrom({ '7.38': { id: 12, name: '7.38' }, '7.41': { id: 15, name: '7.41' } })).toBe('7.41');
    // Insertion order deliberately reversed: `Object.values().at(-1)` would answer 7.38 here.
    expect(latestPatchFrom({ '7.41': { id: 15, name: '7.41' }, '7.38': { id: 12, name: '7.38' } })).toBe('7.41');
  });

  it('returns an empty string for an empty or malformed map', () => {
    expect(latestPatchFrom({})).toBe('');
    expect(latestPatchFrom(null)).toBe('');
  });
});

describe('validateHeroMetadata — gates that stop a stale snapshot shipping', () => {
  // A valid full roster, plus one controlled defect. The >=100 count gate runs
  // first, so each case starts from a 120-hero baseline and breaks exactly one thing.
  const roster = (n = 120) =>
    Array.from({ length: n }, (_, i) => normalizeHero(rawHero(i + 1), new Map([[i + 1, rawStat(i + 1)]])));

  it('accepts a full roster', () => {
    expect(validateHeroMetadata(roster(), '7.41').heroCount).toBe(120);
  });

  it('rejects a truncated /heroes response instead of publishing a short roster', () => {
    expect(() => validateHeroMetadata(roster(12), '7.41')).toThrow(/hero metadata incomplete/);
  });

  it('rejects an empty or non-array roster', () => {
    expect(() => validateHeroMetadata([], '7.41')).toThrow(/hero metadata incomplete/);
    expect(() => validateHeroMetadata(null, '7.41')).toThrow(/hero metadata incomplete/);
  });

  it('rejects a missing patch — no fallback to the previously committed value', () => {
    expect(() => validateHeroMetadata(roster(), '')).toThrow(/patch metadata unusable/);
    expect(() => validateHeroMetadata(roster(), null)).toThrow(/patch metadata unusable/);
  });

  it('rejects a hero without a portrait (an incomplete heroStats response)', () => {
    const bad = roster();
    bad[41] = { ...bad[41], img: '' };
    expect(() => validateHeroMetadata(bad, '7.41')).toThrow(/missing portrait image for hero 42/);
  });

  it('rejects duplicate ids, which would silently drop a hero from the STRATZ query', () => {
    const bad = roster();
    bad[7] = { ...bad[6] };
    expect(() => validateHeroMetadata(bad, '7.41')).toThrow(/duplicate hero id 7/);
  });
});

describe('fetchOpenDotaMetadata', () => {
  it('requests all three endpoints and returns a normalized roster + patch', async () => {
    const { fetchImpl, calls } = stubFetch({ heroCount: 120 });
    const { heroes, latestPatch, heroCount } = await fetchOpenDotaMetadata({ fetchImpl });
    expect(heroCount).toBe(120);
    expect(heroes).toHaveLength(120);
    expect(latestPatch).toBe('7.41');
    expect(heroes[0]).toEqual(expect.objectContaining({ id: 1, name: 'Hero 1' }));
    const paths = calls.mock.calls.map((c) => new URL(c[0] as string).pathname).sort();
    expect(paths).toEqual(['/api/constants/patch', '/api/heroStats', '/api/heroes']);
  });

  it('joins heroStats by hero id, not by array index', async () => {
    // A full, valid roster — but /heroStats arrives in a DIFFERENT order than
    // /heroes. Positional zipping (heroes[i] <-> stats[i]) would silently attach
    // every hero's portrait and stats to the wrong hero while every individual
    // field still looks plausible. pub_pick encodes the id so misalignment shows.
    const heroesPayload = Array.from({ length: 120 }, (_, i) => rawHero(i + 1));
    const statsPayload = Array.from({ length: 120 }, (_, i) => rawStat(120 - i, { pub_pick: 120 - i }));
    const fetchImpl = vi.fn(async (url: string) => {
      const p = new URL(url).pathname;
      if (p === '/api/heroes') return { ok: true, status: 200, json: async () => heroesPayload };
      if (p === '/api/heroStats') return { ok: true, status: 200, json: async () => statsPayload };
      return { ok: true, status: 200, json: async () => ({ p: { id: 1, name: '7.41' } }) };
    });
    const { heroes } = await fetchOpenDotaMetadata({ fetchImpl: fetchImpl as unknown as typeof fetch });
    for (const h of heroes) {
      expect(h.pubPick, `hero ${h.id}`).toBe(h.id);
      expect(h.img, `hero ${h.id}`).toContain(`heroes/${h.id}.png`);
    }
  });

  it('propagates a failing /heroes endpoint instead of returning a partial roster', async () => {
    const { fetchImpl } = stubFetch({
      overrides: { '/api/heroes': () => { throw new Error('network down'); } },
    });
    await expect(fetchOpenDotaMetadata({ fetchImpl, backoffMs: 0, log: () => {} })).rejects.toThrow(/network down/);
  });

  it('propagates a failing /constants/patch rather than defaulting the patch', async () => {
    const { fetchImpl } = stubFetch({
      overrides: { '/api/constants/patch': () => { throw new Error('patch service down'); } },
    });
    await expect(fetchOpenDotaMetadata({ fetchImpl, backoffMs: 0, log: () => {} })).rejects.toThrow(/patch service down/);
  });

  it('rejects a non-array /heroes payload', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      new URL(url).pathname === '/api/heroes'
        ? { ok: true, status: 200, json: async () => ({ error: 'nope' }) }
        : { ok: true, status: 200, json: async () => [] },
    );
    await expect(
      fetchOpenDotaMetadata({ fetchImpl: fetchImpl as unknown as typeof fetch, backoffMs: 0, log: () => {} }),
    ).rejects.toThrow(/did not return an array/);
  });

  it('rejects a roster that shrank below the floor (partial /heroes response)', async () => {
    // A truncated response is the exact failure that would otherwise silently
    // delete heroes from the app; it must abort, never publish a short roster.
    const { fetchImpl } = stubFetch({ heroCount: 40 });
    await expect(
      fetchOpenDotaMetadata({ fetchImpl, backoffMs: 0, log: () => {} }),
    ).rejects.toThrow(/hero metadata incomplete/);
  });
});

describe('fetchJson — retry policy', () => {
  const ok = () => ({ ok: true, status: 200, json: async () => ({ fine: true }) });

  it('retries a 500 and succeeds', async () => {
    let n = 0;
    const impl = vi.fn(async () => (++n < 3 ? { ok: false, status: 500 } : ok()));
    const res = await fetchJson('https://x/api/heroes', { fetchImpl: impl as unknown as typeof fetch, retries: 5, backoffMs: 0, log: () => {} });
    expect(res).toEqual({ fine: true });
    expect(impl).toHaveBeenCalledTimes(3);
  });

  it('retries a 429', async () => {
    let n = 0;
    const impl = vi.fn(async () => (++n < 2 ? { ok: false, status: 429 } : ok()));
    await fetchJson('https://x/api/heroes', { fetchImpl: impl as unknown as typeof fetch, retries: 3, backoffMs: 0, log: () => {} });
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it('fails fast on a deterministic 404 without retrying', async () => {
    const impl = vi.fn(async () => ({ ok: false, status: 404 }));
    await expect(
      fetchJson('https://x/api/heroes', { fetchImpl: impl as unknown as typeof fetch, retries: 5, backoffMs: 0, log: () => {} }),
    ).rejects.toThrow(/HTTP 404/);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget', async () => {
    const impl = vi.fn(async () => ({ ok: false, status: 503 }));
    await expect(
      fetchJson('https://x/api/heroes', { fetchImpl: impl as unknown as typeof fetch, retries: 2, backoffMs: 0, log: () => {} }),
    ).rejects.toThrow(/HTTP 503/);
    expect(impl).toHaveBeenCalledTimes(2);
  });
});
