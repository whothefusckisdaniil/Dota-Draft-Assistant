import { describe, expect, it } from 'vitest';
import { runLiveValidation } from './liveValidate';

// No @types/node in this project; declare the minimal surface we need.
declare const process: { env: Record<string, string | undefined> };

// Opt-in network suite:  LIVE=1 npx vitest run src/scoring/live.validate.test.ts
// Skipped in regular `npm test` runs so CI never depends on OpenDota uptime.
describe.skipIf(process.env.LIVE !== '1')('live draft validation (OpenDota)', () => {
  it('runs the regression set (4 drafts, with expectations) + evaluation set (10 drafts, rank metrics) through the real engine', async () => {
    await runLiveValidation();
    expect(true).toBe(true);
  }, 600000);
});