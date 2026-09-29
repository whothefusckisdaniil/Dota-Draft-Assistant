# Item state source research (ТЗ №17)

> **Research only.** `public/data`, `src/scoring`, `src/components`,
> `.github/workflows`, the generator and the ItemPrior engine are untouched.

## 1. Problem and headline

STRATZ has no consumption or slot fields (ТЗ №16, verified against live data).
This research asks whether Dota 2 **client game data** can supply them.

**Answer: the fields provably EXIST, but no public mirror publishes their
per-item VALUES.** The engine class `CDOTA_Item` (recovered from the shipped
binary by DumpSource2) names every field ТЗ №16 wanted — `m_bPermanent`,
`m_bCanBeConsumed`, `m_bIsUpgradeable`, `m_nUpgradeGoal`, `m_bIsNeutralActiveDrop`
— and STRATZ's own metadata is a projection of a subset of them. But the file
that carries the values is gone.

## 2. The premise of the ТЗ is factually broken

`game/dota/gameinfo.gi` **does** declare the file:

```
"ItemsFiles"  "scripts/npc/items.txt; scripts/npc/items_staging.txt; scripts/npc/npc_items_custom.txt"
```

But `scripts/npc/items.txt` **is not in the repository**:

| path | result |
| --- | --- |
| `game/dota/scripts/npc/items.txt` | 404 |
| `game/dota/scripts/items/items_game.txt` | 404 |
| `game/dota/pak01_dir/scripts/npc/items.txt` | 404 |
| `game/dota/scripts/npc/npc_items.txt` | 404 |
| commit history for that path | `[]` — never present |

Only **199 paths** remain under `game/dota/` (154 `.txt`, mostly strings and
per-hero itembuilds). Core KV gameplay files were removed. So "use the current
version of the repository" is impossible for `items.txt`; a historical mirror
would be a stale snapshot, which §1 explicitly rules out.

## 3. What IS available: the engine class

`DumpSource2/schemas/server/CDOTA_Item.h` is generated from the shipped binary's
debug info, so these field names are **authoritative**:

```cpp
bool   m_bPermanent;               bool   m_bCanBeConsumed;
bool   m_bIsUpgradeable;           int32  m_nUpgradeGoal;
int32  m_nUpgradeProgress;         bool   m_bCastOnPickup;
int32  m_iInitialCharges;          bool   m_bRequiresCharges;
bool   m_bIsNeutralActiveDrop;     bool   m_bIsNeutralPassiveDrop;
bool   m_bCanBeUsedOutOfInventory; bool   m_bCanPutIntoSatchel;
bool   m_bPurchasable;             bool   m_bSellable;  bool m_bDroppable;
bool   m_bRecipe;                  bool   m_bRecipeConsumesCharges;
GameTime_t m_flPurchaseTime;       int32  m_iState;
```

Client-only additions: `m_iMaxCharges`, `m_bHideCharges`, `m_bDisplayCharges`.

> **There is no `m_iInventorySlots`.** The engine class exposes no inventory-slot
> count at all. This is the structural reason slot behaviour cannot be recovered
> even in principle from this class.

## 4. `behavior` bitmask: left opaque, per §4

No authoritative `DOTA_ITEM_BEHAVIOR_*` enum exists in any available source —
`dota_common.proto` (which held it) was removed, and the surviving protos
(`enums_clientserver`, `dota_client_enums`, `dota_clientmessages`) contain no
item-behaviour enum. **STRATZ `behavior` therefore stays an opaque integer.** No
guessed bit mask is used anywhere.

## 5. Protobuf: the consume command exists, and proves nothing about items

From `Protobufs/dota_commonmessages.proto` (real, current):

```
DOTA_UNIT_ORDER_PURCHASE_ITEM            = 16
DOTA_UNIT_ORDER_SELL_ITEM                = 17
DOTA_UNIT_ORDER_DISASSEMBLE_ITEM         = 18
DOTA_UNIT_ORDER_TAKE_ITEM_FROM_NEUTRAL_ITEM_STASH = 38
DOTA_UNIT_ORDER_CONSUME_ITEM             = 41
```

Exactly as §5 predicted: a consume *command* exists and says nothing about which
item consumes which, nor about slots. `EPlayerInventorySnapshotFlags` is **not
present** in any surviving proto.

## 6–8. Shard, Scepter, Blessing, Moon Shard

| item | in itembuilds? | phases (128 heroes) | state properties |
| --- | --- | --- | --- |
| Aghanim's Shard | 89 heroes | Other 53, Late 28, Mid 8 | `unknown` |
| Aghanim's Scepter | 126 heroes | Late 59, Other 58, Mid 8, Core 1 | `unknown` |
| Moon Shard | 34 heroes | Other 32, Late 2 | `unknown` |
| **Aghanim's Blessing** | **0 heroes** | — | `unknown` |

**The decisive negative result:** the Shard's phase set is the same *kind* of set
as Mjollnir's (`Late_Items`, `Other_Items`) and a subset of the Scepter's.
Valve's own default builds place the Shard in ordinary equipment phases. There is
no separate category for it, so build data cannot distinguish it from a wand.

The Blessing appearing in **zero** builds is consistent with it being a consumed
state rather than a buildable item — but that is an inference from absence, not

## 9. Consumables

`item_tango` is `Starting_Items` in **152/152** references and nowhere else;
`item_clarity`, `item_ward_observer`, `item_flask` likewise. Starting-item
exclusivity is a **real, Valve-authored signal** — but it is a build-phase hint,
not `consumptionBehavior`, and it does not imply a slot claim. Per §9, "has
charges" is never read as "does not occupy a slot".

## 10. Neutral items

**0 references** to `item_river_vial*` across all 128 builds; one neutral-ish item
(`item_lotus_orb`). Neutral items are effectively absent from Valve's default
builds, so this source says nothing about neutral slots. The engine has
`m_bIsNeutralActiveDrop` / `m_bIsNeutralPassiveDrop` / `m_nNeutralDropTeam` — field
names without values.

## 11. Slot semantics — still unknown, now for a proven reason

ТЗ §15.1 said slot behaviour was unknown because *our metadata* lacked fields.
This research shows something stronger: **the engine class itself has no slot
field**, and the file that would populate one is gone. This is not a collection
gap closable by querying a different endpoint.

## 12–14. Consumption graph and cross-source reconciliation

No consumption edge is derivable. Cross-source reconciliation over the shipped
catalogue finds **no conflicts** — because the build source contributes only
build phases while every state axis stays `unknown` on both sides. `conflict` is
`false` for all items, which is itself the finding: two sources that are both
silent cannot disagree.

## 15–16. Coverage

| property | confirmed | unknown |
| --- | --- | --- |
| build phase (Valve-authored) | 149 distinct items referenced | rest |
| slot semantics | **0** | **all** |
| consumption behaviour | **0** | **all** |
| permanence | **0** | **all** |
| upgrade target | **0** | **all** |
| charges (from this source) | 0 — STRATZ has 18 | all here |

## 17. Reliability (§19)

| aspect | assessment |
| --- | --- |
| official Valve? | **No.** GameTracking is a community mirror of shipped files |
| authoritative? | Partly — `CDOTA_Item.h` derives from binary debug info, so field *names* are as authoritative as they can be; values are absent |
| update cadence | mirrors Valve pushes, minutes to hours behind a patch |
| patch sync | reliable for files that exist; several core files were removed permanently |
| risk | **content disappears.** `items.txt` is already gone |

This is not a Valve API and must not be described as one.

## 18. Update strategy (§20)

| option | verdict |
| --- | --- |
| A. GitHub raw fetch of itembuilds | **Viable.** 128 files, stable paths, parse in ms |
| B. Repository snapshot | viable, ~512 KB for all builds |
| C. Direct Valve feed | not available |
| D. Another machine-readable source | not found for values |

A weekly or on-patch refresh of the **itembuilds** files is cheap and safe. A
refresh that expects `items.txt` to reappear should fail loudly rather than fall
back to a stale copy.

## 19. Proposed `ItemStateMetadata`

```ts
interface ItemStateMetadata {
  id: number;
  // Build phase authored by Valve — a HINT, not a slot classification.
  buildPhases: string[] | null;
  buildPhaseExclusive: boolean | null;

  // Every state axis below is `unknown` in this source. They are declared so a
  // future source can fill them, and so nothing defaults them to `false`.
  slotBehavior: 'unknown';
  consumptionBehavior: 'unknown';
  permanence: 'unknown';
  upgradeTarget: number | null;
  charges: { initial: number | null; max: number | null } | null;
  neutralDrop: 'unknown';
  purchasable: 'unknown';
  recipe: 'unknown';
}
```

## 20. Five answers (§26)

**A. Can we determine inventory slot behaviour? — NO.**
The engine class has no slot field; the value file is gone; build data does not
separate the Shard from a wand.

**B. Can we determine consumable behaviour? — NO.**
`m_bPermanent` / `m_bCanBeConsumed` exist as names only. Starting-item phase
exclusivity is a hint, not the property.

**C. Can we determine Scepter / Shard / Moon Shard consumption? — NO.**
The Blessing appears in zero builds and no field links it to the Scepter. §7
forbids inferring this from the `_2` name suffix, and nothing else exists.

**D. Can we build reliable `ItemStateMetadata`? — PARTIAL.**
Build phases: yes, and genuinely useful. Every state axis: no.

**E. Can we safely start the 6-slot optimizer? — NO.**

### GO / PARTIAL / NO-GO

**NO-GO** for the slot/consume model. **GO** for one narrow, useful addition:
ingesting the 128 itembuilds files as a **build-phase prior** — a Valve-authored,
hero-scoped, position-free hint that complements the STRATZ frequency prior and
costs 512 KB.

That prior is *not* a build order and *not* a slot model, and must be labelled as
such wherever it is used.

## 21. Reproducing

`scripts/item-state-source.mjs` is pure and offline. The files it parses were
fetched from `raw.githubusercontent.com/SteamDatabase/GameTracking-Dota2/master/game/dota/itembuilds/`.
`scripts/item-state-source.test.ts` uses real captured file content.

evidence, and is recorded as such.
