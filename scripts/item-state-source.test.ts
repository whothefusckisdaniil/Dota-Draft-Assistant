/**
 * Item-state source tests (ТЗ §17 §22).
 *
 * The fixtures below are TRIMMED: they reproduce the structure of the real
 * Valve itembuilds KV files under GameTracking-Dota2 `game/dota/itembuilds/`,
 * but they are not verbatim copies — a few items per phase, and only the phases
 * each test actually needs. The point is to exercise the parser against the
 * real format, not to reproduce whole files.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILD_PHASES,
  aggregatePhases,
  itemStateFrom,
  parseItemBuild,
  phaseProfile,
  reconcile,
} from './item-state-source.mjs';

const block = (phase, items) =>
  `"#DOTA_Item_Build_${phase}"\n\t\t{\n${items.map((i) => `\t\t\t"item"\t\t"${i}"`).join('\n')}\n\t\t}`;

/** Minimal fixture matching the real Valve itembuilds KV format,
 *  based on default_bane.txt — trimmed, not a verbatim copy. */
const BANE = `"itembuilds"
{
	"author"		"Valve"
	"hero"			"npc_dota_hero_bane"
	"Title"			"Recommended items for Bane"
	"Items"
	{
		${block('Starting_Items', ['item_tango', 'item_clarity', 'item_ward_observer'])}
		${block('Early_Game', ['item_magic_stick', 'item_arcane_boots'])}
		${block('Mid_Items', ['item_magic_wand', 'item_glimmer_cape'])}
		${block('Late_Items', ['item_aether_lens', 'item_force_staff'])}
		${block('Other_Items', ['item_black_king_bar', 'item_ultimate_scepter', 'item_ghost'])}
	}
}`;

/** A second hero, same trimmed format, to test that aggregation spans heroes.
 *  magic_wand is deliberately placed in a different phase than in BANE. */
const SNIPER = `"itembuilds"
{
	"hero"			"npc_dota_hero_sniper"
	"Items"
	{
		${block('Starting_Items', ['item_tango'])}
		${block('Early_Game', ['item_magic_wand'])}
		${block('Other_Items', ['item_aghanims_shard', 'item_ultimate_scepter'])}
	}
}`;

describe('parseItemBuild — real KV format', () => {
  it('parses hero and every phase block', () => {
    const b = parseItemBuild(BANE);
    expect(b.hero).toBe('npc_dota_hero_bane');
    expect(Object.keys(b.phases)).toEqual(['Starting_Items', 'Early_Game', 'Mid_Items', 'Late_Items', 'Other_Items']);
    expect(b.phases.Starting_Items).toEqual(['item_tango', 'item_clarity', 'item_ward_observer']);
    expect(b.phases.Mid_Items).toEqual(['item_magic_wand', 'item_glimmer_cape']);
  });

  it('strips the #DOTA_Item_Build_ prefix and keeps the phase name', () => {
    expect(Object.keys(parseItemBuild(BANE).phases)).toContain('Starting_Items');
  });

  it('returns null for a file that is not an itembuilds KV', () => {
    expect(parseItemBuild('"npc_heroes" { }')).toBeNull();
    expect(parseItemBuild('')).toBeNull();
    expect(parseItemBuild(null)).toBeNull();
  });

  it('covers every phase name the format actually uses', () => {
    expect(BUILD_PHASES).toContain('Starting_Items');
    expect(BUILD_PHASES).toContain('Luxury');
  });
});

describe('aggregatePhases and phaseProfile', () => {
  const map = aggregatePhases([parseItemBuild(BANE), parseItemBuild(SNIPER)]);

  it('merges phases across heroes', () => {
    expect([...map.get('item_tango')].sort()).toEqual(['Starting_Items']);
    // Both fixtures list the scepter under Other_Items, so the union is one phase.
    expect([...map.get('item_ultimate_scepter')].sort()).toEqual(['Other_Items']);
  });

  it('marks a single-phase item as phase-exclusive', () => {
    expect(phaseProfile('item_tango', map).phaseExclusive).toBe(true);
  });

  it('does not mark a multi-phase item as exclusive', () => {
    // magic_wand is Mid_Items for Bane and Early_Game for Sniper, so the union
    // spans two phases and cannot be treated as a single-phase signal.
    expect([...map.get('item_magic_wand')].sort()).toEqual(['Early_Game', 'Mid_Items']);
    expect(phaseProfile('item_magic_wand', map).phaseExclusive).toBe(false);
  });

  it('reports an unreferenced item as such, not as an empty phase list', () => {
    const p = phaseProfile('item_never_built', map);
    expect(p.referenced).toBe(false);
    expect(p.phases).toEqual([]);
  });
});

describe('shard detection — the decisive negative (§17 §6, §12)', () => {
  const map = aggregatePhases([parseItemBuild(BANE), parseItemBuild(SNIPER)]);

  it('the Shard IS referenced by Valve, in ordinary build phases', () => {
    // The finding: the shard is NOT separated from regular equipment anywhere.
    expect(phaseProfile('item_aghanims_shard', map).referenced).toBe(true);
    expect(phaseProfile('item_aghanims_shard', map).phases).toContain('Other_Items');
  });

  it('the Scepter appears in the same phase categories as the Shard', () => {
    const shard = phaseProfile('item_aghanims_shard', map).phases;
    const scepter = phaseProfile('item_ultimate_scepter', map).phases;
    expect(shard.some((p) => scepter.includes(p))).toBe(true);
  });

  it('never infers a special slot from phase membership', () => {
    expect(itemStateFrom('item_aghanims_shard').slotBehavior).toBe('unknown');
  });

  it('the consumed Scepter entity is in no build at all', () => {
    expect(phaseProfile('item_ultimate_scepter_2', map).referenced).toBe(false);
  });
});

describe('consumables — §17 §9', () => {
  it('a starting item is phase-exclusive, which is a real signal', () => {
    const map = aggregatePhases([parseItemBuild(BANE)]);
    expect(phaseProfile('item_clarity', map).phases).toEqual(['Starting_Items']);
  });

  it('but it still does not yield a consumption behaviour', () => {
    expect(itemStateFrom('item_clarity').consumptionBehavior).toBe('unknown');
    expect(itemStateFrom('item_clarity').slotBehavior).toBe('unknown');
  });

  it('never reports "consumed" from a consumable-looking name (§17 §2)', () => {
    for (const id of ['item_clarity', 'item_flask', 'item_tango']) {
      expect(itemStateFrom(id).consumptionBehavior).toBe('unknown');
    }
  });
});

describe('itemStateFrom — everything stays unknown (§17 §9, §20)', () => {
  it('returns unknown for every state axis', () => {
    const s = itemStateFrom('item_bfury');
    expect(s.slotBehavior).toBe('unknown');
    expect(s.consumptionBehavior).toBe('unknown');
    expect(s.permanence).toBe('unknown');
    expect(s.upgradeTarget).toBeNull();
    expect(s.charges).toBeNull();
    expect(s.neutralDrop).toBe('unknown');
  });

  it('stays unknown even for items the OTHER sources do distinguish', () => {
    // The real contract: this source contributes nothing to these axes, even for
    // items that look like they should differ — a charge item, a purchase-capped
    // shard, a recipe product. If a future source fills them in, THESE tests are
    // the ones that must start failing.
    const shapes = [
      itemStateFrom('item_magic_wand'),      // has charges
      itemStateFrom('item_aghanims_shard'),  // stockMax 1
      itemStateFrom('item_ultimate_scepter'),// consumable-looking
      itemStateFrom('item_moon_shard'),      // permanent-looking
    ];
    for (const s of shapes) {
      expect(s.slotBehavior, 'slotBehavior').toBe('unknown');
      expect(s.consumptionBehavior, 'consumptionBehavior').toBe('unknown');
      expect(s.permanence, 'permanence').toBe('unknown');
      expect(s.upgradeTarget, 'upgradeTarget').toBeNull();
    }
  });

  it('is argument-independent: an id that does not exist yields the same state', () => {
    // Documents that the function cannot branch on id or name — there is no
    // per-item data behind it at all. Not a semantic claim: a stub.
    expect(itemStateFrom('not_a_real_item_id_9999')).toEqual(itemStateFrom('item_bfury'));
    expect(itemStateFrom(undefined)).toEqual(itemStateFrom('item_bfury'));
  });
});

describe('reconcile — cross-source comparison (§17 §14)', () => {
  const map = aggregatePhases([parseItemBuild(BANE)]);

  it('joins build phases with STRATZ metadata and flags no conflict', () => {
    const r = reconcile('item_ultimate_scepter', map, { quality: 'rare', isRecipe: false, initialCharges: 0, itemResult: null });
    expect([...r.buildPhases].sort()).toEqual(['Other_Items']);
    expect(r.stratzQuality).toBe('rare');
    expect(r.slotBehavior).toBe('unknown');
    expect(r.conflict).toBe(false);
  });

  it('reports a missing STRATZ entry as null, not as a disagreement', () => {
    const r = reconcile('item_ultimate_scepter', map, null);
    expect(r.stratzQuality).toBeNull();
    expect(r.conflict).toBe(false);
  });
});

