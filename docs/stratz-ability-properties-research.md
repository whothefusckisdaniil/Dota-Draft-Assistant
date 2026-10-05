# ТЗ №31 — Ability Property Research

**Verdict: `PROPERTY_PROMISING`, but only half of §26 is met.**

```text
patch / gameVersionId   190
heroes                  127
abilities                868
schema-inspected        2026-10-05
```

Reproduce:

```bash
node scripts/stratz-ability-properties-research.mjs all --cached
```

---

## 1. The three states, measured

§30.1 established that *schema available*, *data populated* and *analytically
informative* are three separate claims. On 868 abilities:

| field | nonNull | null% | distinct | shape | confidence |
| --- | --- | --- | --- | --- | --- |
| `damage` | 28 | 96.8% | 17 | array | PARTIALLY_POPULATED |
| `unitDamageType` | 866 | 0.2% | 4 | integer | PARTIALLY_POPULATED |
| `duration` | 866 | 0.2% | 34 | string | UNINFORMATIVE |
| `castRange` | 349 | 59.8% | 91 | array | PARTIALLY_POPULATED |
| `unitTargetTeam` | 866 | 0.2% | 5 | integer | PARTIALLY_POPULATED |
| `unitTargetFlags` | 866 | 0.2% | 13 | integer | PARTIALLY_POPULATED |
| `dispellable` | 866 | 0.2% | 3 | string | FULLY_POPULATED |
| `isInnate` | 866 | 0.2% | 2 | boolean | FULLY_POPULATED |

`spellImmunity` is fetched for reference and is not a candidate feature.

---

## 2. The central finding: the useful fields are the unreadable ones

Reading this table naively gives the wrong answer in both directions.

**`duration` is 99.8% populated and separates nobody.** 839 of 866 values are
zero or empty, so `HAS_TIMED_ABILITY` is true for **127 of 127 heroes** at a
mean share of exactly 1.000. It is the best-populated field in the set and the
worst feature in the set. Population is not discrimination.

**`unitDamageType`, `unitTargetTeam` and `unitTargetFlags` are the only fields
that genuinely separate heroes, and none of them can be read.** They are bare
integers:

```text
unitDamageType    0:455 (52.5%)  2:300 (34.6%)  1:80 (9.2%)  4:31 (3.6%)
unitTargetTeam    0:570 (65.8%)  2:202 (23.3%)  1:57 (6.6%)  3:25 (2.9%)  4:12 (1.4%)
unitTargetFlags   0:804 (92.8%)  16:29  32:8  64:7  131072:6  ...  13 patterns
```

No `UnitDamageTypeEnum`, `UnitTargetTeamEnum` or `UnitTargetFlagsEnum` type
exists anywhere in the STRATZ schema. `unitTargetFlags` is demonstrably a
bitmask (16, 32, 64, 384, 16784, 131584 are products of small powers of two,
and the maximum spans 18 bits), but **no bit→meaning table is published**.

So per §5, §6 and §7 the mapping stays `UNKNOWN`. Naming `0` as physical,
`2` as magical or "team 0 = enemy" would be a guess that silently becomes a
feature, and a wrong guess is worse than a missing feature because it looks
like data.

**Consequence:** `HAS_PHYSICAL_DAMAGE`, `HAS_MAGICAL_DAMAGE`,
`HAS_PURE_DAMAGE`, `HAS_ENEMY_TARGETED_ABILITY`, `HAS_ALLY_TARGETED_ABILITY`
and `HAS_SELF_TARGETED_ABILITY` are all reported **`unknown`**, never
`available` and never `true`. The report omits their shares entirely rather
than printing a number that cannot be interpreted.

---

## 3. `damage` and `castRange` are per-level series

Both are arrays, so neither is a scalar:

```text
damage      present 28/868   all-zero series 13   any positive 15   any negative 0
            e.g. [0,0,0,0]  [0]  [100,160,220,280]  [100,200,300]  [105,185,265,345]

castRange   present 349/868 (59.8% unknown)
            min -1  p10 150  p25 500  p50 700  p75 900  p90 1200  max 999999
            bins: 0:44  0-300:38  300-600:105  600-900:192  900+:116
```

Two details worth recording. `damage = 0` is **not** treated as absence — 13 of
28 present values are all-zero series and 15 carry real damage, so a boolean
"has damage" would conflate them. And `castRange` contains `-1` and `999999`
sentinels, which is why the bins are descriptive only and why p90 (1200) sits
so far below max.

---

---

## 5. Hero-level aggregation with explicit denominators

Every share divides by abilities whose field is **known**, with the unknown
count carried alongside (§12/§13):

| feature | heroes > 0 | mean share | min known | max known |
| --- | --- | --- | --- | --- |
| HAS_DISPELLABLE_ABILITY | 120/127 | 0.318 | 5 | 16 |
| HAS_TIMED_ABILITY | 127/127 | 1.000 | 5 | 16 |
| HAS_INNATE_ABILITY | 126/127 | 0.150 | 5 | 16 |
| HAS_LONG_RANGE_ABILITY | 57/127 | 0.246 | 0 | 7 |
| HAS_DAMAGE_ABILITY | 15/127 | 0.580 | 0 | 2 |

Reading `HAS_DAMAGE_ABILITY` as "58% of Anti-Mage's abilities deal damage" would
be wrong twice: its denominator is **2 known** out of 6, and 112 heroes have no
`damage` value at all. The honest statement is `9 / 15 known`, `unknown = 6`.

**95 of 127 heroes get a distinct signature**, largest group 5. Hero
separation is therefore demonstrable — §26's first half is met.

---

## 6. Redundancy

```text
HAS_TIMED vs HAS_DISPELLABLE        both 120  onlyA 7    onlyB 0   jaccard 0.945
HAS_TIMED vs HAS_INNATE             both 126  onlyA 1    onlyB 0   jaccard 0.992
HAS_LONG_RANGE vs HAS_INNATE        both  56  onlyA 1    onlyB 70  jaccard 0.441
HAS_DISPELLABLE vs HAS_LONG_RANGE   both  53  onlyA 67   onlyB 4   jaccard 0.427
```

`HAS_TIMED_ABILITY` is near-redundant with both `HAS_DISPELLABLE_ABILITY` and
`HAS_INNATE_ABILITY`, which is a restatement of §4: it is true for almost
every hero. It would have added almost nothing as a feature.

---

## 7. Benchmarks (§17)

```text
Anti-Mage    ab 6  dmg 0x4,1x1,2x1    team 0x5,2x1        flags 0x6
Sniper       ab 6  dmg 2x3,0x2,1x1    team 0x3,2x3        flags 0x6
Wraith King  ab 6  dmg 0x4,1x1,2x1    team 0x2,1x2,2x2    flags 0x6
Puck         ab 6  dmg 0x3,2x3        team 0x6            flags 0x6
Kunkka       ab 7  dmg 0x3,2x3,1x1    team 0x4,2x2,3x1    flags 0x7
Bane         ab 8  dmg 0x4,4x4        team 0x4,2x3,3x1    flags 0x6,16x1
Lion         ab 6  dmg 0x4,2x2        team 2x4,0x2        flags 0x5,384x1
Silencer     ab 7  dmg 0x4,2x3        team 0x5,2x2        flags 0x7
Tusk         ab 8  dmg 0x4,2x3,1x1    team 2x5,0x2,1x1    flags 0x6,16x2
```

Sanity check, not a tuning table. The columns are raw integers for the §2
reason. Note that Bane, Lion and Tusk are the only benchmarks with a non-zero
`unitTargetFlags`, which is consistent with those three carrying most of the
crowd-control in this sample.

---

## 8. A bug found on the first run, identical in shape to §30.1

The first version of `normalizeAbilityProperties()` read properties from the
**top level** of the ability object. STRATZ returns them under `ability.stat`.
The result was not a crash — it was a report claiming:

```text
damage  0/868   unitDamageType  0/868   isInnate  0/868   (every field, 100% null)
```

on data that is in fact 99.8% populated. The same class of error as
`stat.isTalent` in §30.1: a plausible-looking output that is silently wrong,
and that only the raw payload could disprove. A regression test now pins the
nested shape and asserts that a top-level property is **not** picked up.

---

## 9. Verdict

**`PROPERTY_PROMISING`** — hero separation is real (95/127 distinct
signatures), and four features discriminate. But the separation comes from
`unitDamageType`, `unitTargetTeam`, `unitTargetFlags` and `castRange`, whose
semantics are `UNKNOWN`, so §26's second half — being able to state *what each
feature means* — is **not** met.

```text
discriminative but unreadable    unitDamageType, unitTargetTeam, unitTargetFlags, castRange
readable but weakly discriminative dispellable (120/127), isInnate (126/127)
populated but useless            duration (127/127, share 1.000)
too sparse                       damage (28/868, 112 heroes with none)
```

Nothing was shipped. No `EnemyCapability`, no weighting, no threat score (§19).
`dispellable = YES` is a property of an effect, never evidence of enemy threat.

### The honest blocker

The three decisive fields are one authoritative enum away from being usable. A
documented mapping for `unitTargetTeam` / `unitDamageType`, or a published
bit→flag table for `unitTargetFlags`, would flip this verdict immediately —
nothing else is missing. Until then they stay `UNKNOWN`.

### Next

`Hero + Position` × `Enemy property profile` × item signal, per §26 — but only
once the property semantics are established, which this source cannot do alone.
Candidate non-STRATZ sources for the mapping: OpenDota's ability schema (it
publishes `DAMAGE_TYPE` and `TARGET` enums by name) or a community enum
table. That is a separate ТЗ and requires an explicit decision, since it means
depending on a second source.
## 4. `duration` is one shape, not three

The pre-run expectation was wrong and the data corrected it. `duration` is
**always a string** (866/866, zero arrays, zero numbers), but the strings encode
per-level series in a space-separated list:

```text
"0.0"  "1.0 1.0 1.0 1.0"  "1.5 1.5 1.5 1.5"  "0.6875"
```

So a numeric distribution still does not apply without splitting first, and
`duration > 0` is the only defensible reading. Even then it means
`hasTimedEffect`, **not** a control duration, and it is never named one.