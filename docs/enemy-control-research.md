# Enemy control taxonomy — source audit (ТЗ №29)

> **Status: audit executed. `VERDICT: CONTROL_NOT_IDENTIFIABLE`.**
> No taxonomy is produced, and none should be, from these sources.
> Production scoring, datasets, UI and workflows are untouched.

## 1. The question

Not "which heroes stun", but:

> can a control profile be derived **machine-readably**, for the whole hero
> pool, without a hand-written hero list?

The designated primary source does not contain the data the design assumed, and
the secondary source has no way to attach an ability to a hero.

## 2. Source audit — the two structural findings

**Valve GameTracking-Dota2 tracks no ability data at all.** Its `files.json`
lists **22 tracked paths, 0 of them ability files**; `content/dota` contains
only `materials` and `panorama`, and `panorama` holds 2 entries, neither
ability-related. There is no `npc_abilities` to read, so no commit SHA can be
pinned for something that does not exist.

**OpenDota `/constants/heroes` exposes no ability list.** The hero record fields
are `id, name, primary_attr, attack_type, roles, img, icon, base_*, *_gain,
attack_range, ..., localized_name`. There is **no `abilities` array on any of the
127 heroes (0/127)**. The hero → ability edge the whole taxonomy needs does not
exist machine-readably in either source.

## 3. What evidence *does* exist

`/constants/abilities` has **3084 records, 1334 with `attrib[]`, 3390 distinct
attribute keys**. Top-level fields are `dname, attrib, img, behavior, desc, cd,
mc, lore, bkbpierce, dispellable, dmg_type, target_team, target_type,
is_innate, dmg` — **there is no top-level `stun`, `root`, `silence`, `mute`,
`disarm`, `hex` or `break` field**. All control signal lives inside free-form,
per-ability `attrib.key` strings.

| Category | Explicit marker | Abilities | Key variants |
| --- | --- | ---: | ---: |
| stun | YES | 78 | 30 |
| break | YES | 21 | — |
| silence | YES | 10 | 4 |
| root | YES | 7 | 8 |
| disarm | YES | 5 | 1 |
| slow | YES | 5 | 6 |
| hex | YES | 3 | 3 |
| mute | YES | 1 | 1 |
| leash / fear_taunt | NO | 0 | — |
| forced_movement | not measured this run | — | — |

All ten categories have *at least one* marker. The problem is not the absence of
a concept — it is coverage and ownership.

## 4. Why the markers are not enough

**Coverage.** Only **229 of 3084 abilities (7.4%)** carry a usable control
marker.

**Heterogeneity.** `stun` alone is spread across **30 distinct key variants**:
`stun_duration=53`, `stun_radius=5`, `ministun_duration=3`, `hero_stun_duration=3`,
`stun_delay=3`, `magic_missile_stun=2`, `bolt_stun_duration`,
`snowball_stun_duration`, `wheel_stun`. Each is a hand-named custom attribute.

**141 control-looking keys are left UNRESOLVED** — `arrow_max_stunrange`,
`aspd_slow`, `attack_slow_tooltip_only`, `cold_feet_stun_duration_pct`, and so
on. They contain a control word and match no application pattern, so they are
reported rather than guessed. That number is the honest cost of not curating.

**False positives are present and rejected.** `slow_resistance`,
`slow_resist_per_str`, `castable_while_stunned`, `stun_stack_count`,
`tombstone_stun_penalty`, `unslowable` describe *resisting or being subject to*
control, not applying it. Treating them as evidence would mark exactly the
heroes that are immune. The real key `shard_bonus_stun_duration_tooltip` is a
tooltip string, not a mechanic, and is rejected too.

**The decisive check.** Canonical mechanics against the source:

```text
lion_impale            (the canonical stun)     present, NO control marker
silencer_glaive        (the canonical silence)  ABSENT from constants
shadowshaman_hex       (the canonical hex)      ABSENT from constants
bane_bedtime           (the canonical stun)     ABSENT from constants
antimage_counterspell  (the canonical silence)  present, NO marker
puck_dream_coil        HAS stun_duration
tusk_snowball          HAS stun_duration
```

Lion's Impale is a stun with no machine-readable marker. **That single fact
decides the verdict**: absence of a marker demonstrably does not mean absence of
the mechanic, so `not_present` can never be assigned automatically, and a hero

## 5. Why the hero matrix in this run is not a taxonomy

The report prints a hero × feature matrix, but only **11 of 127 heroes** could
be assembled, and only through a **key-prefix heuristic** this study wrote
(`lion_impale` → `lion`). That heuristic is exactly the manual semantic
inference §19 forbids as a generator. It is shown to expose the shape of the
problem and **must not be reused as a production mapping**.

All twelve §12 validation heroes — Lion, Silencer, Doom, Viper, Shadow Shaman,
Naga Siren, Phantom Assassin, Puck, Tusk, Anti-Mage, Kunkka, Bane — are
**unresolvable** from the source. Not one could be mapped without manual input.

## 6. Redundancy (measured, nothing removed)

Across the 11 heuristically-assembled profiles: `stun vs hex` both=0, onlyA=4;
`silence vs mute` both=0, onlyA=2; `slow vs root` both=0, onlyA=5; `hex vs
silence` both=0, onlyB=2. Too few profiles for this to mean anything — which is
itself the point: there is nothing stable to correlate.

## 7. Verdict

```text
VERDICT: CONTROL_NOT_IDENTIFIABLE
```

The designated primary source tracks no ability data, and the secondary source
exposes no machine-readable hero → ability join (0/127). All ten categories have
at least one explicit marker covering only 229/3084 abilities, and canonical
mechanics such as Lion's Impale carry no marker at all — so absence of a marker
cannot distinguish "does not do it" from "not measured".

This is a **measurement** about the sources, not a judgement about Dota. The
mechanics are real and well documented; they are simply not exposed as
machine-readable data by either source.

## 8. What would change the answer

- A maintained, machine-readable control taxonomy keyed to hero and ability —
  a curated dataset, i.e. the manual mapping this project is trying to avoid,
  which would also have to be maintained across patches.
- Valve ability KV data (the `npc_abilities` files GameTracking does not track),
  read directly from the Dota content install.
- Explicit semantic fields in OpenDota's ability records.

## 9. The capability/threat boundary (§23)

Even a `CONTROL_EXACT` outcome would be an **EnemyCapability** statement, not an
EnemyThreat one. "Hero A stuns" is not "Hero A is dangerous against my hero",
and certainly not "buy Black King Bar". That mapping is a separate layer.

## 10. Checks

```bash
node scripts/enemy-control-research.mjs plan   # no network
node scripts/enemy-control-research.mjs all    # GET only, 3 source fetches
```

23 unit tests in `scripts/enemy-control-lib.test.ts` cover the evidence rules:
anchored application keys, resistance rejection, `unknown != not_present`,
hex-derived effects, upgrade provenance, dedupe, and order-independent output.

without evidence is `unknown` — not clean.