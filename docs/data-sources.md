# Data sources: terms, risks, monetization

Checked 2026-11-16. Not legal advice. Re-check before launching anything paid.

## What the app uses

| Source | What | How | Volume |
|---|---|---|---|
| STRATZ GraphQL API | hero-vs-hero matchups (per rank bracket), position pick rates | daily GitHub Action, one bearer token (`STRATZ_API_TOKEN` secret), plain HTTPS with `User-Agent: STRATZ_API` | ~21 requests/day |
| OpenDota API | hero list, hero metadata, patch list and release dates | same Action, no key | 3 requests/day |
| Valve (via both) | hero portraits (Steam CDN), rank medals (`public/ranks`, from OpenDota's assets) | static | — |

The site itself makes **no** runtime calls to STRATZ or OpenDota: everything is a static snapshot in `public/data`.

## STRATZ

**Could not be verified from the primary source automatically**: `stratz.com/api`, `/terms` and the knowledge base return HTTP 403 to non-browser clients. Read these yourself in a browser:

- https://stratz.com/api — token tiers and usage conditions (this page is where the conditions live)
- https://stratz.com/knowledge-base/API — FAQ, in particular "Is the STRATZ API free?"

A third-party review that did read them in a browser (a personal research note, not authoritative: [Velkser/dota-insights#8, `docs/research/data-rights.md`](https://github.com/Velkser/dota-insights/pull/8)) reports:

- The API is free ("available 100% for free"); in return STRATZ asks for a **link back** ("Powered by STRATZ"). Higher token tiers require generating referral traffic and are approved at STRATZ's discretion.
- **No general Terms of Service page**; the `/api` page says the conditions may change at any time.
- **Storing/caching, aggregating and commercial use are not addressed.** STRATZ sells its own subscription (STRATZ+), so a paid product built on its data is the likely point of friction.

**Cloudflare.** The previous transport drove a headless Chromium with automation detection disabled and a spoofed browser User-Agent to get past Cloudflare's bot challenge. That was a workaround of a protection, which no provider is likely to welcome. It is gone: STRATZ admits API clients that send `User-Agent: STRATZ_API` with their token (verified: 200 with it, 403 challenge without). If STRATZ ever challenges that, the refresh now fails with an explanation instead of trying to get around it, and the last good dataset stays published.

## OpenDota

Verified from primary sources:

- Limits (live `https://api.opendota.com/api/metadata`): free tier **3,000 calls/day, 60/min**; premium **3,000/min**, `$0.01` per 100 calls, key requires a payment method ([`odota/web` Api.tsx](https://github.com/odota/web/blob/master/src/components/Api/Api.tsx), [`en-US.json`](https://github.com/odota/web/blob/master/src/lang/en-US.json)).
- Terms ([FAQ](https://blog.opendota.com/2014/08/01/faq/), linked from the site's "Privacy & Terms"): *"The service is provided on a best-effort basis. Since it relies on Valve infrastructure, we cannot make any guarantees of availability."* Data comes "from public sources such as the Steam WebAPI".
- Code is MIT; there is **no stated data license** and no restriction on commercial use. OpenDota sells API access itself, so commercial API use is expected; silence is still not a license.

## Valve (Steam Web API terms, applies upstream)

[Steam Web API Terms of Use](https://steamcommunity.com/dev/apiterms) (last updated July 2010):

- Data may be distributed "to end users for their personal use via your Application".
- You may not present the data so it appears "that your Application is endorsed or affiliated with Valve or Steam". → the footer and About page carry a non-affiliation notice.
- You may not create technology that gives "an unfair competitive advantage when playing multiplayer versions of any Steam game". A pre-game statistics tool is the norm (Dotabuff, STRATZ, OpenDota); an in-game overlay or live in-match advice would be a different matter.
- Hero art and rank medals are Valve IP; common practice is use with a trademark notice (done).

## Monetization checklist

| Model | Risk | Before launch |
|---|---|---|
| Free site with ads | Low–medium | Keep attribution; ask STRATZ in writing (Discord/email) that ads on a site using their aggregates are fine |
| Paid tier / subscription | **Medium–high** for STRATZ data | Written OK from STRATZ, or move the paid features onto data you can license (OpenDota premium, own match ingestion) |
| Selling the data / an API | High | Don't, without explicit licenses from STRATZ and a review of Valve terms |

Do not put STRATZ-specific metrics (IMP, win predictions) behind a paywall; the app only uses raw match counts and wins, which is the safer side.

## Single-token risk and what happens if STRATZ stops working

- **One token, one point of failure.** If it is revoked, expires or STRATZ changes access, the daily refresh fails; the site keeps serving the last good snapshot (the publisher never writes partial data). The UI shows "Data may be outdated" after 3 days. GitHub emails the repo owner on a failed scheduled run.
- **Do not** add more tokens from other accounts to spread load or survive a ban — that would look like evading STRATZ's limits. Volume is ~21 requests/day, far below any tier.
- **Fallback**: `npm run update:data:opendota-fallback` (`scripts/update-data.mjs`) builds a dataset from OpenDota only. It has no rank brackets (the rank selector hides itself), a different, smaller sample, and no 30-day/patch window; use it manually if STRATZ is gone for good, not as a silent automatic switch.
- **Renewing the token**: create a new one at https://stratz.com/api, then GitHub → Settings → Secrets and variables → Actions → `STRATZ_API_TOKEN`, then Actions → "Update Dota dataset" → Run workflow.
