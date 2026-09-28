/**
 * Atomic dataset publication (ТЗ №7 §7).
 *
 * The defect this covers: heroes.json / matchups.json / meta.json used to be
 * written one rename at a time, so a failure between renames left the app
 * serving `heroes=new, matchups=old`. That combination parses fine and breaks
 * silently — a newly added hero has no matchup table and vanishes from results.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { publishDatasetAtomically, verifyStagedDataset } from './dataset-publish.mjs';

const tmpRoot = () => mkdtemp(path.join(tmpdir(), 'publish-test-'));

/** A minimal but *valid* snapshot: every table has heroCount-1 rows. */
function dataset(overrides: Record<string, unknown> = {}, n = 3) {
  const heroes = Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
  const matchups: Record<string, { hero_id: number }[]> = {};
  for (const h of heroes) {
    matchups[String(h.id)] = heroes.filter((o) => o.id !== h.id).map((o) => ({ hero_id: o.id }));
  }
  // positions.json is part of the same snapshot (ТЗ №9 §16).
  const positions: Record<string, unknown> = {};
  for (const h of heroes) {
    positions[String(h.id)] = {
      totalGames: 5000,
      positions: Object.fromEntries(
        ['1', '2', '3', '4', '5'].map((p) => [p, { games: 1000, share: 0.2 }]),
      ),
    };
  }
  return {
    'heroes.json': heroes,
    'matchups.json': matchups,
    'positions.json': positions,
    'meta.json': { source: 'STRATZ', heroCount: n, ...overrides },
    ...overrides,
  };
}

const readAll = async (dir: string) =>
  Object.fromEntries(
    await Promise.all((await readdir(dir)).map(async (n) => [n, await readFile(path.join(dir, n), 'utf8')])),
  );

describe('publishDatasetAtomically — success path', () => {
  it('writes all three files and reports their sizes', async () => {
    const root = await tmpRoot();
    const dir = path.join(root, 'data');
    const sizes = await publishDatasetAtomically(dir, dataset());

    expect(Object.keys(sizes).sort()).toEqual(['heroes.json', 'matchups.json', 'meta.json', 'positions.json']);
    for (const [name, bytes] of Object.entries(sizes)) {
      expect(bytes, name).toBe(Buffer.byteLength(JSON.stringify(dataset()[name])));
    }
    expect(JSON.parse(await readFile(path.join(dir, 'heroes.json'), 'utf8'))).toEqual(dataset()['heroes.json']);
    await rm(root, { recursive: true, force: true });
  });

  it('leaves no staging or backup directory behind', async () => {
    const root = await tmpRoot();
    // A leftover `data.__next__` would be served by the CDN and committed by
    // `git add public/`; a leftover `data.__prev__` doubles the payload forever.
    await publishDatasetAtomically(path.join(root, 'data'), dataset());
    expect((await readdir(root)).sort()).toEqual(['data']);
    await rm(root, { recursive: true, force: true });
  });

  it('replaces the previous snapshot wholesale, so nothing stale leaks through', async () => {
    const root = await tmpRoot();
    const dir = path.join(root, 'data');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'heroes.json'), '[{"id":999}]');
    await writeFile(path.join(dir, 'stale-extra.json'), '{"old":true}');

    await publishDatasetAtomically(dir, dataset());

    expect((await readdir(dir)).sort()).toEqual(['heroes.json', 'matchups.json', 'meta.json', 'positions.json']);
    await rm(root, { recursive: true, force: true });
  });

  it('creates the dataset directory when it does not exist yet', async () => {
    const root = await tmpRoot();
    const dir = path.join(root, 'nested', 'data');
    await publishDatasetAtomically(dir, dataset());
    expect((await readdir(dir)).sort()).toEqual(['heroes.json', 'matchups.json', 'meta.json', 'positions.json']);
    await rm(root, { recursive: true, force: true });
  });

  it('cleans up a stale staging dir from a previous crashed run', async () => {
    // `data.__next` is only ever a half-written staging area, so discarding it
    // before starting is always safe (ТЗ №8 §2).
    const root = await tmpRoot();
    await mkdir(path.join(root, 'data.__next'), { recursive: true });
    await writeFile(path.join(root, 'data.__next', 'garbage.json'), '1');

    await publishDatasetAtomically(path.join(root, 'data'), dataset());

    // Stale staging must not be merged into the new dataset.
    expect((await readdir(root)).sort()).toEqual(['data']);
    await rm(root, { recursive: true, force: true });
  });

  it('refuses to start when a recovery snapshot is present, instead of deleting it', async () => {
    // `data.__prev` is NOT scratch space (ТЗ №8 §1). The old behaviour swept it
    // here, so a run following a failed swap destroyed the only surviving copy
    // of the last good dataset.
    const root = await tmpRoot();
    const dir = path.join(root, 'data');
    await mkdir(path.join(root, 'data.__prev'), { recursive: true });
    await writeFile(path.join(root, 'data.__prev', 'heroes.json'), '[{"id":111}]');

    const err = await publishDatasetAtomically(dir, dataset()).catch((e: Error) => e);
    expect(String(err)).toMatch(/Recovery snapshot already exists/);
    expect(String(err)).toContain(path.join(root, 'data.__prev'));
    expect(String(err)).toContain(`mv ${path.join(root, 'data.__prev')} ${dir}`);

    // Untouched, and no new dataset was written.
    expect(await readFile(path.join(root, 'data.__prev', 'heroes.json'), 'utf8')).toBe('[{"id":111}]');
    expect((await readdir(root)).sort()).toEqual(['data.__prev']);
    await rm(root, { recursive: true, force: true });
  });
});

describe('publishDatasetAtomically — the old dataset survives every failure', () => {
  /** Seed a live dataset that a failing publish must leave untouched. */
  async function seed() {
    const root = await tmpRoot();
    const dir = path.join(root, 'data');
    await mkdir(dir, { recursive: true });
    const old = {
      'heroes.json': [{ id: 111 }],
      'matchups.json': { 111: [] },
      'positions.json': {
        111: {
          totalGames: 5000,
          positions: Object.fromEntries(['1', '2', '3', '4', '5'].map((p) => [p, { games: 1000, share: 0.2 }])),
        },
      },
      'meta.json': { source: 'OLD' },
    };
    for (const [name, data] of Object.entries(old)) await writeFile(path.join(dir, name), JSON.stringify(data));
    return { root, dir, old };
  }

  it('leaves every old file byte-identical when serialization throws', async () => {
    const { root, dir, old } = await seed();
    // A circular payload is the canonical "cannot produce the snapshot" failure.
    // It must surface during staging, never after the swap has begun.
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(publishDatasetAtomically(dir, dataset({ 'meta.json': circular }))).rejects.toThrow();

    const after = await readAll(dir);
    for (const [name, expected] of Object.entries(old)) expect(after[name], name).toBe(JSON.stringify(expected));
    expect(Object.keys(after).sort()).toEqual(['heroes.json', 'matchups.json', 'meta.json', 'positions.json']);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a payload that omits one of the three files', async () => {
    const { root, dir, old } = await seed();
    const partial = dataset();
    delete (partial as Record<string, unknown>)['matchups.json'];

    await expect(publishDatasetAtomically(dir, partial)).rejects.toThrow(/missing payload for matchups\.json/);
    expect((await readAll(dir))['meta.json']).toBe(JSON.stringify(old['meta.json']));
    await rm(root, { recursive: true, force: true });
  });

  it('refuses to publish heroes and matchups from different snapshots', async () => {
    // The precise regression from ТЗ №7: a new roster (4 heroes) beside matchup
    // tables for the old one (3). Individual files are valid; the pair is not.
    const { root, dir, old } = await seed();
    const mixed = {
      'heroes.json': [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      'matchups.json': dataset()['matchups.json'],
      // Positions from the OLD 3-hero roster: another layer out of step (§6).
      'positions.json': dataset()['positions.json'],
      'meta.json': { source: 'STRATZ', heroCount: 4 },
    };
    await expect(publishDatasetAtomically(dir, mixed)).rejects.toThrow(/count mismatch|rows, expected/);
    expect((await readAll(dir))['heroes.json']).toBe(JSON.stringify(old['heroes.json']));
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a meta.json whose heroCount contradicts the roster', async () => {
    const { root, dir } = await seed();
    await expect(
      publishDatasetAtomically(dir, { ...dataset(), 'meta.json': { source: 'STRATZ', heroCount: 99 } }),
    ).rejects.toThrow(/heroCount=99/);
    expect((await readdir(dir)).sort()).toEqual(['heroes.json', 'matchups.json', 'meta.json', 'positions.json']);
    await rm(root, { recursive: true, force: true });
  });

  it('cleans up staging after a failure, leaving no debris for the next run', async () => {
    const { root, dir } = await seed();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(publishDatasetAtomically(dir, dataset({ 'matchups.json': circular }))).rejects.toThrow();
    expect((await readdir(root)).sort()).toEqual(['data']);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a short table only when completeness is required (STRATZ contract)', async () => {
    // OpenDota /matchups genuinely omits opponents it has no data for, and the
    // rollback path must keep working. STRATZ does not, so the STRATZ generator
    // opts in. This pins that the default is permissive and the opt-in is strict.
    const gappy = dataset();
    gappy['matchups.json']['2'] = [{ hero_id: 1 }];
    const dir = await mkdtemp(path.join(tmpdir(), 'gp-'));
    try {
      await expect(publishDatasetAtomically(path.join(dir, 'data'), gappy)).resolves.toBeDefined();
      await expect(
        publishDatasetAtomically(path.join(dir, 'data2'), gappy, { requireCompleteTables: true }),
      ).rejects.toThrow(/expected 2/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never exposes a mixed old/new snapshot to a concurrent reader', async () => {
    // The requirement in one sentence: no reader may ever see heroes from one
    // snapshot beside matchups from another. Sampled with synchronous reads
    // because an async reader can interleave its own three reads with the swap
    // and "witness" a mixture that was never actually on disk.
    const { dir } = await seed();
    let reads = 0;
    let mixed = 0;
    const reader = setInterval(() => {
      try {
        const heroes = JSON.parse(readFileSync(path.join(dir, 'heroes.json'), 'utf8'));
        const matchups = JSON.parse(readFileSync(path.join(dir, 'matchups.json'), 'utf8'));
        reads += 1;
        if (Object.keys(matchups).length !== heroes.length) mixed += 1;
      } catch {
        // The directory is momentarily absent mid-rename. Not a mixed snapshot:
        // a reader that retries sees the old or the new one, never a blend.
      }
    }, 0);
    try {
      for (let i = 1; i <= 5; i += 1) {
        await publishDatasetAtomically(dir, dataset({}, 3 + i));
      }
    } finally {
      clearInterval(reader);
    }
    expect(reads).toBeGreaterThan(0);
    expect(mixed).toBe(0);
  });
});

describe('verifyStagedDataset', () => {
  it('accepts a self-consistent snapshot', async () => {
    const root = await tmpRoot();
    const dir = path.join(root, 'data');
    await publishDatasetAtomically(dir, dataset());
    const result = await verifyStagedDataset(dir, { heroCount: 3 });
    expect(result.heroes).toHaveLength(3);
    expect(result.meta.source).toBe('STRATZ');
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a table that is one row short when completeness is required', async () => {
    const root = await tmpRoot();
    const dir = path.join(root, 'data');
    const short = dataset();
    short['matchups.json'] = { ...short['matchups.json'], 2: [{ hero_id: 1 }] };
    await expect(
      publishDatasetAtomically(dir, short, { requireCompleteTables: true }),
    ).rejects.toThrow(/rows, expected 2/);
    await rm(root, { recursive: true, force: true });
  });
});

