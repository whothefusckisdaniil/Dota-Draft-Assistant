/**
 * The single source of truth for OpenDota rank tiers in research code.
 *
 * ## The scale
 *
 * OpenDota numbers ranks as <base> + 0..4 for the five divisions of a bracket,
 * with Immortal as a single tier:
 *
 *     Herald 10-15   Guardian 20-25   Crusader 30-35   Archon 40-45
 *     Legend 50-55   Ancient 60-65   Divine  70-75   Immortal 80
 *
 * ## Why this file exists
 *
 * Four research scripts each carried their own `min: 10, max: 15` labelled
 * `Herald/Guardian`. That range is **Herald alone**. The label was wrong, and
 * worse, the sample was wrong: the executed 16-match parser experiment covered
 * Herald, Guardian, Crusader and Archon and never touched Legend/Ancient or
 * Divine/Immortal, while presenting itself as four calibrated buckets.
 *
 * So: brackets are 5-wide and must never be labelled as a PAIR. The broad
 * buckets below are the only place two adjacent brackets are legitimately
 * merged, and they merge them on purpose and say so.
 *
 * Verified against live `/publicMatches?min_rank=…&max_rank=…` responses
 * (docs/public-match-research.md §2).
 */

export const BRACKETS = [
  { key: 'herald', label: 'Herald', min: 10, max: 15 },
  { key: 'guardian', label: 'Guardian', min: 20, max: 25 },
  { key: 'crusader', label: 'Crusader', min: 30, max: 35 },
  { key: 'archon', label: 'Archon', min: 40, max: 45 },
  { key: 'legend', label: 'Legend', min: 50, max: 55 },
  { key: 'ancient', label: 'Ancient', min: 60, max: 65 },
  { key: 'divine', label: 'Divine', min: 70, max: 75 },
  { key: 'immortal', label: 'Immortal', min: 80, max: 80 },
];

/** The single bracket a tier belongs to, or null when it is off-scale. */
export function bracketOf(tier) {
  return BRACKETS.find((b) => tier >= b.min && tier <= b.max) ?? null;
}

/** Human label for a tier, e.g. 34 -> "Crusader". Never a guess. */
export function bracketLabel(tier) {
  return bracketOf(tier)?.label ?? `unmapped(${tier})`;
}

/**
 * The four broad buckets the project calibrates against: Herald→Immortal, each
 * merging two adjacent brackets.
 *
 * `70-80` deliberately spans Divine (70-75) AND Immortal (80), because Immortal
 * is a single tier rather than a five-wide band.
 */
export const BROAD_BUCKETS = [
  { key: 'herald_guardian', label: 'Herald/Guardian', brackets: ['herald', 'guardian'], min: 10, max: 25 },
  { key: 'crusader_archon', label: 'Crusader/Archon', brackets: ['crusader', 'archon'], min: 30, max: 45 },
  { key: 'legend_ancient', label: 'Legend/Ancient', brackets: ['legend', 'ancient'], min: 50, max: 65 },
  { key: 'divine_immortal', label: 'Divine/Immortal', brackets: ['divine', 'immortal'], min: 70, max: 80 },
];

/** The broad bucket a tier belongs to, or null. */
export function broadBucketOf(tier) {
  return BROAD_BUCKETS.find((b) => tier >= b.min && tier <= b.max) ?? null;
}

/** The exact bracket a tier belongs to — what a raw experiment actually sampled. */
export function exactStrata(tier) {
  return bracketOf(tier)?.label ?? `unmapped(${tier})`;
}
