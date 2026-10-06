# ТЗ §34 — Zero-Value Semantic Audit

**Verdict: `ZERO_SEMANTICS_CONFIRMED`.** The authoritative Valve enum assigns
`0 = NONE` to both dimensions, and not one STRATZ raw-zero row contradicts that
meaning: no positive damage, no external typed label, no unit-team targeting.
Three target rows cannot be evaluated at all and stay `SEMANTIC_UNKNOWN` — they
are counted as unknown, never as compatible.

```text
STRATZ snapshot 2026-10-05T12:19:37.964Z   rows 868
OpenDota/dotaconstants commit bf193a550f77 (§32 artifact, pinned)
raw zero   unitDamageType 455   unitTargetTeam 570
raw 4      unitTargetTeam 12
field missing (stat: null)  2 rows each dimension
```

```bash
node scripts/zero-enum-research.mjs
```

Read-only: cached snapshots only, no API calls, §32 `confirmed-mappings.json`
read but never written, nothing outside `scripts/` and `docs/` touched.

---

## 1. Sources

**Primary observed data** — STRATZ cache: `stat.unitDamageType`,
`stat.unitTargetTeam`.

**Semantic source** — the official Valve Developer Community API page
(`developer.valvesoftware.com/wiki/API`), read via the Wayback Machine capture
of 2024-11-03. The `archive.ph` copy from the task citation was unreachable
from this machine, so the identical official page was used directly. It lists,
verbatim:

```text
DAMAGE_TYPES                     DOTA_UNIT_TARGET_TEAM
DAMAGE_TYPE_NONE        = 0      DOTA_UNIT_TARGET_TEAM_NONE     = 0
DAMAGE_TYPE_PHYSICAL    = 1      DOTA_UNIT_TARGET_TEAM_FRIENDLY = 1
DAMAGE_TYPE_MAGICAL     = 2      DOTA_UNIT_TARGET_TEAM_ENEMY    = 2
DAMAGE_TYPE_PURE        = 4      DOTA_UNIT_TARGET_TEAM_BOTH     = 3
DAMAGE_TYPE_ALL         = 7      DOTA_UNIT_TARGET_TEAM_CUSTOM   = 4
DAMAGE_TYPE_HP_REMOVAL  = 8 (deprecated)
```

**Corroboration** — the official Valve Workshop Tools constants mirror
(`dota2.com.cn/wiki/Dota_2_Workshop_Tools/Scripting/Constants.htm`) contains
the sections `AbilityUnitDamageType` and `AbilityUnitTargetTeam` with the
symbolic constant names; it prints no numeric values, so it confirms existence
only. Community enum tables: not used.

## 2–3. The raw-zero damage row set

`unitDamageType = 0` on **455/868 rows (52.4%)**; 2 rows have `stat: null` and
are `FIELD_MISSING` — a missing field is not a zero. The fields `behavior` and
`unitTargetType` do not exist in the STRATZ snapshot (§31 queried only its
candidate set; §17 forbids new API calls while cached data suffices), so both
are taken from the pinned dotaconstants mirror, joined 868/868 on the exact
ability key. The two fields vary independently: 97/455 raw-zero damage rows
still carry a non-zero `unitTargetTeam`.

Evidence split (§3), every percentage over the raw-zero row count:

```text
damage_known_positive     0 / 455  (0%)
damage_known_zero         5 / 455  (1.1%)
damage_unknown          450 / 455  (98.9%)
```

Not one raw-zero row carries positive STRATZ damage. The flip side is stated
plainly: for 450 of 455 rows the damage field itself says nothing, so they are
*compatible candidates*, not positive evidence.

## 4. OpenDota cross-check — two different facts

```text
Fact A  Valve enum says DAMAGE_TYPE_NONE = 0            (§1)
Fact B  OpenDota has a dmg_type label on 0/455 raw-zero rows
```

B is expected and is **not** proof of NONE: an absent label means the second
source says nothing. A and B stay separate facts. Reverse direction — where
OpenDota *does* label (411 rows with `stat` present), STRATZ says raw 0 on
**0** rows and disagrees with the label on **0** rows.

## 5–6. Behaviour distribution and hero concentration

```text
rows with behaviour 453/455
  Hidden 200 · Passive 143 · No Target 117 · Instant Cast 70 ·
  Unit Target 69 · Point Target 40 · AOE 26 · Channeled 7 ·
  Autocast 2 · Attack Modifier 1

heroes affected 124/127   abilities 455
top: Rubick 10 · Largo 9 · Invoker 8 · Morphling 7 · Kez 7 · Io 7 …
```

No behaviour value is converted into damage semantics (§5). The spread over
Passive / No Target / Hidden / Instant Cast across almost the entire hero pool
is a systemic pattern: raw zero behaves like "this ability declares no typed
damage", not like a sporadically missing field.

## 7–8. Target team 0 and 4

```text
unitTargetTeam = 0   (570 rows)
  non_unit_target     567 / 570  (99.5%)
  unit_target_conflict  0 / 570  (0%)
  inconclusive          3 / 570  (0.5%)
  flags: 568 rows flags=0, one row 16784, one row 64

unitTargetTeam = 4   (12 rows)
  Unit Target behaviour 12/12 · external labels 0/12
  devour, infest, toss, nether_swap, blink_strike, phantom_strike,
  decrepify, replicate, tree_grab, soul_rip, petrify, gobble_up
```

Raw-4 rows are all genuine unit-targeting abilities with special targeting
rules — what the enum calls `CUSTOM`, a real target-team semantic rather than
an arbitrary internal bucket. It is not renamed to "unknown" automatically.

## 9. Critical validation examples (deterministic)

Sort by `abilityKey`, take first N — no randomness anywhere. The full sample
lists are in the research output; the decisive rows:

```text
raw-0 damage sample   all damage null, behaviours from No Target to
                      Unit Target (alchemist_berserk_potion: unitTargetTeam 1
                      with targetType Hero,Basic while damage type is 0)
raw-0 target sample   all Point/Passive/No Target, no Unit Target
raw-4 sample          all Unit Target, flags mostly 0
```

## 10–11. The two hard tests

**Raw zero + positive damage:** `0 / 455`. The §10 counterexample does not
exist in this snapshot — no ability has `unitDamageType = 0` together with
positive `damage`. What this does *not* prove: most rows carry no damage signal
at all (§3), so the result is the absence of contradiction, not a positive
measurement of "no damage".

**Raw zero + unit target:** `0 / 570` rows pair raw 0 with a declared
`targetType` of HERO/BASIC/... Two raw-zero rows carry Unit Target behaviour at
all, and neither completes the conflict pair:

```text
clinkz_death_pact          Unit Target, target_type absent in the mirror
treant_eyes_in_the_forest  Unit Target + Hidden + AOE, target_type Tree
```

Both are `INCONCLUSIVE` under §13B — trees are not team-bound units, and an
absent target type is not a target type. They are never counted as compatible.

## 12. Cross-source numeric anchors

```text
unitDamageType 1 ↔ Physical ↔ DAMAGE_TYPE_PHYSICAL = 1
unitDamageType 2 ↔ Magical  ↔ DAMAGE_TYPE_MAGICAL  = 2
unitDamageType 4 ↔ Pure     ↔ DAMAGE_TYPE_PURE     = 4
unitTargetTeam 1 ↔ Friendly ↔ DOTA_UNIT_TARGET_TEAM_FRIENDLY = 1
unitTargetTeam 2 ↔ Enemy    ↔ DOTA_UNIT_TARGET_TEAM_ENEMY    = 2
unitTargetTeam 3 ↔ Both     ↔ DOTA_UNIT_TARGET_TEAM_BOTH     = 3
```

STRATZ, the §32 OpenDota bridge and the Valve enum place 1/2/3/4 in the same
numeric space. Anchor consistency is *why* reading 0 through this enum is
plausible — it is not the proof; §13 is the proof.

## 13. Out-of-sample validation: A and B independently

```text
A — semantic source:  enum says 0 = NONE (both dims), 4 = CUSTOM (target)
B — data behaviour:   damage raw-0   compatible 455 / conflict 0 / inconclusive 0
                      target raw-0   compatible 567 / conflict 0 / inconclusive 3
                      target raw-4   compatible 12  / conflict 0 / inconclusive 0

reverse:  dmg_type labelled    411 rows → STRATZ raw 0 on 0, mismatch on 0
          target_team labelled 284 rows → STRATZ raw 0 on 0, mismatch on 0
```

The 7 multi-team labels arrive as arrays (`["Enemy","Friendly"]`) and resolve
to raw 3 = `BOTH` on every row they join — a format quirk, kept out of the
mismatch count by construction. B is not violated anywhere.

**Residual uncertainty (honest limits):**

- 3 target rows cannot be evaluated: `rattletrap_jetpack_toggle` (no
  behaviour in the mirror), `clinkz_death_pact`, `treant_eyes_in_the_forest`.
  They are `SEMANTIC_UNKNOWN`, never `ENUM_NONE`.
- 450/455 raw-zero damage rows have no damage signal of their own; the
  damage-side B-check leans on the cross-source reverse check (0 labelled rows
  collapse to 0) and the behaviour distribution, not on per-row damage values.
- OpenDota labels cover 411/866 and 284/866 rows — an ability *unlabelled by
  both sources* could in principle hide a typed damage at raw 0. The bound is
  the measured agreement: wherever either source names a value, STRATZ matches.
- The behaviour/target-type evidence comes from dotaconstants, not from STRATZ
  itself (§2 explains why). No new API calls were made to close that gap.

## 14. ENUM_NONE / FIELD_MISSING / SEMANTIC_UNKNOWN

```text
unitDamageType   ENUM_NONE 455   FIELD_MISSING 2   SEMANTIC_UNKNOWN 0
unitTargetTeam   ENUM_NONE 567   FIELD_MISSING 2   SEMANTIC_UNKNOWN 3
```

Three states, never collapsed: `stat: null` (jakiro_liquid_ice,
keeper_of_the_light_radiant_bind) is `FIELD_MISSING` — it is not a value of 0;
raw 0 whose B-check passes is `ENUM_NONE`; a B-conflict or a row B cannot
evaluate would be `SEMANTIC_UNKNOWN`. No raw value in this snapshot lies
outside the enum (0 rows with an unknown raw).

## 15. Fork for the capability model (deliberately not taken here)

With the verdict CONFIRMED, the *next* stage may legally treat the known
damage-type domain as `{Physical, Magical, Pure, None}` and only then make
`HAS_PHYSICAL_DAMAGE = FALSE` reachable on fully known heroes. Until that
stage happens, the §33 tri-state stands unchanged — this task creates no
production features, no weights, no `EnemyCapabilityScore`.

## 16. unitTargetFlags — untouched

The snapshot holds 14 distinct flag values (0 dominates with 804 rows). Even
though the Valve page prints the `DOTA_UNIT_TARGET_FLAGS` bitmask, there is no
evidence that STRATZ stores that same numeric bitmask, and no inference is
drawn from `unitTargetTeam`/`unitTargetType`. The flags fork stays
`UNKNOWN` — a separate future research, not part of §34.

## 17–19. Deliverables

```text
scripts/zero-enum-research.mjs   this report (read-only, cached only)
scripts/zero-enum-lib.mjs        semanticState, classifyZeroCompatibility,
                                 damageEvidenceSummary,
                                 targetEvidenceSummary,
                                 deterministicSample, heroConcentration,
                                 zeroVerdict
scripts/zero-enum-lib.test.ts    vitest suite, §19 cases included
docs/zero-enum-research.md       this document
```

## 21–22. Isolation

§32 `confirmed-mappings.json` is byte-identical after the run; the confirmed
mappings `1→Physical, 2→Magical, 4→Pure, 1→Friendly, 2→Enemy, 3→Both` were
never re-decided — §34 only investigated the previously unknown raw values.
Touched paths: `scripts/`, `docs/`. No `src/`, no `engine.ts`, no
`public/data/`, no new API calls.

