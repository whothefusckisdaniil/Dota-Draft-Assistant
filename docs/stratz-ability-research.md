# STRATZ ability graph audit (ТЗ №30) — STRATZ_ABILITY_PARTIAL

> **Status: audit executed.** Schema discovered by `__type`, never assumed.
> No match crawl, no production data touched, no control taxonomy built.

## 1. Headline

```text
Hero -> Ability            127 / 127   (100%)
unique abilities linked    789
upgrade provenance         typed, 5/5 stat fields
control flags              16 DECLARED, 0 POPULATED
```

The graph ТЗ №29 could not find anywhere **exists here in full**. The control
data inside it does not.

## 2. What the schema actually contains

`HeroType` (12 fields): `id, name, displayName, shortName, aliases,
gameVersionId, abilities, roles, language, talents, facets, stats`.

`HeroAbilityType`: `slot, gameVersionId, abilityId, ability` — a real link node,
not a bare id list.

`AbilityType` (7 fields): `id, name, uri, language, stat, attributes, isTalent`.

`AbilityStatType` (36 fields) carries **explicit, typed upgrade provenance**:
`isGrantedByShard`, `hasShardUpgrade`, `isGrantedByScepter`,
`hasScepterUpgrade`, `isInnate`, plus `isUltimate`, `dispellable`, `duration`,
`damage`, `castRange`, `unitDamageType`, `unitTargetTeam`, `unitTargetFlags`.

Measured across 848 abilities: `scepter=134`, `shard=103`, `innate=126`,
with explicit `no_scepter=712` / `no_shard=743` negatives. "Can stun with a
shard" and "the base ability stuns" are now separable without a single manual
mapping — which is exactly what ТЗ №8 and §11 asked for.

## 3. The join, measured

```text
heroes in constants        : 127
heroes with ability relation: 127/127
heroes with EMPTY ability list: 0
heroes unresolved          : 0
unique abilities linked    : 789
duplicate ability links    : 20
```

Complete. `hero` is not a root field — it lives under `constants`, so the whole
pool is fetched in one query.

## 4. The decisive finding

`ModifierType` declares **27 fields**, and sixteen of them are exactly the
control taxonomy ТЗ №29 could not build anywhere:

```text
isStun  isRoot  isSilence  isMute  isDisarm  isHex  isShackle
isBreak  isMovementSlow  isAttackSlow  isTaunt  isKnockback
isSleep  isCyclone  isBlind  isEthereal
```

`isShackle` is leash and `isKnockback` is forced movement, so the two families
that had **no marker at all** in OpenDota are named here. The schema shape is
exactly right.

**But the data is not there.** `constants.modifiers` returns **20 rows**, and
across all 16 control flags:

```text
isStun unknown trueCount=0      isHex  unknown trueCount=0
isRoot unknown trueCount=0      isBreak unknown trueCount=0
...  every flag: state=unknown, trueCount=0
```

And there is **exactly one edge into `ModifierType` in the entire 513-type
schema** — `ConstantQuery.modifiers`. There is **no `Ability → Modifier` edge**,
so even a populated modifier list could not be attached to the hero abilities
that apply it.

A flag that is declared but never returns a boolean is recorded as `unknown`,
never `not_present`: STRATZ ships the schema shape without the data.

## 5. Comparison with ТЗ №29

| | OpenDota | Valve | STRATZ |
| --- | --- | --- | --- |
| Hero → Ability | NO (0/127) | NO | **YES (127/127)** |
| Upgrade provenance | NO | NO | **YES (5/5 typed)** |
| Control markers | partial, 229/3084 | NO | **declared, 0/16 populated** |
| Version / provenance | snapshot | n/a | timestamp + gameVersionId |

No weighting: this records what each source exposes, not which is better.

## 6. Verdict

```text
VERDICT: STRATZ_ABILITY_PARTIAL
```

Hero → Ability resolves for 127/127 heroes and upgrade provenance is fully
typed, but 16 control flags are DECLARED on `ModifierType` and 0 are POPULATED,
and there is no `Ability → Modifier` edge to reach them through.

**This is a different failure from ТЗ №29, and a more tractable one.** There the
shape was missing entirely. Here the shape is correct — someone modelled these
sixteen mechanics deliberately — and only the population is absent. That is a
data problem with a known address, not an architecture dead end.

## 7. What it unlocks

The graph itself is production-usable *today* for things that need no modifier
data:

- `Hero → Ability` at 100% for all 127 heroes
- typed upgrade provenance (base / shard / scepter / talent / innate)
- 36 typed `AbilityStatType` fields including damage, duration, cast range,
  dispellability and target team

Any enemy feature built on **ability properties** rather than on control
mechanics — `isUltimate`, `isInnate`, damage type, target type, dispellability —
is available now. A control taxonomy still is not.

## 8. Checks

```bash
node scripts/stratz-ability-research.mjs plan          # no network
node scripts/stratz-ability-research.mjs all           # introspection audit
node scripts/stratz-ability-research.mjs all --cached  # re-report from cache
```

21 unit tests cover the join (empty lists, duplicate links, orphan abilities,
null optionals), order-independence of the ability SET, upgrade provenance
including explicit negatives, and the declared-but-unpopulated distinction. A
test asserts that a modifier NAME containing "stun" yields no evidence (§12).

Read-only: one GraphQL `query` operation. `assertReadOnly()` rejects `mutation`,
`subscription` and any write-shaped field before anything is sent. The token is
read from env/`.env`, never cached and never printed.
