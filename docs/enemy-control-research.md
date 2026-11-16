# Enemy control taxonomy — source audit (ТЗ №29)

> **Status: audit executed. `VERDICT: CONTROL_NOT_IDENTIFIABLE`.**
> No taxonomy is produced, and none should be, from these sources.
> Production scoring, datasets, UI and workflows are untouched.

> **Scope correction (ТЗ №47, 2026-10-08):** the original audit incorrectly
> generalized its GameTracking finding. It checked `content/dota` and the
> tracking path summary but missed the extracted VPK subtree
> `game/dota/pak01_dir/scripts/npc/`, which contains `npc_heroes.txt`,
> per-hero KV files, `npc_abilities.txt`, and `items.txt`. A pinned-source
> audit now finds 127/127 production hero files, 790/790 referenced
> `Ability1`–`Ability9` identifiers with definitions, and 199/199 exact item
> key joins. The OpenDota constants and free-form-marker measurements below
> remain valid for those sources; this document's old claim that no
> machine-readable Valve hero→ability source exists is superseded. The files
> provide mechanics data, not normalized threat/response rules. See
> the Threat / Response Taxonomy research (retired by ТЗ №77).

## 1. The question

Not "which heroes stun", but:

> can a control profile be derived **machine-readably**, for the whole hero
> pool, without a hand-written hero list?

The OpenDota secondary source has no way to attach an ability to a hero, and its
free-form ability markers are not a complete control taxonomy. The original
audit missed a separate, versioned GameTracking VPK extraction; §47 audits that
source independently.

## 2. Source audit — the two structural findings

**Historical scope note:** this audit only inspected the `content/dota`
subtree and did not expand VPK extraction rules in `files.json`. The later §47
check found ability/hero files in
`game/dota/pak01_dir/scripts/npc/`. The measurements in the next paragraph
remain specifically about the OpenDota endpoint and its 127 hero records.

**OpenDota `/constants/heroes` exposes no ability list.** The hero record fields
are `id, name, primary_attr, attack_type, roles, img, icon, base_*, *_gain,
attack_range, ..., localized_name`. There is **no `abilities` array on any of the
127 heroes (0/127)**. The hero → ability edge is absent from this OpenDota
endpoint; §47 establishes that it is present in the separate versioned Valve
KV source.

## 3. What evidence *does* exist

OpenDota `/constants/abilities` has **3084 records, 1334 with `attrib[]`, 3390
distinct attribute keys**. Top-level fields are `dname, attrib, img, behavior,
desc, cd, mc, lore, bkbpierce, dispellable, dmg_type, target_team, target_type,
is_innate, dmg` — **there is no top-level `stun`, `root`, `silence`, `mute`,
`disarm`, `hex` or `break` field**. All control signal lives inside free-form,
per-ability `attrib.key` strings in this OpenDota endpoint.

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

Eight of the eight **measured** categories have at least one marker;
`forced_movement` was not measured at all, and `leash` / `fear_taunt` have
none. The verdict logic counts `markersPerCategory` over the nine non-excluded
categories and excludes `forced_movement` from the denominator, which is why the
code and this table agree. The problem is not the absence of a concept — it is
coverage and ownership.

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
VERDICT: CONTROL_NOT_IDENTIFIABLE (original OpenDota/free-form-marker scope)
```

The OpenDota secondary source exposes no machine-readable hero → ability join
(0/127). Its free-form marker audit found markers on only 229/3084 abilities,
and canonical mechanics such as Lion's Impale carry no marker — so absence of a
marker cannot distinguish "does not do it" from "not measured". The source
correction above establishes that a separate Valve KV hero→ability source is
available; that source has not been converted into a complete control
taxonomy.

This is a **measurement** about the audited marker schema, not a judgement
about Dota. The mechanics are real; a source field's absence is not proof that
a mechanic is absent.

## 8. What would change the answer

- A maintained, machine-readable control taxonomy keyed to hero and ability —
  a curated dataset which would have to be maintained across patches. The
  versioned Valve KV source path and its coverage are audited in §47; raw game
  data still does not itself supply canonical threat taxonomy or item response
  rules.
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