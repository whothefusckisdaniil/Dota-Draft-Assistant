# ТЗ §35 — Capability Profile v2 after confirmed NONE

**Verdict: `CAPABILITY_PARTIAL`.** Resolving `0 = NONE` did exactly one thing,
massively: FALSE states went **4 → 394** and never-FALSE capabilities **4/6 →
0/6**, with domain coverage 99.8% and 125/127 heroes complete on both
dimensions. What it did *not* do is increase profile diversity: **33/127
distinct signatures vs §33's 34/127**. The layer is now honest and decided
almost everywhere, but it discriminates heroes no better than before.

```text
STRATZ snapshot 2026-10-05T12:19:37.964Z   gameVersionId 190   heroes 127
mappings §32 (read-only) + §34 zero semantics merged in memory
confirmed mappings №33 baseline  unitDamageType=3  unitTargetTeam=3
runtime maps №35                 unitDamageType=4  unitTargetTeam=5
```

```bash
node scripts/stratz-hero-capability-v2-research.mjs
```

The §32 artifact is read and merged **in memory only**; `md5
confirmed-mappings.json` is byte-identical before and after the run. The §33
baseline column comes from the *same* code path with `zeroSemantics = {}`, so
the comparison cannot drift between two implementations.

---

## 1. Semantic domain

```text
unitDamageType  4 entries  1→Physical  2→Magical  4→Pure  0→None
unitTargetTeam  5 entries  1→Friendly  2→Enemy  3→Both  0→None  4→Custom

unitDamageType:  observed 0:455 1:80 2:300 4:31   mapped 866/868 (99.8%)
                 unknown none   field-missing 2   status COMPLETE
unitTargetTeam:  observed 0:570 1:57 2:202 3:25 4:12  mapped 866/868 (99.8%)
                 unknown none   field-missing 2   status COMPLETE

UNMAPPED_RAW_VALUE detected: no
```

The expected domain was fixed from §2 **before** the run (`0/1/2/4` and
`0/1/2/3/4`), and the observed STRATZ raws sit exactly inside it. The external
Valve enum's `7 = ALL` and `8 = HP_REMOVAL` are therefore *not* admitted —
presence in an external enum is not presence in STRATZ's domain (§2's core
principle). The 2 field-missing rows are `stat: null` on two ability rows and
stay UNKNOWN by construction; they are never conflated with raw zero.

---

## 2. Damage coverage

```text
damage:     row coverage 866/868   damageCompleteHeroes 125/127
            incomplete: Jakiro (5/6), Keeper of the Light (8/9)

allDamageKnown 125
```

§33 measured **3/127** complete on damage. After the zero mapping it jumps
to **125/127** — and not to 127, exactly as §10 required: two heroes carry
`stat: null` rows that no mapping can decide.

---

## 3. Target-team coverage

```text
target:     row coverage 866/868   targetCompleteHeroes 125/127
            incomplete: Jakiro (5/6), Keeper of the Light (8/9)

allTargetKnown 125   complete on BOTH dims 125/127
```

§33 measured **0/127** complete on target team. Same jump to **125/127**.
The residual is data-shaped, not model-shaped.

---

## 4. Capability distributions (§9 mandatory comparison)

```text
                 №33                     №35
                     T / F / U             T / F / U
Physical         55 / 1 / 71              55 / 70 / 2
Magical          112 / 0 / 15             112 / 15 / 0
Pure             21 / 3 / 103             21 / 104 / 2
Enemy            106 / 0 / 21             106 / 21 / 0
Friendly         45 / 0 / 82              45 / 81 / 1
Both             22 / 0 / 105             22 / 103 / 2

never-FALSE: №33 4/6 → №35 0/6 — none
```

TRUE counts are **identical by construction**: a confirmed hit was already
TRUE in §33, and nothing known became unknown. The entire effect of resolving
NONE lives in the FALSE and UNKNOWN columns:

- UNKNOWN total: **397 → 7** (the 7 are the two `stat: null` heroes);
- FALSE total: **4 → 394**;
- every capability can now express a negative.

### Informativeness shares (§12 — descriptive only, no new score)

```text
capability                  TRUE    FALSE  UNKNOWN    known
HAS_PHYSICAL_DAMAGE        43.3%  55.1%     1.6%   98.4%
HAS_MAGICAL_DAMAGE         88.2%  11.8%     0.0%  100.0%
HAS_PURE_DAMAGE            16.5%  81.9%     1.6%   98.4%
HAS_ENEMY_TARGETED         83.5%  16.5%     0.0%  100.0%
HAS_FRIENDLY_TARGETED      35.4%  63.8%     0.8%   99.2%
HAS_BOTH_TARGETED          17.3%  81.1%     1.6%   98.4%
```

No canonical entropy helper exists anywhere in the codebase, so §12's entropy
requirement is reported as TRUE/FALSE/UNKNOWN shares plus effective known
share — no new score is introduced. Note the shape the §15 warning predicted:
`HAS_MAGICAL_DAMAGE` is 88.2% TRUE and `HAS_ENEMY_TARGETED` 83.5% TRUE —
even with a formally complete domain, near-saturated TRUE shares make them
weak *conditioning* features. `HAS_PHYSICAL_DAMAGE` (43/55) and the target
triad (35/64, 17/81) are where the discrimination actually lives.

---

## 5. FALSE availability (§14)

```text
capability                  FALSE  known(T+F)  known share
HAS_PHYSICAL_DAMAGE          70         125        98.4%
HAS_MAGICAL_DAMAGE           15         127       100.0%
HAS_PURE_DAMAGE             104         125        98.4%
HAS_ENEMY_TARGETED           21         127       100.0%
HAS_FRIENDLY_TARGETED        81         126        99.2%
HAS_BOTH_TARGETED           103         125        98.4%

total FALSE states: №33 4 → №35 394 (×98.5)
```

`FALSE` is now a real information carrier: for every capability the decided
(T+F) share is ≥98.4%, and FALSE heroes exist in every capability. §33's
central defect — "4 of 6 capabilities can never be FALSE" — is gone.

The §35 warning from the spec is confirmed in shape: `HAS_MAGICAL_DAMAGE`
(88.2% TRUE) and `HAS_ENEMY_TARGETED` (83.5% TRUE) are near-saturated even
with a formally complete domain, so they are weak *conditioning* features.
`HAS_PHYSICAL_DAMAGE` (43/55) and the target triad carry the discrimination.

---

## 6. Capability signatures (§11)

```text
№35 distinct signatures  33/127   (№33: 34/127)
distinct signatures       33 / 127 = 26.0%
largest signature         24 / 127 = 18.9%
top-2 signatures          46 / 127 = 36.2%
largest group            24 heroes
smallest groups          17 × 1 hero
fully UNKNOWN profiles   0

top groups:
  × 24  MAGICAL=T PHYSICAL=T PURE=F ENEMY=T FRIENDLY=F BOTH=F
  × 22  MAGICAL=T PHYSICAL=F PURE=F ENEMY=T FRIENDLY=F BOTH=F
  × 12  MAGICAL=T PHYSICAL=F PURE=F ENEMY=T FRIENDLY=T BOTH=F
  ×  9  MAGICAL=T PHYSICAL=T PURE=F ENEMY=T FRIENDLY=T BOTH=F
  ×  7  MAGICAL=T PHYSICAL=F PURE=T ENEMY=T FRIENDLY=F BOTH=F

damage-only signatures  9/127
target-only signatures  10/127
```

Resolving NONE did **not** increase profile diversity: 33 distinct full
signatures vs §33's 34. The layer went from "undecided almost everywhere"
to "decided almost everywhere" — but it discriminates heroes no better
than before. The two dominant signatures alone cover 46/127 heroes (36%).

> §35.1 — distinct signature count ≠ discrimination score. The 26.0% is a
> literal diversity ratio (unique signatures / heroes), not a quality
> measure: a pathological 33/127 split with one 95-hero mega-group would
> print the same 26% while discriminating nobody (largest = 74.8%). Group
> concentration — largest 18.9%, top-2 36.2% — is the stronger diagnostic,
> and no concentration thresholds feed the verdict.

---

## 7. Redundancy (§13)

```text
pair                                   №33 agree  №35 agree  disting.
HAS_MAGICAL_DAMAGE vs HAS_ENEMY_TARGETED     74.8%     74.8%        32
HAS_PHYSICAL_DAMAGE vs HAS_MAGICAL_DAMAGE     42.5%     42.5%        73
HAS_PHYSICAL_DAMAGE vs HAS_PURE_DAMAGE       46.5%     46.5%        68
HAS_ENEMY_TARGETED vs HAS_FRIENDLY_TARGETED  34.6%     34.6%        83
HAS_ENEMY_TARGETED vs HAS_BOTH_TARGETED      22.8%     22.8%        98
HAS_FRIENDLY_TARGETED vs HAS_BOTH_TARGETED   63.0%     63.0%        47
```

`Magical vs Enemy`: **74.8% (§33) → 74.8% (§35)** — byte-identical.

Agreement percentages are STRUCTURALLY unchanged, and this is provable:
in §33 every pair state was {TRUE, UNKNOWN}, TRUE never downgrades, and
U→F turns (U,U) agreement into (F,F) agreement while (T,U)/(U,T) stays
distinguishable. What changed is composition: both-UNKNOWN columns
collapsed toward 0, so agreement now means shared FACT, not shared
ignorance. No pair collapses into a single feature.

---

## 8. Pair uniqueness (§15)

```text
pair                                    distinct pairs (of 9)
PHYSICAL + MAGICAL      5 (№33: 5)  new: FALSE/FALSE, TRUE/FALSE
MAGICAL + ENEMY         4 (№33: 4)  new: FALSE/TRUE, TRUE/FALSE, FALSE/FALSE
ENEMY + FRIENDLY        5 (№33: 4)  new: TRUE/FALSE, FALSE/FALSE, FALSE/TRUE
ENEMY + BOTH            5 (№33: 4)  new: TRUE/FALSE, FALSE/FALSE, FALSE/TRUE
FRIENDLY + BOTH         6 (№33: 4)  new: FALSE/FALSE, FALSE/TRUE, TRUE/FALSE
PHYSICAL + PURE         5 (№33: 6)  new: FALSE/TRUE
```

Every `new:` combination contains a FALSE that was unreachable in §33 —
this is where the zero mapping creates hero groups rather than merely
relabelling old ones. Net distinct-pair counts barely move (4–6), but
their *content* flips from ignorance-states to fact-states.

---

## 9. Benchmark heroes (§16)

```text
hero             abil  dmgKnown tgtKnown | Phy  Mag  Pur | Enm  Frd  Bth
Anti-Mage           6      6/6      6/6 |   T    T    F |   T    F    F
Sniper              6      6/6      6/6 |   T    T    F |   T    F    F
Wraith King         6      6/6      6/6 |   T    T    F |   T    T    F
Puck                6      6/6      6/6 |   F    T    F |   F    F    F
Kunkka              7      7/7      7/7 |   T    T    F |   T    F    T
Bane                8      8/8      8/8 |   F    F    T |   T    F    T
Lion                6      6/6      6/6 |   F    T    F |   T    F    F
Silencer            7      7/7      7/7 |   F    T    F |   T    F    F
Tusk                8      8/8      8/8 |   T    T    F |   T    T    F
```

All nine benchmarks are fully known on both dimensions (6/6–8/8).
Puck resolves `Enemy=FALSE` — all six STRATZ rows carry
`unitTargetTeam=0` (ground/point-targeted abilities declare no unit team),
so FALSE here means "no ability row declares enemy targeting", not
"cannot affect enemies" (see Limitations §8). Bane is the only benchmark
with `Pure=TRUE, Physical=FALSE, Magical=FALSE`.

---

## 10. Hero-position intersection (§17)

```text
gate-eligible hero-position cells (share ≥8%, games ≥500): 290
  complete capability profile    285
  unknown capability present     5
capability states inside cells   known 1723 / unknown 17
pool heroes without position data 0
```

Read-only coexistence check: the position model and its eligibility gate
are untouched. This is the cell count a future `Hero + Position +
EnemyCapability` layer would start from — 285/290 cells decidable.

---

## 11. Comparison with §33 (§9 mandatory table)

```text
                              №33        №35
row coverage (damage)      47.4%      99.8%
row coverage (target)      32.7%      99.8%
damage-complete heroes       3/127     125/127
target-complete heroes       0/127     125/127
never-FALSE caps               4/6          0/6
sum TRUE/FALSE/UNKNOWN  361/4/397   361/394/7
distinct signatures           34/127       33/127
largest group                 23          24
agreement MAGICAL/ENEMY    74.8%      74.8%
```

TRUE counts are identical by construction: a confirmed hit was already
TRUE in §33 and nothing known became unknown. The whole effect of
resolving NONE lives in the FALSE and UNKNOWN columns.

---

## 12. Limitations

1. Existence only (§19): no weighting, no intensity.
2. Excluded dims (§5): isUltimate, isTalent, duration, castRange,
   dispellable, isInnate.
3. HAS_CUSTOM_TARGETED excluded (§4): CUSTOM is diagnostic, not gameplay.
4. unitTargetFlags stays UNKNOWN — §35 does not revisit enum codes.
5. No wins / items / matchups (§18): strictly Hero → Ability → Semantic.
6. §17 reads positions.json but changes no eligibility.
7. §34 residual (3 inconclusive target rows) preserved as UNKNOWN.
8. FALSE is about the SOURCE, not gameplay reach (Puck example above).

---

## 13. Conclusion (§27)

1. Does confirmed NONE materially increase FALSE states?
   **4 → 394**; never-FALSE 4/6 → 0/6. Yes — materially.
2. Complete damage profile? **125/127** (was 3/127).
3. Complete target profile? **125/127** (was 0/127).
4. Distinct signatures? **33/127** (§33: 34/127); largest group 24.
5. Complementary? Highest agreement 74.8%, lowest 22.8%. No pair
   collapses; damage and target stay distinct axes. Agreement now rests
   on known facts (both-UNKNOWN ≈ 0), not shared ignorance.

MAIN QUESTION: after restoring NONE, is `Hero → Ability → typed semantic`
expressive enough as a coarse enemy feature layer?

```text
Verdict: CAPABILITY_PARTIAL

rowCoverage 99.8% · completeShare 98.4% · distinctSignatureShare 26.0% · neverFalse 0
largest signature 18.9% · top-2 signatures 36.2% (concentration, not a verdict input)
```

The domain is usable and FALSE states are real, but residual UNKNOWN
keeps a share of heroes undecided — usable as a coarse auxiliary layer
with the UNKNOWN state passed through honestly.

No weights. No EnemyCapabilityScore. Nothing outside scripts/ and docs/.
