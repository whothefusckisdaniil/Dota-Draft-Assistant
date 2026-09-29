/**
 * The worst case of the directory swap (ТЗ №7 §7, post-review hardening).
 *
 * `rename(data -> __prev)` succeeds, `rename(__next -> data)` fails, and the
 * restore `rename(__prev -> data)` fails too. The live tree is now gone and the
 * outgoing snapshot sits in `data.__prev`.
 *
 * The critical requirement: `data.__prev` must SURVIVE. An earlier version swept
 * it up in the outer cleanup, which turned a recoverable near-miss into total
 * data loss. These tests drive that exact sequence through a mocked `rename`.
 */
import { mkdtemp, readdir, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Decides whether a given `rename(from, to)` should fail. */
let shouldFail: (from: string, to: string) => boolean = () => false;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    rename: async (from: string, to: string) => {
      if (shouldFail(from, to)) {
        const err = new Error(`EIO: simulated rename failure (${from} -> ${to})`);
        Object.assign(err, { code: 'EIO' });
        throw err;
      }
      return actual.rename(from, to);
    },
  };
});

const { publishDatasetAtomically, NEXT_SUFFIX, PREV_SUFFIX } = await import('./dataset-publish.mjs');

/** Position layer with every lane at 20% — valid, and irrelevant to the swap logic. */
const posLayer = (ids: number[]) =>
  Object.fromEntries(
    ids.map((id) => [
      id,
      { totalGames: 500, positions: Object.fromEntries(['1', '2', '3', '4', '5'].map((p) => [p, { games: 100, share: 0.2 }])) },
    ]),
  );
/** Item catalogue + statistics — part of the same snapshot since ТЗ §12 §26. */
const itemLayer = (ids: number[]) =>
  Object.fromEntries(
    ids.map((id) => [
      id,
      { id, name: `Item ${id}`, dname: `item_${id}`, shortName: '', cost: 100, isPurchasable: true, isStackable: false, isSideShop: false, stockMax: 0, isSupportFullItem: false, image: '', components: [] },
    ]),
  );
const statLayer = (ids: number[]) =>
  Object.fromEntries(
    ids.map((id) => [id, { 1: { 1: { purchases: 5, wins: 2, heroGames: 100, byMinute: { 8: 5 }, instances: { 0: 5 } } } }]),
  );

const OLD_SNAPSHOT = {
  'heroes.json': [{ id: 111 }],
  'matchups.json': { 111: [] },
  'positions.json': posLayer([111]),
  'items.json': itemLayer([1]),
  'item-stats.json': statLayer([111]),
  'meta.json': { source: 'OLD', heroCount: 1 },
};

const newSnapshot = () => ({
  'heroes.json': [{ id: 1 }, { id: 2 }, { id: 3 }],
  'matchups.json': { 1: [{ hero_id: 2 }, { hero_id: 3 }], 2: [{ hero_id: 1 }, { hero_id: 3 }], 3: [{ hero_id: 1 }, { hero_id: 2 }] },
  'positions.json': posLayer([1, 2, 3]),
  'items.json': itemLayer([1, 145, 108]),
  'item-stats.json': statLayer([1, 2, 3]),
  'meta.json': { source: 'NEW', heroCount: 3 },
});

async function seed() {
  const root = await mkdtemp(path.join(tmpdir(), 'rollback-'));
  const dir = path.join(root, 'data');
  await mkdir(dir, { recursive: true });
  for (const [name, data] of Object.entries(OLD_SNAPSHOT)) {
    await writeFile(path.join(dir, name), JSON.stringify(data));
  }
  return { root, dir };
}

/** Every file in `dir` as `{ name: contents }`, for byte-for-byte comparisons. */
const readAll = async (dir: string) =>
  Object.fromEntries(
    await Promise.all(
      (await readdir(dir)).map(async (n) => [n, await readFile(path.join(dir, n), 'utf8')]),
    ),
  );

beforeEach(() => { shouldFail = () => false; });
afterEach(() => { shouldFail = () => false; });

describe('publishDatasetAtomically — when the restore itself fails', () => {
  it('keeps the outgoing snapshot in __prev instead of deleting it', async () => {
    const { root, dir } = await seed();
    const backup = path.join(root, PREV_SUFFIX);
    const staged = path.join(root, NEXT_SUFFIX);

    // Fail every rename whose destination is the live path: that is the
    // swap-in (`__next -> data`) AND the restore (`__prev -> data`). The
    // move-aside (`data -> __prev`) still succeeds, so the old tree really does
    // end up stranded in `backup` — which is the situation under test.
    shouldFail = (_from, to) => to === dir;

    await expect(publishDatasetAtomically(dir, newSnapshot())).rejects.toThrow(/CRITICAL/);

    // The whole point: the last good dataset is still on disk, intact.
    expect(await readdir(backup)).toEqual(['heroes.json', 'item-stats.json', 'items.json', 'matchups.json', 'meta.json', 'positions.json']);
    expect(await readFile(path.join(backup, 'meta.json'), 'utf8')).toBe(JSON.stringify(OLD_SNAPSHOT['meta.json']));
    expect(await readFile(path.join(backup, 'heroes.json'), 'utf8')).toBe(JSON.stringify(OLD_SNAPSHOT['heroes.json']));

    // The rejected new snapshot is swept entirely; the backup is not touched.
    await expect(readdir(staged)).rejects.toThrow(/ENOENT/);

    await rm(root, { recursive: true, force: true });
  });

  it('names the recovery path in the error so an operator can finish by hand', async () => {
    const { root, dir } = await seed();
    const backup = path.join(root, PREV_SUFFIX);
    shouldFail = (_from, to) => to === dir;

    const err = await publishDatasetAtomically(dir, newSnapshot()).catch((e: Error) => e);
    expect(String(err)).toContain('CRITICAL');
    expect(String(err)).toContain(backup);           // where the data is
    expect(String(err)).toContain(`mv ${backup}`);   // and the exact command

    await rm(root, { recursive: true, force: true });
  });

  it('does NOT destroy the recovery snapshot on the NEXT run (ТЗ №8 regression)', async () => {
    // The full incident, end to end. This is the bug that survived the previous
    // fix: the CRITICAL branch above correctly left `data.__prev` on disk, but
    // the *next* invocation started with `rm(backup)`, wiping the only surviving
    // copy of the last good dataset. Recovery had to survive until a human acted.
    const { root, dir } = await seed();
    const backup = path.join(root, PREV_SUFFIX);

    // --- A. critical failure: swap-in fails, then the restore fails -----------
    shouldFail = (_from, to) => to === dir;
    await expect(publishDatasetAtomically(dir, newSnapshot())).rejects.toThrow(/CRITICAL/);

    // --- B. state left behind -------------------------------------------------
    expect(await readdir(root)).not.toContain('data');       // live tree is gone
    expect(await readdir(backup)).toEqual(['heroes.json', 'item-stats.json', 'items.json', 'matchups.json', 'meta.json', 'positions.json']);
    expect(await readFile(path.join(backup, 'meta.json'), 'utf8')).toBe(JSON.stringify(OLD_SNAPSHOT['meta.json']));
    const preserved = await readAll(backup);

    // --- C. the next run must fail closed, not clean up ------------------------
    shouldFail = () => false; // the filesystem is healthy again
    const err = await publishDatasetAtomically(dir, newSnapshot()).catch((e: Error) => e);

    expect(String(err)).toMatch(/Recovery snapshot already exists/);
    expect(String(err)).toContain(backup);
    expect(String(err)).toContain(`mv ${backup} ${dir}`);

    // The recovery copy is byte-for-byte what it was, and nothing else appeared.
    expect(await readAll(backup)).toEqual(preserved);
    expect((await readdir(root)).sort()).toEqual([PREV_SUFFIX]);

    // --- recovery is actually possible ----------------------------------------
    await rename(backup, dir);
    expect(await readAll(dir)).toEqual(preserved);
    // And with the recovery applied, publishing works again.
    await publishDatasetAtomically(dir, newSnapshot());
    expect(JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8')).source).toBe('NEW');
    expect((await readdir(root)).sort()).toEqual(['data']);

    await rm(root, { recursive: true, force: true });
  });

  it('restores normally when only the swap-in fails', async () => {
    const { root, dir } = await seed();
    // Fail only the first rename into the live path — the swap-in. The restore
    // (`__prev -> data`) is the second one into that path and must be allowed.
    let into = 0;
    shouldFail = (_from, to) => {
      if (to !== dir) return false;
      into += 1;
      return into === 1;
    };

    const err = await publishDatasetAtomically(dir, newSnapshot()).catch((e: Error) => e);
    expect(String(err)).toMatch(/swap failed, previous dataset restored/);
    expect(String(err)).not.toContain('CRITICAL');

    // Old dataset is live again, byte for byte.
    expect(await readdir(dir)).toEqual(['heroes.json', 'item-stats.json', 'items.json', 'matchups.json', 'meta.json', 'positions.json']);
    expect(await readFile(path.join(dir, 'meta.json'), 'utf8')).toBe(JSON.stringify(OLD_SNAPSHOT['meta.json']));
    // And the backup was reclaimed, since the restore consumed it.
    expect(await readdir(root)).toEqual(['data']);

    await rm(root, { recursive: true, force: true });
  });
});
