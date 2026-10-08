# Automatic production dataset refresh (ТЗ №45)

## Pipeline

The existing `scripts/update-data-stratz.mjs` generator remains the only
production dataset generator. The scheduled workflow first performs a small
OpenDota metadata fetch and a local complete-week comparison; STRATZ is not
queried unless the preflight selects a refresh.

```text
Daily preflight (OpenDota patch + local STRATZ bucket calculation)
                         |
                 new complete week?
                    /          \
                  no            yes
                  |              |
      finish without STRATZ   npm ci + Playwright
                                 |
                      existing STRATZ generator
                                 |
                 atomic dataset-publish directory swap
                                 |
                 verify-dataset + publisher leftovers
                                 |
                     tests + typecheck + build
                                 |
                    semantic fingerprint comparison
                       /                    \
                  unchanged                changed
                  restore HEAD               commit
                  no commit                  push main
                                                 |
                                  existing Git/Vercel integration
```

The workflow runs daily at `03:17 UTC`, and can also be started with
`workflow_dispatch`. Manual runs expose `force_refresh`, default `false`.
`force_refresh=true` requests a full refresh even when the published four-week
window is unchanged.

## Preflight decisions

`scripts/check-data-refresh.mjs` is a read-only preflight. It fetches fresh
OpenDota metadata, validates the committed STRATZ metadata contract, computes
the four latest complete weekly buckets with the shared bucket helper, and
reports JSON plus GitHub Actions outputs:

- `refresh_required`
- `reason`
- `detected_patch`
- `window_changed`
- current and published latest-complete bucket and window

The decision rules are:

| Condition | Decision |
| --- | --- |
| Manual force is true | `FORCE`; refresh |
| The four-bucket window changed | `NEW_COMPLETE_WEEK`; refresh |
| Patch changed but the bucket window did not | `PATCH_CHANGED_BUT_NO_NEW_WEEK`; defer |
| Patch and window unchanged | `NO_CHANGE`; finish successfully |

**Patch detection is not an immediate publication trigger.** `latestPatch`
means the latest Dota patch reported by OpenDota when the dataset was
published. It does not mean every statistic in the snapshot comes exclusively
from that patch: matchup and item statistics are not patch-filtered. A patch
change with no new complete bucket leaves the committed snapshot, including
its displayed patch label, untouched. An OpenDota fetch error or malformed
published metadata fails closed; it never falls back to old metadata.

## Refresh and failure handling

When the preflight requests a refresh, the job:

1. Refuses to run if `public/data.__next` or `public/data.__prev` already
   exists. It never deletes a recovery snapshot.
2. Records a semantic fingerprint of all six published dataset files.
3. Runs `npm ci`, installs the existing Playwright Chromium prerequisite, and
   invokes `npm run update:data` with `STRATZ_API_TOKEN` supplied only from the
   GitHub Actions secret of the same name.
4. Runs `scripts/verify-dataset.mjs`, checks the staging paths, runs the full
   test suite, typecheck, and production build.
5. Fingerprints the new snapshot. If the fingerprint is unchanged, it restores
   the committed `public/data` byte-for-byte and creates no commit. Otherwise,
   it commits only `public/data` and pushes to `main` using the workflow's
   `GITHUB_TOKEN`.

The fingerprint canonicalizes JSON object key order and ignores exactly
`meta.generatedAt`. Changes to any other metadata or dataset field count as
semantic changes. The existing atomic publisher still stages, verifies, swaps,
and recovers the dataset as one directory; failed fetches, contract checks,
tests, typecheck, or build cannot create a commit or push.

## Secrets, permissions and deployment

No token is stored in the repository or written to generated data. The
repository administrator must configure the `STRATZ_API_TOKEN` Actions secret
for scheduled/manual refresh runs. The workflow only has read permissions in
preflight; the refresh job receives `contents: write` for the data commit.
Actions are pinned to immutable commit SHAs.

The repository contains `vercel.json` with the Vite build configuration and
does not define a separate deployment workflow. A successful push to `main`
is intended to use the existing Vercel Git integration if this repository is
connected to the Vercel project. That external connection cannot be verified
from repository files; do not add a competing deploy pipeline.

GitHub may disable scheduled workflows in public repositories after 60 days
without repository activity. Monitor Actions for recent scheduled runs and
re-enable the workflow in GitHub settings if it has been disabled.

## Local validation

```sh
node scripts/check-data-refresh.mjs
node scripts/check-data-refresh.mjs --force
npx vitest run scripts/check-data-refresh.test.ts
npm test
npm run typecheck
npm run build
node scripts/verify-dataset.mjs
```

The preflight command contacts OpenDota; its pure decision function and the
dataset fingerprint helper are tested offline.
