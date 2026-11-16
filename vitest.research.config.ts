import { defineConfig } from 'vitest/config';

/**
 * Frozen STRATZ research suites (FIX9–FIX17). They verify that the research
 * artifacts still reproduce against the exact public/data snapshot and
 * generator they were recorded with, so they are expected to fail once the
 * dataset is refreshed or scripts/update-data-stratz.mjs changes. They are not
 * part of `npm test` (which gates the scheduled data refresh).
 */
export const RESEARCH_TESTS = [
  'scripts/stratz-external-source-research.test.ts',
  'scripts/stratz-match-level-reconciliation.test.ts',
  'scripts/stratz-matchup-bracket-semantics.test.ts',
  'scripts/stratz-matchup-partition-semantics.test.ts',
  'scripts/stratz-opendota-coverage-validation.test.ts',
  'scripts/stratz-vendor-response-reconciliation.test.ts',
];

export default defineConfig({
  test: {
    include: RESEARCH_TESTS,
  },
});
