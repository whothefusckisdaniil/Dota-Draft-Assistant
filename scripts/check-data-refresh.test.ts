import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decideDataRefresh, runPreflight, writeGitHubOutputs } from './check-data-refresh.mjs';
import { datasetFingerprint } from './dataset-fingerprint.mjs';
import { DATASET_FILES } from './dataset-publish.mjs';

const publishedBuckets = [2957, 2958, 2959, 2960];
const publishedMeta = {
  source: 'STRATZ',
  latestPatch: '7.41',
  matchupWindow: {
    weeks: 4,
    weeklyBuckets: publishedBuckets,
    completeWeeksOnly: true,
  },
  positionData: {
    weeks: 4,
    weeklyBuckets: publishedBuckets,
    completeWeeksOnly: true,
  },
  itemData: {
    weeks: 4,
    weeklyBuckets: publishedBuckets,
    completeWeeksOnly: true,
  },
};

const sameWindow = { buckets: publishedBuckets, latestCompleteWeek: 2960 };
const newWindow = { buckets: [2958, 2959, 2960, 2961], latestCompleteWeek: 2961 };
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
  it('returns NO_CHANGE for the same patch and weekly window', () => {
    expect(decideDataRefresh({
      publishedMeta,
      detectedPatch: '7.41',
      currentWindow: sameWindow,
    })).toMatchObject({ refreshRequired: false, windowChanged: false, reason: 'NO_CHANGE' });
  });

  it('defers a patch-only change until a complete week is available', () => {
    expect(decideDataRefresh({
      publishedMeta,
      detectedPatch: '7.42',
      currentWindow: sameWindow,
    })).toMatchObject({
      refreshRequired: false,
      windowChanged: false,
      reason: 'PATCH_CHANGED_BUT_NO_NEW_WEEK',
      detectedPatch: '7.42',
      publishedPatch: '7.41',
    });
  });

  it('refreshes when a new complete bucket enters the window', () => {
    expect(decideDataRefresh({
      publishedMeta,
      detectedPatch: '7.41',
      currentWindow: newWindow,
    })).toMatchObject({ refreshRequired: true, windowChanged: true, reason: 'NEW_COMPLETE_WEEK' });
  });

  it('refreshes when the patch and complete weekly window both change', () => {
    expect(decideDataRefresh({
      publishedMeta,
      detectedPatch: '7.42',
      currentWindow: newWindow,
    })).toMatchObject({ refreshRequired: true, windowChanged: true, reason: 'NEW_COMPLETE_WEEK' });
  });

  it('refreshes on an explicit force regardless of the unchanged window', () => {
    expect(decideDataRefresh({
      publishedMeta,
      detectedPatch: '7.41',
      currentWindow: sameWindow,
      force: true,
    })).toMatchObject({ refreshRequired: true, windowChanged: false, reason: 'FORCE' });
  });

  it('fails closed for invalid detected patches and malformed published metadata', () => {
    expect(() => decideDataRefresh({
      publishedMeta,
      detectedPatch: '',
      currentWindow: sameWindow,
    })).toThrow(/detected OpenDota patch is invalid/);
    expect(() => decideDataRefresh({
      publishedMeta: { ...publishedMeta, matchupWindow: { weeklyBuckets: [1] } },
      detectedPatch: '7.42',
      currentWindow: sameWindow,
    })).toThrow(/four consecutive complete STRATZ weekly buckets/);
    expect(() => decideDataRefresh({
      publishedMeta,
      detectedPatch: '7.42',
      currentWindow: { ...sameWindow, latestCompleteWeek: 2959 },
    })).toThrow(/current STRATZ window is invalid/);
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
    const decision = decideDataRefresh({
      publishedMeta,
      detectedPatch: '7.42',
      currentWindow: newWindow,
    });
    await writeGitHubOutputs(outputPath, decision);
    const output = await readFile(outputPath, 'utf8');
    expect(output).toContain('refresh_required=true\n');
    expect(output).toContain('reason=NEW_COMPLETE_WEEK\n');
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
