#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROLLING_DAYS } from './stratz/buckets.mjs';
import { fetchOpenDotaMetadata } from './opendota/metadata.mjs';

function validPatch(value) {
  return typeof value === 'string' && /^\d+\.\d+/.test(value);
}

const utcDay = (date) => date.toISOString().slice(0, 10);

/**
 * Returns the UTC day the published window ends on, and whether it is already
 * the rolling ROLLING_DAYS format. The legacy "4 complete weeks" format is
 * still accepted so the first run after the switch can replace it.
 */
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
  const window = meta.matchupWindow;
  const rolling = window?.kind === 'rolling-days';
  const end = Date.parse(rolling ? window.windowEndUtc : window?.windowEndUtcExclusive);
  if (!Number.isFinite(end)) {
    throw new Error('published meta.json does not describe a valid STRATZ matchup window');
  }
  const rollingCurrent = rolling && window.days === ROLLING_DAYS && meta.positionData?.days === ROLLING_DAYS
    && JSON.stringify(meta.positionData?.weeklyBuckets) === JSON.stringify(window.weeklyBuckets);
  return { publishedWindowDay: utcDay(new Date(end)), rollingCurrent };
}

/**
 * Daily rolling window: a refresh is due whenever the published window does not
 * end today (UTC), i.e. once per day, when the published format is not the
 * current rolling ROLLING_DAYS window, or as soon as OpenDota reports a new
 * patch (the window is cut at the patch release, so it must not wait a day).
 */
export function decideDataRefresh({ publishedMeta, detectedPatch, now = new Date(), force = false }) {
  const { publishedWindowDay, rollingCurrent } = validatePublishedMeta(publishedMeta);
  if (!validPatch(detectedPatch)) {
    throw new Error(`detected OpenDota patch is invalid: ${JSON.stringify(detectedPatch)}`);
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('invalid current time');
  const today = utcDay(now);
  const patchChanged = detectedPatch !== publishedMeta.latestPatch;
  const windowChanged = !rollingCurrent || publishedWindowDay !== today || patchChanged;

  let reason;
  if (force) reason = 'FORCE';
  else if (!rollingCurrent) reason = 'WINDOW_FORMAT_CHANGED';
  else if (patchChanged) reason = 'NEW_PATCH';
  else if (publishedWindowDay !== today) reason = 'NEW_DAY';
  else reason = 'NO_CHANGE';

  return {
    detectedPatch,
    publishedPatch: publishedMeta.latestPatch,
    today,
    publishedWindowDay,
    refreshRequired: reason !== 'NO_CHANGE',
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
    `today=${decision.today}`,
    `published_window_day=${decision.publishedWindowDay}`,
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
  const decision = decideDataRefresh({ publishedMeta, detectedPatch, now, force });

  if (decision.reason === 'NO_CHANGE') {
    log(`Published ${ROLLING_DAYS}-day window already ends today (${decision.today}); no refresh required.`);
  } else if (decision.reason === 'FORCE') {
    log('Manual force_refresh requested; starting a full dataset refresh.');
  } else {
    log(`Refreshing the rolling ${ROLLING_DAYS}-day window (${decision.reason}: published ${decision.publishedWindowDay}, today ${decision.today}).`);
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
