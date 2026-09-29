# Build Profile Taxonomy — research (ТЗ §21)

> **Research only.** `scripts/build-profile-research.mjs` is read-only and offline.
> `src/scoring/`, `src/components/` and `public/data/` are untouched. No
> production code consumes anything in this document.

## The question

Which available signals **separate items by their role in a build**, and which
ones manufacture false confidence because `purchases` counts purchase **events**,
not games?

## 1. Signals available

| signal | source | event-based? |
| --- | --- | --- |
| `score` | ItemPrior (ТЗ §13) | derived from event counts |
| `purchaseEventsPerGame` | STRATZ | **yes — events / games** |
| `eventShare` | STRATZ | yes — share of the hero's events |
| `lift` | STRATZ, shrunk | yes |
| `median/p25/p75` | STRATZ `byMinute` | no — time is time |
| `valve phases` | pinned itembuilds | no — Valve's opinion |
| `agreement` | canonical rule | no |
| `repeatShare` | `instances 1+ / total` | yes |

Dataset: 6 672 item-cells, 127 heroes, 199 catalogue items. Valve hero known for
**99.3 %** of cells, Valve phase set for **43.7 %**.

## 2. What is event-based, and what that forbids

`purchases` is a count of **purchase events**. From ТЗ §13, `instances[0]` can
exceed `heroGames` (max 1.479), so **unique-game ownership is unrecoverable**.
No statement of the form "bought in N of M games" is available, for any item.

Consequence: `purchaseEventsPerGame > 1` cannot mean "bought in every game", and
`eventShare` is a share of events rather than of games.

## 3. Timing separates cleanly; frequency and lift do not

Global `medianMinute` percentiles (6 672 cells):

| | p10 | p25 | p50 | p75 | p90 |
| --- | --- | --- | --- | --- | --- |
| all | 2.1 | 6.4 | **21.0** | 30.6 | 36.3 |
| pos1 | 1.7 | 9.9 | 23.0 | 32.8 | 38.0 |
| pos2 | 1.5 | 4.7 | 18.6 | 29.3 | 35.4 |
| pos3 | 1.7 | 5.6 | 19.0 | 30.3 | 36.0 |
| pos4 | 2.6 | 7.2 | 21.9 | 30.7 | 36.3 |
| pos5 | 3.0 | 7.5 | 22.5 | 30.5 | 36.0 |

The histogram is **bimodal in a weak sense**: 21.2 % of cells under 5 minutes
(starting items), then a long plateau from 15 to 35, then a 3.4 % tail past 40.
That is one mode plus a starting-items cluster — not three independent regimes.
Per-position medians differ by at most ~4 minutes, so **timing does not
distinguish roles**: it separates "bought at the fountain" from "bought later".

## 4. The repeat-purchase hypothesis is REFUTED

I expected `eventsPerGame` to be dominated by rebuys. Measured with the
canonical tie-corrected `spearmanRho` from `src/scoring/stats.ts`:

> **Spearman(repeatShare, eventsPerGame) = 0.118** over all 6 672 cells.

A weak positive association. The §21 hypothesis that frequent items might be
consumables-in-disguise **does not hold**. Only 33 of the 357 cells
with `eventsPerGame >= 1` have `repeatShare > 0.15`.

> Correction (ТЗ §21.1): an earlier draft reported `0.065`, from a local Spearman
> that assigned distinct ordinal ranks to tied values. `repeatShare` is exactly
> `0` for thousands of cells, so that implementation was invalid. The value above
> is the tie-corrected one. **The conclusion is unchanged** — 0.118 is a weak
> association, not a dominant one — but the earlier number was wrong and should
> not be quoted.

But the confound is real in a *different* form: the top `eventsPerGame` cells
are **cheap components that get rebuilt after being sold**, not consumables —
Null Talisman (2.31), Aghanim's Scepter (2.05), Oblivion Staff (1.88), Wraith
Band (1.51), Bracer (1.50). A naive "high frequency ⇒ core item" rule would rank

## 5. Special classes are separated by timing, sharply

| class | cells | ev/g p50 | median p50 | lift p50 |
| --- | --- | --- | --- | --- |
| Aghanim's Shard | 174 | 0.16 | **28.5** | 1.12 |
| Aghanim's Scepter | 234 | 0.41 | **31.1** | 1.03 |
| Aghanim's Blessing | 70 | 0.06 | **47.2** | 1.12 |
| Moon Shard | 14 | 0.02 | **48.8** | 1.86 |
| stock-limited | 400 | 0.12 | 8.2 | 1.02 |
| neutral (Healing Lotus ×2) | 403 | 0.07 | 26.3 | 0.92 |

Shard, Scepter, Blessing and Moon Shard form a **distinct late cluster** around
28–49 minutes, with lift ≈ 1 (universal, not hero-specific). Blessing is 16
minutes later than Scepter, consistent with ТЗ §16 where it was 70 of the 234
cells that also had a Scepter.

Metadata caveat: "neutral items" here means **only the two Healing Lotuses**,
because those are the sole cost-0 non-purchasable entries. Real neutral items
are not reliably identifiable from this catalogue.

## 6. Signal matrix (§10)

At p50/p50 (`ev/g ≥ 0.16`, `lift ≥ 1.24`) all 6 672 cells fall into the 12
buckets, but the cells are **not distinct populations**:

| time | hiF/hiL | hiF/loL | loF/hiL | loF/loL |
| --- | --- | --- | --- | --- |
| early | 594 | 495 | 188 | 740 |
| mid | **1 407** | 252 | 305 | 907 |
| late | 423 | 165 | 419 | 777 |

The `mid` + high-frequency + high-lift cell holds 21.1 % of everything — a fifth
of the dataset in one bucket, containing Oblivion Staff, Aghanim's Scepter and
similar. A classification that dumps a fifth of its mass in one cell is not
separating roles.

## 7. Threshold stability (§12)

| perturbation | result |
| --- | --- |
| time cut 10 → 12 min | 3/3 buckets shared — stable |
| frequency p70 → p75 | 83.3 % set overlap |
| lift p70 → p75 | 83.3 % set overlap |

The boundaries are **stable** — which means the cuts are not noise-sensitive.
It does **not** mean the resulting categories mean anything; stability and
validity are different properties.

## 8. Supported profile

- **Timing** separates purchases made at the fountain (<10 min, 30.2 % of cells)
  from later ones, robustly, and the same split holds per position. It separates
  **WHEN** an item is bought, not **what for** — it does not identify
  core vs situational.
- **Valve phase** is an independent second opinion on 43.7 % of cells and
  agrees on the extremes: `supported` 11.6 %, `conflicting` only 0.3 %.
- **Special resource items** (Shard/Scepter/Blessing/Moon Shard) form a real,
  measurable cluster by timing.

## 9. Unsupported profile

- **`core` vs `situational` is NOT identifiable.** Frequency and lift overlap
  only partially — the Anti-Mage pos1 top-8 lists share **5/8** — and neither
  axis has a second dimension that separates a must-buy from a
  frequently-bought situational item.
- **No build order.** An unordered phase set plus a minute histogram cannot
  yield `A → B → C`.
- **No slot model.** Slot semantics are `unknown` project-wide (ТЗ №15.1, №17).
- **No enemy conditioning at any level** (ТЗ §11: PARTIAL).

## 10. Evidence quality and main confounders

`Spearman(repeatShare, eventsPerGame) = 0.118` (tie-corrected) — repeat
purchases are a weak contributor to the frequency signal, not a dominant one.

The confounders that do matter:

1. **Rebuilt components** inflate `eventsPerGame` far above 1 for cheap items
   that are sold and repurchased mid-game.
2. **Post-hoc purchase** — an item bought at minute 38 in a decided game is
   indistinguishable from a decisive one (ТЗ §11).
3. **Low-support timing artifacts** — `earliest` for Anti-Mage pos1 includes
   Vanguard at 0.00 and Bracer at 0.03, i.e. medians computed over a handful of
   events. Timing without a support floor is noise.
4. **Valve coverage** is 126/127 heroes; `bird_samurai` and `kez` are absent.
5. **Population skew**: Herald/Guardian-weighted, not the pro meta.

## 11. Recommendation

**Do not build a `BuildProfile` engine with role categories yet.** If one is
built later, the only defensible axes from today's data are:

- *when* an item is bought (early / rest), with a support floor;
- *how universal* it is (lift), which separates wand from a hero's signature;
- *what kind of thing* it is (resource/upgrade vs shop item), from metadata.

Anything labelled `core`, `situational` or `counter` would be a naming
decision, not a derivation — and would look like a finding.

## Reproducing

```bash
node --experimental-strip-types scripts/build-profile-research.mjs all
```

Offline; reads `public/data/*.json` and the pinned `research/valve-itembuilds.json`.
No token, no network. ~240 lines of output, runtime under a second.

Null Talisman above Battle Fury.
