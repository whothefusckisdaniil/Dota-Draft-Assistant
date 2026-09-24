export const APP_CONFIG = {
  // --- OpenDota ---
  apiBase: 'https://api.opendota.com/api',
  cdnBase: 'https://cdn.cloudflare.steamstatic.com',
  docsUrl: 'https://docs.opendota.com/',

  // --- Caching (localStorage, hours) ---
  cacheTtlHours: {
    heroes: 24,
    heroStats: 24,
    matchups: 24,
    patch: 24,
  },

  // --- Scoring model (MVP, tweakable) ---
  scoring: {
    // wins of candidate vs enemy are stored from enemy perspective,
    // we invert: candidateWinrate = 1 - wins/games_played
    // delta is in percentage points vs 50%
    neutralWinrate: 50,
    // shrink tiny samples toward neutral before averaging
    shrinkageK: 60,
    // a single matchup with fewer games than this is not usable (treated as missing)
    minMatchesPerPair: 20,
    // V2 strict coverage: a candidate must have a usable matchup vs EVERY
    // selected enemy, otherwise it is hidden. Partial-lineup heroes must not
    // compete with full-lineup heroes. If false, candidates need at least
    // minUsableEnemies usable matchups instead.
    requireFullCoverage: true,
    // Used only when requireFullCoverage = false: minimum usable matchups.
    minUsableEnemies: 1,
    // do not show candidates whose average sample is below this
    minimumSampleAvg: 40,
    // confidence = min(1, sqrt(avgMatches / confidenceDenominator))
    confidenceDenominator: 400,
    // teamCounterScore = weighted average of matchup deltas (weight = sqrt(games))
    // finalScore = counterScore * wCounter + positionBonus * wPosition, then blended toward 0 by (1 - confidence)
    wCounter: 0.8,
    wPosition: 0.2,
    // --- V8 experiment: weak-link penalty (model W) ---
    // A matchup whose shrunk delta is below this many pp counts as a "very bad
    // matchup"; each such matchup subtracts weakLinkPenalty points from raw.
    // Fixed a priori (no fitting to the live drafts): threshold -5pp ≈ 45% WR
    // against an enemy, penalty 3pp per bad matchup — enough to reorder the
    // top when a candidate has a real weak link, not enough to dominate.
    weakLinkThreshold: -5,
    weakLinkPenalty: 3,
    // positionBonus mapped from positionScore 0..10 -> -4..+4 points
    positionBonusRange: 4,
    // candidates with positionScore below this are hidden for a specific position lane
    minPositionScore: {
      all: 0,
      1: 4.5,
      2: 4.5,
      3: 4.5,
      4: 4.5,
      5: 4.5,
    } as Record<string, number>,
    // hard exclusion: never recommend these role mismatches (e.g. pure hard support as pos1)
    topN: 15,
  },

  ui: {
    maxEnemies: 5,
    searchLimit: 9,
  },
} as const;

export type PositionFilter = 'all' | '1' | '2' | '3' | '4' | '5';

export const POSITIONS: { id: PositionFilter; label: string; short: string }[] = [
  { id: 'all', label: 'All Positions', short: 'All' },
  { id: '1', label: 'Position 1 — Carry', short: 'Carry' },
  { id: '2', label: 'Position 2 — Mid', short: 'Mid' },
  { id: '3', label: 'Position 3 — Offlane', short: 'Offlane' },
  { id: '4', label: 'Position 4 — Soft Support', short: 'Support 4' },
  { id: '5', label: 'Position 5 — Hard Support', short: 'Support 5' },
];
