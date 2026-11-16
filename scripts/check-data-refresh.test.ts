import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decideDataRefresh, runPreflight, writeGitHubOutputs } from './check-data-refresh.mjs';
import { datasetFingerprint } from './dataset-fingerprint.mjs';
import { DATASET_FILES } from './dataset-publish.mjs';

const buckets = [2963, 2964, 2965, 2966, 2967];
const publishedMeta = {
  source: 'STRATZ',
  latestPatch: '7.41',
  matchupWindow: {
    kind: 'rolling-days',
    days: 30,
    windowStartUtc: '2026-10-17T00:00:00Z',
    windowEndUtc: '2026-11-16T03:20:00.000Z',
    weeklyBuckets: buckets,
  },
  positionData: { days: 30, weeklyBuckets: buckets },
};
/** The pre-rolling format (4 complete weeks) that is still on main before the first rolling run. */
const legacyMeta = {
  source: 'STRATZ',
  latestPatch: '7.41',
  matchupWindow: {
    weeks: 4,
    weeklyBuckets: [2957, 2958, 2959, 2960],
    completeWeeksOnly: true,
    windowStartUtc: '2026-09-03T00:00:00Z',
    windowEndUtcExclusive: '2026-10-01T00:00:00Z',
  },
  positionData: { weeks: 4, weeklyBuckets: [2957, 2958, 2959, 2960], completeWeeksOnly: true },
};
const SAME_DAY = new Date('2026-11-16T18:00:00Z');
const NEXT_DAY = new Date('2026-11-17T03:17:00Z');
const dirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dataset-refresh-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('decideDataRefresh', () => {
  it('returns NO_CHANGE when the published window already ends today', () => {
    expect(decideDataRefresh({ publishedMeta, detectedPatch: '7.41', now: SAME_DAY }))
      .toMatchObject({ refreshRequired: false, windowChanged: false, reason: 'NO_CHANGE' });
  });

  it('refreshes once a new UTC day starts (the window slides by a day)', () => {
    expect(decideDataRefresh({ publishedMeta, detectedPatch: '7.41', now: NEXT_DAY })).toMatchObject({
      refreshRequired: true, windowChanged: true, reason: 'NEW_DAY', today: '2026-11-17', publishedWindowDay: '2026-11-16',
    });
  });

  it('a new patch triggers a refresh the same day (the window is cut at the patch)', () => {
    expect(decideDataRefresh({ publishedMeta, detectedPatch: '7.42', now: SAME_DAY }))
      .toMatchObject({ refreshRequired: true, windowChanged: true, reason: 'NEW_PATCH', detectedPatch: '7.42', publishedPatch: '7.41' });
  });

  it('replaces the legacy 4-complete-weeks format on the first run', () => {
    expect(decideDataRefresh({ publishedMeta: legacyMeta, detectedPatch: '7.41', now: SAME_DAY }))
      .toMatchObject({ refreshRequired: true, windowChanged: true, reason: 'WINDOW_FORMAT_CHANGED' });
  });

  it('refreshes on an explicit force even on the same day', () => {
    expect(decideDataRefresh({ publishedMeta, detectedPatch: '7.41', now: SAME_DAY, force: true }))
      .toMatchObject({ refreshRequired: true, windowChanged: false, reason: 'FORCE' });
  });

  it('fails closed for invalid detected patches and malformed published metadata', () => {
    expect(() => decideDataRefresh({ publishedMeta, detectedPatch: '', now: SAME_DAY }))
      .toThrow(/detected OpenDota patch is invalid/);
    expect(() => decideDataRefresh({
      publishedMeta: { ...publishedMeta, matchupWindow: { kind: 'rolling-days', days: 30 } },
      detectedPatch: '7.42',
      now: SAME_DAY,
    })).toThrow(/valid STRATZ matchup window/);
    expect(() => decideDataRefresh({ publishedMeta: { ...publishedMeta, source: 'OpenDota' }, detectedPatch: '7.41', now: SAME_DAY }))
      .toThrow(/source must be STRATZ/);
  });

  it('fails preflight when OpenDota metadata fetch fails and writes no job outputs', async () => {
    const dir = await tempDir();
    const metaPath = path.join(dir, 'meta.json');
    const outputPath = path.join(dir, 'github-output');
    await writeFile(metaPath, JSON.stringify(publishedMeta));
    await expect(runPreflight({
      metaPath,
      outputPath,
      fetchMetadata: async () => { throw new Error('OpenDota unavailable'); },
      now: new Date('2026-10-08T03:17:00Z'),
      log: () => {},
    })).rejects.toThrow('OpenDota unavailable');
    await expect(readFile(outputPath, 'utf8')).rejects.toThrow();
  });

  it('writes the required GitHub job outputs for successful preflight', async () => {
    const outputPath = path.join(await tempDir(), 'github-output');
    const decision = decideDataRefresh({ publishedMeta, detectedPatch: '7.42', now: NEXT_DAY });
    await writeGitHubOutputs(outputPath, decision);
    const output = await readFile(outputPath, 'utf8');
    expect(output).toContain('refresh_required=true\n');
    expect(output).toContain('reason=NEW_PATCH\n');
    expect(output).toContain('detected_patch=7.42\n');
    expect(output).toContain('window_changed=true\n');
  });
});

describe('datasetFingerprint', () => {
  async function writeDataset(dir: string, overrides: Record<string, unknown> = {}) {
    await mkdir(dir, { recursive: true });
    for (const file of DATASET_FILES) {
      const payload = overrides[file] ?? (file === 'meta.json'
        ? { generatedAt: '2026-10-01T00:00:00.000Z', latestPatch: '7.41', details: { generatedAt: 'semantic-field' } }
        : { entries: [{ id: 1, name: 'snapshot' }] });
      await writeFile(path.join(dir, file), JSON.stringify(payload));
    }
  }

  it('ignores only meta.generatedAt and canonicalizes JSON object key order', async () => {
    const first = await tempDir();
    const second = await tempDir();
    await writeDataset(first);
    await writeDataset(second, {
      'meta.json': {
        details: { generatedAt: 'semantic-field' },
        latestPatch: '7.41',
        generatedAt: '2026-10-08T00:00:00.000Z',
      },
    });
    expect(await datasetFingerprint(first)).toBe(await datasetFingerprint(second));

    await writeDataset(second, {
      'meta.json': {
        details: { generatedAt: 'changed-semantic-field' },
        latestPatch: '7.41',
        generatedAt: '2026-10-08T00:00:00.000Z',
      },
    });
    expect(await datasetFingerprint(first)).not.toBe(await datasetFingerprint(second));
  });

  it('includes changes to every dataset file', async () => {
    for (const file of DATASET_FILES) {
      const first = await tempDir();
      const second = await tempDir();
      await writeDataset(first);
      await writeDataset(second, {
        [file]: file === 'meta.json'
          ? { generatedAt: 'later', latestPatch: '7.42', details: { generatedAt: 'semantic-field' } }
          : { entries: [{ id: 2, name: 'changed' }] },
      });
      expect(await datasetFingerprint(first), file).not.toBe(await datasetFingerprint(second));
    }
  });

  it('fails instead of fingerprinting a missing or malformed dataset file', async () => {
    const dir = await tempDir();
    await expect(datasetFingerprint(dir)).rejects.toThrow(/cannot fingerprint heroes.json/);
  });
});
