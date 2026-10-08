#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATASET_FILES } from './dataset-publish.mjs';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return Object.fromEntries(
      keys.map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export async function datasetFingerprint(dataDir) {
  const hash = createHash('sha256');
  for (const filename of DATASET_FILES) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path.join(dataDir, filename), 'utf8'));
    } catch (error) {
      throw new Error(`cannot fingerprint ${filename}: ${error.message}`, { cause: error });
    }
    if (filename === 'meta.json' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      delete parsed.generatedAt;
    }
    const canonical = canonicalize(parsed);
    hash.update(`${filename}\n${JSON.stringify(canonical)}\n`);
  }
  return hash.digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dataDir = path.resolve(process.argv[2] ?? 'public/data');
  datasetFingerprint(dataDir)
    .then((fingerprint) => console.log(fingerprint))
    .catch((error) => {
      console.error(`DATASET FINGERPRINT FAILED: ${error.message}`);
      process.exitCode = 1;
    });
}
