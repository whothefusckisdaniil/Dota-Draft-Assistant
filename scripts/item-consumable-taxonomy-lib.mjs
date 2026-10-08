/**
 * ТЗ №40 — pure audit of authoritative item metadata fields.
 *
 * Classification evidence is read only from Valve item fields. Item names
 * are used solely as exact canonical join keys (`items.json.dname` ->
 * `DOTAAbilities` entry); they are never inspected to assign a class.
 */

function tokenizeKeyValues(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (char === '{' || char === '}') {
      tokens.push(char);
      index += 1;
      continue;
    }
    if (char === '"') {
      index += 1;
      let value = '';
      while (index < source.length) {
        if (source[index] === '\\') {
          value += source[index + 1] ?? '';
          index += 2;
        } else if (source[index] === '"') {
          index += 1;
          break;
        } else {
          value += source[index];
          index += 1;
        }
      }
      tokens.push(value);
      continue;
    }
    let end = index;
    while (end < source.length && !/[\s{}]/.test(source[end])) end += 1;
    tokens.push(source.slice(index, end));
    index = end;
  }
  return tokens;
}

function parseObject(tokens, cursor) {
  const value = {};
  while (cursor.index < tokens.length && tokens[cursor.index] !== '}') {
    const key = tokens[cursor.index];
    cursor.index += 1;
    if (cursor.index >= tokens.length) {
      throw new Error(`Unexpected end of KeyValues after key "${key}"`);
    }
    if (tokens[cursor.index] === '{') {
      cursor.index += 1;
      value[key] = parseObject(tokens, cursor);
    } else {
      if (tokens[cursor.index] === '}') {
        throw new Error(`Missing value for KeyValues key "${key}"`);
      }
      value[key] = tokens[cursor.index];
      cursor.index += 1;
    }
  }
  if (tokens[cursor.index] !== '}') throw new Error('Unclosed KeyValues object');
  cursor.index += 1;
  return value;
}

/** Parse Valve's items.txt KeyValues without assigning item classes. */
export function parseValveItems(source) {
  if (typeof source !== 'string' || source.length === 0) {
    throw new TypeError('parseValveItems: source must be a non-empty string');
  }
  const tokens = tokenizeKeyValues(source.replace(/^\uFEFF/, ''));
  if (tokens[0] !== 'DOTAAbilities' || tokens[1] !== '{') {
    throw new Error('parseValveItems: expected DOTAAbilities root');
  }
  const cursor = { index: 2 };
  const root = parseObject(tokens, cursor);
  const entries = Object.entries(root)
    .filter(([key, value]) => key.startsWith('item_') &&
      value !== null && typeof value === 'object')
    .map(([canonicalKey, fields]) => ({ canonicalKey, fields }))
    .sort((a, b) => a.canonicalKey < b.canonicalKey ? -1 : a.canonicalKey > b.canonicalKey ? 1 : 0);
  return entries;
}

function enumField(value) {
  return typeof value === 'string' ? value : null;
}

function boolField(value) {
  if (value === '1') return true;
  if (value === '0') return false;
  return null;
}

/**
 * Reconcile existing shipped item ids to Valve KV by exact canonical key and
 * summarize field coverage/conflicts. No fallback or item-name heuristics.
 */
export function auditConsumableTaxonomy(catalogue, valveEntries) {
  if (!catalogue || typeof catalogue !== 'object' || Array.isArray(catalogue)) {
    throw new TypeError('auditConsumableTaxonomy: catalogue must be an item map');
  }
  if (!Array.isArray(valveEntries)) {
    throw new TypeError('auditConsumableTaxonomy: valveEntries must be an array');
  }
  const valveByKey = new Map(valveEntries.map((entry) => [entry.canonicalKey, entry.fields]));
  const rows = Object.values(catalogue)
    .map((item) => {
      const fields = valveByKey.get(item.dname);
      return {
        itemId: item.id,
        canonicalKey: item.dname,
        sourceFound: fields !== undefined,
        quality: enumField(fields?.ItemQuality),
        permanent: boolField(fields?.ItemPermanent),
        purchasable: boolField(fields?.ItemPurchasable),
        initialCharges: fields?.ItemInitialCharges === undefined
          ? null
          : Number.isFinite(Number(fields.ItemInitialCharges))
            ? Number(fields.ItemInitialCharges)
            : null,
        stackable: boolField(fields?.ItemStackable),
      };
    })
    .sort((a, b) => a.itemId - b.itemId);
  const count = (predicate) => rows.filter(predicate).length;
  const qualityCounts = {};
  for (const row of rows) {
    const key = row.quality ?? '(absent)';
    qualityCounts[key] = (qualityCounts[key] ?? 0) + 1;
  }
  const qualityConsumable = rows.filter((row) =>
    row.quality === 'consumable' || row.quality?.split(';').includes('consumable'),
  );
  const itemClassification = rows.map((row) => {
    const taggedConsumable = row.quality === 'consumable' ||
      row.quality?.split(';').includes('consumable');
    if (taggedConsumable && row.permanent === true) {
      return { ...row, classification: 'conflict' };
    }
    if (taggedConsumable) return { ...row, classification: 'consumable-tagged' };
    if (row.permanent === true) return { ...row, classification: 'permanent-flagged' };
    return { ...row, classification: 'unknown' };
  });
  const permanentCounts = {
    true: count((row) => row.permanent === true),
    false: count((row) => row.permanent === false),
    unknown: count((row) => row.permanent === null),
  };
  const consumablePermanentCrossTab = {
    permanent: qualityConsumable.filter((row) => row.permanent === true).length,
    nonPermanent: qualityConsumable.filter((row) => row.permanent === false).length,
    unknown: qualityConsumable.filter((row) => row.permanent === null).length,
  };
  const consumablePermanentConflicts = rows.filter((row) =>
    row.quality?.split(';').includes('consumable') && row.permanent === true,
  );
  const classificationCounts = {
    consumableTagged: itemClassification.filter((row) => row.classification === 'consumable-tagged').length,
    permanentFlagged: itemClassification.filter((row) => row.classification === 'permanent-flagged').length,
    conflict: itemClassification.filter((row) => row.classification === 'conflict').length,
    unknown: itemClassification.filter((row) => row.classification === 'unknown').length,
  };
  const unmatched = itemClassification.filter((row) => !row.sourceFound);

  return {
    totals: {
      catalogueItems: rows.length,
      sourceEntries: valveEntries.length,
      exactSourceMatches: count((row) => row.sourceFound),
      sourceMissing: count((row) => !row.sourceFound),
      qualityKnown: count((row) => row.quality !== null),
      qualityUnknown: count((row) => row.quality === null),
    },
    qualityCounts,
    permanentCounts,
    fieldsCoverage: {
      purchasableKnown: count((row) => row.purchasable !== null),
      initialChargesKnown: count((row) => row.initialCharges !== null),
      stackabilityKnown: count((row) => row.stackable !== null),
    },
    classificationCounts,
    qualityConsumableCount: qualityConsumable.length,
    qualityConsumablePermanentCrossTab: consumablePermanentCrossTab,
    qualityConsumablePermanentConflicts: consumablePermanentConflicts,
    consumableRows: qualityConsumable,
    unmatched: unmatched.map(({ itemId, canonicalKey }) => ({ itemId, canonicalKey })),
    rows: itemClassification,
    supportsExhaustiveBinaryTaxonomy:
      unmatched.length === 0 &&
      classificationCounts.unknown === 0 &&
      classificationCounts.conflict === 0,
  };
}
