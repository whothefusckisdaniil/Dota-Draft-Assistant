# ТЗ №38 — ItemPrior temporal backtest (rolling-origin, leakage-free)

Validation, not modeling: does `getItemPrior(hero, position)` predict FUTURE
purchases of the same Hero×Position, or only describe the snapshot it was
built on? No enemy, capabilities, wins, weight tuning, production changes.

Pipeline (read-only; `src/scoring` untouched):

```text
node scripts/item-prior-backtest-research.mjs fetch     # 4 weekly caches → /tmp/item-prior-backtest/
node scripts/item-prior-backtest-research.mjs evaluate  # offline folds + bootstrap + verdict
npx vitest run scripts/item-prior-backtest-lib.test.ts  # 20/20
```

## §0 Design (pre-registered, frozen before the run)

```text
Fold 1: train [W1]          → test W2
Fold 2: train [W1, W2]      → test W3
Fold 3: train [W1, W2, W3]  → test W4
```

Weekly buckets come from `meta.itemData.weeklyBuckets` (contiguous,
ascending, exactly 4 — hard-gated). No random splits, ever.

Leakage rule (hard): TRAIN builds everything — `heroGames`, `itemStats`,
position eligibility (`share >= 8% AND games >= 500`), lane baselines, all
three rankings. The TEST week is touched ONLY by the metric functions
(`recallAtK`, `eventWeightedRecall`, `ndcgAtK`, `novelItemRate`).

Unit of analysis: `Hero × Position`. Primary cells additionally pass the
TEST floor: `>= 3` distinct observed items (measurement floor so Recall@K
is not trivially 1/1, fixed before results). Cells below it are counted as
`INSUFFICIENT_TEST_SUPPORT`, never imputed.
Frozen artifact: production formula `0.6/0.2/0.2, alpha=100,
liftSmoothing=0.01` — copied verbatim, parity-tested against
`getItemPrior()` on the committed dataset (same order, scores within
1e-12, on all 448 production cells). No alpha/weights/K/threshold tuning
on TEST. EB internals not re-estimated (documented limitation, same as
№37).

Rankers (all on TRAIN only):

- **Full** — frozen `getItemPrior` score;
- **Baseline A** — Model A events-per-game (`purchases / heroGames`);
- **Baseline B** — position-global popularity (same list for every hero
  on the lane).

Metrics per primary cell: distinct-item `Recall@{5,10,15}` (primary),
event-weighted recall@10 (`Σ test purchases of top-K / Σ all test
purchases` — events, never games), `NDCG@10` (SECONDARY: linear gain on
test purchase counts; repeat-heavy cheap items can inflate it — never a
verdict input alone).

Statistics: paired bootstrap over whole Hero×Position cells
(`seed=20261006`, `N=2000`, percentile CI, no normal approximation) on
per-cell deltas `Full − A` and `Full − B`. Fold table shows per-week
deltas so a one-week-carried mean is visible.

Verdict rule (pre-registered in code):

```text
INCONCLUSIVE   primary cells < 30
PREDICTIVE     CI-lo > 0 vs BOTH baselines on Recall@10 AND fold signs ≥ 0 everywhere
NO_ADVANTAGE   point deltas ≤ 0 vs both
MARGINAL       anything else
```

## §1 Fetch & data integrity

Buckets `2957–2960` (production window). `fetch` uses the production
transport (`fetchPositionsFromStratz` + `fetchItemStats`) with per-week
contract validation; cache files carry a schema tag and are re-validated
on load.

Integrity diagnostic (reported, never patched): sum of the 4 fetched
weeks vs committed `public/data/item-stats.json` — `4985/6150` cells
differ by ±a few events (STRATZ backfill drift, e.g. hero 1 pos 1 item 36:
committed `p=526359 g=615834` vs fetched `p=526371 g=615843`). The
backtest uses the fetched weeks on BOTH sides (train and test), so the
comparison is apples-to-apples; drift affects only the parity anchor to
the committed snapshot, which still matches exactly.

## §2 Gates → primary cells

```text
Fold 1: train-eligible 290 | INSUFFICIENT_TEST_SUPPORT 10 | primary 280
Fold 2: train-eligible 291 | INSUFFICIENT_TEST_SUPPORT 12 | primary 279
Fold 3: train-eligible 292 | INSUFFICIENT_TEST_SUPPORT 12 | primary 280
```

No fold is INSUFFICIENT (even Fold 1, training on one week, carries 280
cells — shown, never imputed). Pooled primary cells: **839**.

## §3 Per-fold metrics (macro mean over primary cells)

```text
Fold | ranker               | cells | R@5    | R@10   | R@15   | mass@10 | NDCG@10
F1   | full                 |  280  | 0.3686 | 0.6072 | 0.7667 | 0.8384  | 0.8808
F1   | a_eventsPerGame      |  280  | 0.3695 | 0.6068 | 0.7673 | 0.8793  | 0.9979
F1   | b_positionGlobal     |  280  | 0.2508 | 0.3865 | 0.5049 | 0.5744  | 0.6441
F2   | full                 |  279  | 0.3729 | 0.6098 | 0.7683 | 0.8384  | 0.8787
F2   | a_eventsPerGame      |  279  | 0.3742 | 0.6113 | 0.7705 | 0.8797  | 0.9973
F2   | b_positionGlobal     |  279  | 0.2508 | 0.3870 | 0.5046 | 0.5748  | 0.6443
F3   | full                 |  280  | 0.3760 | 0.6150 | 0.7730 | 0.8364  | 0.8732
F3   | a_eventsPerGame      |  280  | 0.3833 | 0.6179 | 0.7754 | 0.8813  | 0.9976
F3   | b_positionGlobal     |  280  | 0.2561 | 0.3930 | 0.5095 | 0.5747  | 0.6407
```

Reading: Full ≈ A on distinct recall in every fold (stable, not one-week
noise); Full ≫ B everywhere; on event-mass and NDCG, A leads Full by a
stable margin in all three folds.

## §4 Aggregate + paired bootstrap (839 cells)

```text
metric   | Full   | Base A | Base B | d(Full-A) 95% CI          | d(Full-B) 95% CI
recall5  | 0.3725 | 0.3757 | 0.2526 | -0.0032 [-0.0051, -0.0015] | 0.1199 [0.1086, 0.1313]
recall10 | 0.6107 | 0.6120 | 0.3889 | -0.0013 [-0.0026, -0.0001] | 0.2218 [0.2082, 0.2351]
recall15 | 0.7693 | 0.7711 | 0.5063 | -0.0017 [-0.0028, -0.0008] | 0.2630 [0.2497, 0.2759]
mass10   | 0.8377 | 0.8801 | 0.5746 | -0.0424 [-0.0460, -0.0387] | 0.2631 [0.2490, 0.2764]
ndcg10   | 0.8776 | 0.9976 | 0.6431 | -0.1200 [-0.1259, -0.1141] | 0.2345 [0.2186, 0.2494]
```

The primary metric (Recall@10) is a statistical dead heat vs A: the CI
sits just below zero but the point gap is −0.0013 — one permille. Vs B
the advantage is large and the CI is far from zero on every metric.

## §5 Stability across folds (Recall@10 deltas)

```text
Fold 1: d(Full-A)=+0.0004  d(Full-B)=+0.2207  cells=280
Fold 2: d(Full-A)=-0.0015  d(Full-B)=+0.2228  cells=279
Fold 3: d(Full-A)=-0.0028  d(Full-B)=+0.2220  cells=280
fold signs non-negative in every fold: NO (Full-A dips in F2/F3)
```

The B-beat is identical in all three weeks (no single-week carrier). The
A-comparison flips sign — Full is at parity with raw frequency, not above
it.

## §6 Novel-item rate (temporal drift)

```text
Fold 1: 0.0218 | Fold 2: 0.0206 | Fold 3: 0.0113
```

~1–2% of distinct TEST items were absent from TRAIN and therefore kept
as misses. Drift is small — the result is about ranking, not about new
items appearing.

## §7 Limitations

- Purchase EVENTS, not ownership or unique-game rates (data contract).
- One rank-bracket-weighted snapshot, one patch window — no claim about
  cross-patch generality.
- NDCG@10 is secondary by design (repeat-heavy cheap events inflate it;
  Baseline A at 0.9976 shows exactly this ceiling effect, not superiority
  as a recommender).
- Fold 1 trains on ONE week by design; it held up (280 primary cells).
- EB internals not re-estimated; formula frozen — no tuning on TEST.
- Backfill drift vs the committed snapshot is reported, not patched.

## §8 Verdict

**ITEM_PRIOR_MARGINAL**

Primary cells 839; d(Full−A) Recall@10 −0.0013 [−0.0026, −0.0001];
d(Full−B) +0.2218 [+0.2082, +0.2351]; fold signs vs A do not hold.

What this means: the production prior **does** predict the future — R@10
≈ 0.61 stable across all three held-out weeks, far above the
position-global baseline (+0.22). But the full `0.6/0.2/0.2` formula adds
**nothing** over raw per-hero frequency on distinct-item recall
(−0.0013), and loses on event-mass (−0.04) and NDCG (−0.12) because its
lift term re-orders away from the purchase-frequency order that TEST
rewards. The rule fires MARGINAL (not NO_ADVANTAGE — the B-beat is real;
not PREDICTIVE — the A-beat is absent and fold signs fail).

Consequence: ItemPrior is a **validated hero-frequency baseline**, not a
validated lift model. Any future work that wants the lift/share terms to
pay rent needs its own held-out proof; until then the honest story is
"hero frequency predicts, lift decorates".

Validation: `node --check` both files; vitest **20/20** (incl. full
production parity on all 448 cells); `evaluate` twice → byte-identical;
`src/scoring` untouched; no network in evaluate; no tuning on TEST.

committed `p=526359 g=615834` vs fetched `p=526371 g=615843`). The
backtest uses the fetched weeks on BOTH sides (train and test), so the
comparison is apples-to-apples; drift affects only the parity anchor to
the committed snapshot, which still matches exactly.

