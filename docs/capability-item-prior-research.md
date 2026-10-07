# TZ No.36 — Capability x ItemPrior research

Controlled experiment: do the coarse hero capability profiles (TZ No.35 v2)
separate the EXISTING `ItemPrior` distributions once position is stratified?

> **Verdict: `NO_ROBUST_CAPABILITY_ITEM_SIGNAL` — ветку `EnemyCapability`
> закрываем. Никакой `EnemyCapability` в scoring не трогаем.**

Reproduce:

```bash
node --experimental-strip-types scripts/capability-item-prior-research.mjs all
npx vitest run scripts/capability-item-prior-lib.test.ts
```

## Sec.1 Data

- dataset `generatedAt 2026-10-02T09:15:08.671Z`, heroes 127
- eligible Hero x Position cells: **290** (pos1:41 pos2:67 pos3:56 pos4:67 pos5:59)
- capability TRUE/FALSE/UNKNOWN counts over the 290 cells:

| capability | TRUE | FALSE | UNKNOWN |
|---|---|---|---|
| HAS_PHYSICAL_DAMAGE | 121 | 164 | 5 |
| HAS_MAGICAL_DAMAGE | 254 | 36 | 0 |
| HAS_PURE_DAMAGE | 46 | 239 | 5 |
| HAS_ENEMY_TARGETED | 240 | 50 | 0 |
| HAS_FRIENDLY_TARGETED | 112 | 176 | 2 |
| HAS_BOTH_TARGETED | 51 | 234 | 5 |

- testable strata: **18/30**. INSUFFICIENT_SUPPORT (12): all five
  MAGICAL strata (FALSE arm 6–9 < 10 — MAGICAL is 88% TRUE by construction),
  PURE pos1/pos3/pos5, ENEMY pos1, FRIENDLY pos1, BOTH pos1/pos2.

## Sec.2 Method

- unit: Hero x Position, eligible cells only (share >= 8%, games >= 500);
- TRUE vs FALSE within each position stratum; UNKNOWN excluded per
  comparison, never coerced to FALSE;
- signals: top-5 / top-10 membership rates over the canonical
  `getItemPrior()` order (no new ranking) + mean `ItemPrior.score` among
  observed cells only (never zero-filled);
- within-position permutation test, N=2000, seed=20261006, statistic
  abs(TRUE−FALSE), p=(#{shuffled>=observed}+1)/(N+1), no normal approximation;
- BH FDR q=0.05, one pool per analysis TYPE (positions pooled inside the type);
- support >= 10 cells per arm; full signatures descriptive only (groups >= 5).

Diagnostics actually measured:

| type | hypotheses | raw-p<0.05 | min-q | best (closest hypothesis, p → q) |
|---|---|---|---|---|
| top-5 | 1631 | 26 (1.6%) | 0.815 | ENEMY(tgt)/pos3/item_urn_of_shadows p=<0.001 q=0.815 |
| top-10 | 1631 | 30 (1.8%) | 1.000 | PHYSICAL(dmg)/pos2/item_wraith_band p=0.001 q=1.000 |
| score | 130 | 9 (6.9%) | 0.195 | FRIENDLY(tgt)/pos4/item_magic_wand p=0.001 q=0.195 |

The raw-p hit rate sits AT the nominal noise level ( BH pools contain ~1600
tests each; ~5% of 1631 ≈ 80 expected under the null — we see fewer). No
correction artifact: there is nothing near the boundary to correct.

## Sec.3 Capability x ItemPrior — top-5

No q<0.05 findings. (none)

## Sec.4 Capability x ItemPrior — top-10

No q<0.05 findings. (none)

## Sec.5 Capability x ItemPrior — score

No q<0.05 findings. (none; closest is min-q 0.195 — FRIENDLY(tgt)/pos4/item_magic_wand p=0.001 q=0.195.)

## Sec.6 Cross-position consistency

Nothing to cross-check — no significant findings in any analysis type.
Consistency therefore cannot rescue the result: there is no direction to be
consistent ABOUT.

## Sec.7 Full signature descriptive analysis

Per position: 17–24 distinct signatures, 2–4 groups with >= 5 heroes.
The largest groups (e.g. pos1 n=13 `PHYSICAL+MAGICAL+ENEMY`,
pos2/pos4/pos5 n=11–16 `MAGICAL+ENEMY` without PHYSICAL) share heavily
overlapping top-10 items (item 36 and 108 recur across almost every group) —
visually the same position-driven staples, not capability-separated shelves.
Descriptive only; no signature → weight rule is built (and now never will be
from this data).

## Sec.8 Negative result / limitations

- sparse cells: MAGICAL FALSE arm too thin everywhere (a capability that is
  TRUE for 88% of heroes cannot split the hero pool — TZ No.35.1 already
  flagged the saturation);
- capability repeats per hero across that hero's eligible positions
  (pseudoreplication) — controlled by stratification, at the cost of 12/30
  untestable strata;
- ItemPrior itself is a prior, not causal; top-K is ranking membership, not
  ownership probability; score measured only where the item cell exists;
- no enemy-conditioning anywhere in this TZ — and per this result, none is
  warranted.

## Sec.9 Verdict

**`NO_ROBUST_CAPABILITY_ITEM_SIGNAL`**

All three analysis types agree: after position stratification and FDR
control, coarse capability state does not separate ItemPrior distributions.
The raw-p diagnostics confirm this is absence of signal, not an
over-strict correction (hit rate ≈ noise floor, min-q ≥ 0.195).

No production recommendation follows — by design, and now permanently:
the `EnemyCapability` branch is closed. No `HAS_MAGICAL_DAMAGE → buy X`,
no capability weights, no follow-up integration TZ.
