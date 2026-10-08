#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getCompleteWeeklyBuckets } from './stratz/buckets.mjs';
import { fetchOpenDotaMetadata } from './opendota/metadata.mjs';

export const REFRESH_WEEKS = 4;

function validPatch(value) {
  return typeof value === 'string' && /^\d+\.\d+/.test(value);
}

function validatePublishedMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error('published meta.json must be an object');
  }
  if (meta.source !== 'STRATZ') {
    throw new Error(`published meta.json source must be STRATZ, got ${String(meta.source)}`);
  }
  if (!validPatch(meta.latestPatch)) {
    throw new Error(`published meta.json has invalid latestPatch: ${JSON.stringify(meta.latestPatch)}`);
  }

  const buckets = meta.matchupWindow?.weeklyBuckets;
  if (
    !Array.isArray(buckets) ||
    buckets.length !== REFRESH_WEEKS ||
    buckets.some((bucket) => !Number.isInteger(bucket)) ||
    buckets.some((bucket, index) => index > 0 && bucket !== buckets[index - 1] + 1) ||
    meta.matchupWindow.weeks !== REFRESH_WEEKS ||
    meta.matchupWindow.completeWeeksOnly !== true
  ) {
    throw new Error('published meta.json does not describe four consecutive complete STRATZ weekly buckets');
  }

  for (const [name, layer] of [
    ['positionData', meta.positionData],
    ['itemData', meta.itemData],
  ]) {
    if (
      layer?.completeWeeksOnly !== true ||
      layer.weeks !== REFRESH_WEEKS ||
      JSON.stringify(layer.weeklyBuckets) !== JSON.stringify(buckets)
    ) {
      throw new Error(`published meta.json ${name} window does not match matchupWindow`);
    }
  }
  return buckets;
}

export function decideDataRefresh({
  publishedMeta,
  detectedPatch,
  currentWindow,
  force = false,
}) {
  const publishedWeeklyBuckets = validatePublishedMeta(publishedMeta);
  if (!validPatch(detectedPatch)) {
    throw new Error(`detected OpenDota patch is invalid: ${JSON.stringify(detectedPatch)}`);
  }
  if (
    !currentWindow ||
    !Array.isArray(currentWindow.buckets) ||
    currentWindow.buckets.length !== REFRESH_WEEKS ||
    currentWindow.buckets.some((bucket, index, buckets) =>
      !Number.isInteger(bucket) || (index > 0 && bucket !== buckets[index - 1] + 1),
    ) ||
    !Number.isInteger(currentWindow.latestCompleteWeek) ||
    currentWindow.latestCompleteWeek !== currentWindow.buckets.at(-1)
  ) {
    throw new Error('current STRATZ window is invalid; expected four consecutive complete buckets');
  }

  const currentWeeklyBuckets = [...currentWindow.buckets];
  const currentLatestCompleteWeek = currentWindow.latestCompleteWeek;
  const publishedLatestCompleteWeek = publishedWeeklyBuckets.at(-1);
  const windowChanged = JSON.stringify(currentWeeklyBuckets) !== JSON.stringify(publishedWeeklyBuckets);

  let reason;
  let refreshRequired;
  if (force) {
    reason = 'FORCE';
    refreshRequired = true;
  } else if (windowChanged) {
    reason = 'NEW_COMPLETE_WEEK';
    refreshRequired = true;
  } else if (detectedPatch !== publishedMeta.latestPatch) {
    reason = 'PATCH_CHANGED_BUT_NO_NEW_WEEK';
    refreshRequired = false;
  } else {
    reason = 'NO_CHANGE';
    refreshRequired = false;
  }

  return {
    detectedPatch,
    publishedPatch: publishedMeta.latestPatch,
    currentLatestCompleteWeek,
    publishedLatestCompleteWeek,
    publishedWeeklyBuckets: [...publishedWeeklyBuckets],
    currentWeeklyBuckets,
    refreshRequired,
    windowChanged,
    reason,
  };
}

export async function writeGitHubOutputs(outputPath, decision) {
  if (!outputPath) return;
  const lines = [
    `refresh_required=${decision.refreshRequired}`,
    `reason=${decision.reason}`,
    `detected_patch=${decision.detectedPatch}`,
    `window_changed=${decision.windowChanged}`,
    `current_latest_complete_week=${decision.currentLatestCompleteWeek}`,
    `published_latest_complete_week=${decision.publishedLatestCompleteWeek}`,
    `published_weekly_buckets=${decision.publishedWeeklyBuckets.join(',')}`,
    `current_weekly_buckets=${decision.currentWeeklyBuckets.join(',')}`,
  ];
  await appendFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

export async function runPreflight({
  metaPath,
  force = false,
  now = new Date(),
  fetchMetadata = fetchOpenDotaMetadata,
  outputPath = process.env.GITHUB_OUTPUT,
  log = console.log,
} = {}) {
  const publishedMeta = JSON.parse(await readFile(metaPath, 'utf8'));
  const { latestPatch: detectedPatch } = await fetchMetadata();
  const currentWindow = getCompleteWeeklyBuckets(now, REFRESH_WEEKS);
  const decision = decideDataRefresh({ publishedMeta, detectedPatch, currentWindow, force });

  if (decision.reason === 'PATCH_CHANGED_BUT_NO_NEW_WEEK') {
    log(`New patch detected: ${decision.detectedPatch}`);
    log('Production STRATZ window is unchanged.');
    log('Refresh deferred until a new complete weekly bucket is available.');
  } else if (decision.reason === 'NEW_COMPLETE_WEEK') {
    log(`New complete STRATZ window available: ${decision.currentWeeklyBuckets.join(',')}`);
  } else if (decision.reason === 'FORCE') {
    log('Manual force_refresh requested; starting a full dataset refresh.');
  } else {
    log('Patch and complete STRATZ window unchanged; no dataset refresh required.');
  }
  await writeGitHubOutputs(outputPath, decision);
  log(JSON.stringify(decision));
  return decision;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const force = process.argv.includes('--force') || process.env.FORCE_REFRESH === 'true';
  const metaPath = path.join(root, 'public', 'data', 'meta.json');
  await runPreflight({ metaPath, force });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`DATA REFRESH PREFLIGHT FAILED CLOSED: ${error.message}`);
    process.exitCode = 1;
  });
}
