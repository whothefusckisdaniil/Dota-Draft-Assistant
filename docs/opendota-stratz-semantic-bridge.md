# ТЗ §32 — OpenDota Semantic Bridge

**Verdict: `OPENDOTA_SEMANTICS_PARTIAL`.** Six mappings confirmed by paired
validation on 868 STRATZ abilities. `unitTargetFlags` remains `UNKNOWN`.

```text
STRATZ  gameVersionId 190   snapshot 2026-10-05T12:19:37Z
OpenDota repo       odota/dotaconstants
OpenDota commit     bf193a550f778dec35debf4d71d05a86bebcc418
OpenDota fetched    2026-10-05T12:54:48Z   3115 ability records
```

```bash
node scripts/opendota-stratz-semantic-bridge.mjs all --cached
```

---

## 1. The join is exact and total

```text
STRATZ abilities        868
distinct STRATZ names   789
joined                  789   (100.0%)
missing in OpenDota     0
duplicate keys          79

heroes joined           127/127  (100.0%)
differing ability sets  0
```

No fuzzy matching was used anywhere, and none was needed: STRATZ already keys
abilities by the same string dotaconstants uses, and the hero graphs are
**identical for all 127 heroes** — zero abilities present on one side only.
The 79 "duplicate keys" are the same ability appearing under multiple heroes
(e.g. innate/shared abilities), counted once for the join.

This is a stronger result than §32 assumed. The blocker in §31 was never the
join; it was the absence of any published meaning for the integers.

---

## 2. Confirmed mappings (§5, §6, §8)

```text
unitDamageType <- dmg_type          787 paired observations (411 labelled)

  raw   n    OpenDota labels      derived on A / out-of-sample
  0     376  (none):376          UNKNOWN / NO_OBSERVATIONS
  1      80  Physical:80          CONFIRMED / AGREES
  2     300  Magical:300          CONFIRMED / AGREES
  4      31  Pure:31              CONFIRMED / AGREES

unitTargetTeam <- target_team      787 paired observations (278 labelled)

  raw   n    OpenDota labels      derived on A / out-of-sample
  0     491  (none):491          UNKNOWN / NO_OBSERVATIONS
  1      57  Friendly:57          CONFIRMED / AGREES
  2     202  Enemy:202            CONFIRMED / AGREES
  3      25  Both:19  (none):6    CONFIRMED / AGREES
  4      12  (none):12            UNKNOWN / NO_OBSERVATIONS
```

Each confirmed mapping is a **pure observation**: every one of the 80
abilities carrying `unitDamageType = 1` carries `dmg_type: "Physical"` in
dotaconstants, and the same holds on the held-out half. Nothing was declared in
advance. `0 → Physical`, which would have been the natural guess given the
ordering, is **UNKNOWN**, because OpenDota carries no label for those 376
abilities at all.

Two subtleties worth recording:

- **`raw 3` mixes `Both:19` with `(none):6` and is still CONFIRMED.** A missing
  label is not a competing label. Only a *different named* semantic creates
  ambiguity.
- **The unmapped majority is the interesting part.** `unitDamageType = 0` is the
  single most common value (376/787) and stays unknown, so a "magical share"
  would be measured against a denominator that excludes nearly half its
  abilities. §12/§13 apply here exactly as they did in §31.

---

## 3. `unitTargetFlags` stays UNKNOWN (§11)

No OpenDota field is a proven counterpart. `target_team` and `target_type`
describe team and unit classes, not a bit→flag table, so they cannot establish
---

## 4. Hero-level reconstruction, confirmed values only (§10)

```text
Abaddon            known 5  unmapped 3   damage:Magical=3  team:Both=1  team:Friendly=1
Alchemist          known 5  unmapped 5   damage:Physical=2 team:Friendly=2 team:Enemy=1
Ancient Apparition known 7  unmapped 2   damage:Magical=5  team:Enemy=2
Anti-Mage          known 3  unmapped 4   damage:Physical=1 damage:Magical=1 team:Enemy=1
Arc Warden         known 3  unmapped 4   damage:Magical=2  team:Enemy=1
Axe                known 5  unmapped 4   damage:Pure=3      team:Enemy=2
```

Only confirmed mappings contribute. `unmapped` is reported per hero rather than
folded into the numbers — for Anti-Mage, 3 mapped values against 4 unmapped is a
very thin basis for any profile.

---

## 5. Patch alignment: PATCH_MISMATCH (§16)

```text
STRATZ  gameVersionId 190   snapshot 2026-10-05T12:19:37Z
OpenDota commit bf193a55…    fetched  2026-10-05T12:54:48Z
```

Neither source states the other's patch or game version, so alignment is **not
established** and is recorded as `PATCH_MISMATCH`. The mappings are therefore
not automatically production-safe: a mapping derived across two unaligned
snapshots could silently drift if a patch renumbered either enum.

---

## 6. Bugs found while building this (the §30.1 / §31 pattern again)

Two of the three were silent-wrong-output bugs, not crashes:

1. **The §31 bug, reproduced.** `exactAbilityJoin` read STRATZ properties from
   the top level of the ability instead of `ability.stat`. The first run
   produced a confident report saying `paired observations 0` for both fields —
   which reads exactly like "no mapping exists" rather than like a bug. The
   STRATZ side is now normalised inside the library, with a regression test that
   also pins that case-folding and substring matching are *not* applied.
2. **Hero join 0/127.** STRATZ already stores the full `npc_dota_hero_*` key; the
   code prefixed `npc_dota_hero_` a second time and matched nothing.
3. **Verdict said `BLOCKED` with six confirmed mappings.** The rule only accepted
   a field as resolved if *every* raw value confirmed, so the unmapped majority
   drove the verdict. `BLOCKED` now means *nothing* confirmed.

A fourth was caught by a test rather than by a run: a mapping that failed
out-of-sample validation kept its `semantic` value while its status was
downgraded, so a consumer reading `.semantic` could have used a mapping the
function had just rejected. `semantic` is now nulled unless the final status is
`CONFIRMED`.

---

## 7. §19 — this is not a capability

Everything above is **ability semantics**. Nothing here is an
`EnemyCapability`, and there are still no weights, no threat score and no
production output.

The open question for the next ТЗ is whether these six mappings can produce a
hero capability profile that is *not* dominated by the unmapped majority:
`unitDamageType = 0` alone covers 376 of 787 observations, so any hero-level
share computed over them would rest on a denominator that excludes about half
the data.

### Source policy honoured (§15)

Only `odota/dotaconstants`, pinned to a commit SHA. No Liquipedia, no Dota Wiki,
no community enum table and no gists were consulted or used. Those remain
possible *future validation* sources, which would strengthen the mapping rather
than create it.

---

## 8. Files

```text
scripts/opendota-stratz-ability-lib.mjs        pure: join, cross-table, classify, validate
scripts/opendota-stratz-ability-lib.test.ts   20 tests
scripts/opendota-stratz-semantic-bridge.mjs   the report
docs/opendota-stratz-semantic-bridge.md        this file
```

No `src/`, `engine.ts`, `components/` or `public/data/` file was touched.
bit-level correspondence for a demonstrable bitmask spanning 18 bits. Not
guessed.