# ТЗ §33 — Tri-state Hero Capability Research

**Verdict: `CAPABILITY_TRISTATE_MARGINAL`.** All six capabilities resolve without
a single false negative, and 127 heroes collapse into 34 distinct profiles — far
short of the separation a useful conditioning layer would need.

```text
STRATZ gameVersionId 190   snapshot 2026-10-05T12:19:37Z
mappings from §32 (validated), OpenDota commit bf193a550f77
confirmed mappings   unitDamageType=3   unitTargetTeam=3
unmapped raw values  unitDamageType=0   unitTargetTeam=0/4
```

```bash
node scripts/stratz-hero-capability-research.mjs all --cached
```

This reads §32's validated verdicts from `confirmed-mappings.json`; it does not
re-derive or re-decide a single mapping.

---

## 1. The resolution rule

```text
TRUE      at least one ability carries a CONFIRMED mapping for this property
FALSE     every relevant ability is known, and none carries it
UNKNOWN   some relevant ability is unresolved, and no TRUE was found
```

`FALSE` requires completeness and `TRUE` requires only one observation. That
asymmetry is what makes an incomplete source usable at all.

---

## 2. States across the pool

| capability | TRUE | FALSE | UNKNOWN |
| --- | --- | --- | --- |
| HAS_PHYSICAL_DAMAGE | 55 | 1 | 71 |
| HAS_MAGICAL_DAMAGE | 112 | 0 | 15 |
| HAS_PURE_DAMAGE | 21 | 3 | 103 |
| HAS_ENEMY_TARGETED | 106 | 0 | 21 |
| HAS_FRIENDLY_TARGETED | 45 | 0 | 82 |
| HAS_BOTH_TARGETED | 22 | 0 | 105 |

**4 of 6 capabilities can never be FALSE for any hero** — `HAS_MAGICAL_DAMAGE`,
`HAS_ENEMY_TARGETED`, `HAS_FRIENDLY_TARGETED`, `HAS_BOTH_TARGETED`. This follows
directly from §32.1: FALSE needs complete knowledge, and no hero has complete
target-team coverage. So for 4 of 6 capabilities the whole pool lives in
`{TRUE, UNKNOWN}`, and the question becomes whether that binary split is
informative or merely a restatement of "did we manage to map anything".

### Separation

```text
distinct signatures 34/127   largest single group 23
heroes with a fully UNKNOWN profile 0

damage group alone   10 distinct / 127
target group alone    8 distinct / 127
```

34 signatures for 127 heroes is weak. For conditioning, a feature is worth
carrying only if it splits the pool in a way that correlates with something
else; at this granularity most heroes remain interchangeable. The verdict is
`MARGINAL` precisely because of this number.

### Redundancy

```text
HAS_MAGICAL_DAMAGE  vs HAS_PURE_DAMAGE      agreement 17.3%
HAS_PHYSICAL_DAMAGE vs HAS_PURE_DAMAGE      agreement 46.5%
HAS_ENEMY_TARGETED  vs HAS_FRIENDLY_TARGETED agreement 34.6%
HAS_ENEMY_TARGETED  vs HAS_BOTH_TARGETED    agreement 22.8%
HAS_MAGICAL_DAMAGE  vs HAS_ENEMY_TARGETED   agreement 74.8%
```

The damage and target groups are genuinely different axes — the lowest
cross-group agreement is 74.8%, not 100% — so keeping them separate is
justified and merging them would lose information. The weakest pair is
`HAS_PHYSICAL_DAMAGE` vs `HAS_PURE_DAMAGE` at 46.5%, with 54 heroes UNKNOWN on
both.

---

## 3. Coexistence with the production Hero + Position ontology

```text
curated lane heroes parsed   79      present in the ability pool 76/79
distinct signatures inside the curated set  25/76
```

Three curated lane heroes have no entry in the STRATZ ability pool. That is a
coverage gap worth resolving before this is ever used in production, and it
belongs to the *existing* model rather than to anything added here.

Coexistence is not equivalence: the curated tables encode pick and role intent,
---

## 4. A bug this ТЗ caught in its own first run

The first run reported `HAS_MAGICAL_DAMAGE` and `HAS_ENEMY_TARGETED` in **100.0%
agreement**, which read like a striking semantic finding: the pool of
magical-damage heroes and the pool of enemy-targeted heroes are identical.

It was a bug. `resolveCapability` walked a fixed chain of candidate fields
(`unitDamageType` first, then `unitTargetTeam`), so every target capability was
silently querying the *damage* field. The two features were literally the same
feature, and the agreement was fabricated by construction.

With the dimension passed explicitly:

```text
                            before fix    after fix
HAS_BOTH_TARGETED    TRUE           0            22
HAS_FRIENDLY_TARGETED TRUE          55            45
never-FALSE capabilities            2/6           4/6
agreement MAGICAL vs ENEMY     100.0%         74.8%
distinct signatures             10/127        34/127
```

A unit test now pins that a capability reads only its own field. This is the
fourth appearance of the same failure mode — a plausible result produced by
reading the wrong field — and it is the strongest argument in this whole chain
for testing the *shape* of an input rather than assuming it.

---

## 5. Answer to the question №33 was set to answer

> Can partial ability semantics become an honest, useful hero-level feature
> without recovering the unknown `0` values?

**Partially, and not well enough to use.** The tri-state resolves honestly: no
capability returns a false negative, and 0 heroes end up fully UNKNOWN. But
honesty is not usefulness:

- only 34 of 127 signatures are distinct;
- 4 of 6 capabilities can never be FALSE, so they express "we mapped something"
  far more than "this hero does X";
- `HAS_BOTH_TARGETED` is TRUE for 22 heroes and UNKNOWN for 105.

The binding constraint is unchanged: `unitDamageType = 0` (376 of 787
observations) and `unitTargetTeam` 0/4 (503 of 787). Until those raws are
resolved the negatives cannot be earned, and without negatives a binary feature
cannot discriminate much.

### What would change the verdict

Not a better model — a better mapping. A source that labels the `0` values.
Everything else is already in place: if the damage-type `0` alone were resolved,
the FALSE column would become reachable and the signature count would rise
substantially.

No weights, no `EnemyCapabilityScore`, no percentage over an unknown denominator,
and nothing shipped to `src/`.

---

## 6. Files

```text
scripts/stratz-hero-capability-lib.mjs        pure: resolve, profile, distribution, redundancy
scripts/stratz-hero-capability-lib.test.ts   15 tests
scripts/stratz-hero-capability-research.mjs   the report
docs/hero-capability-research.md              this file
```
these encode ability semantics. The check only establishes that the two layers
can coexist without contradicting each other.