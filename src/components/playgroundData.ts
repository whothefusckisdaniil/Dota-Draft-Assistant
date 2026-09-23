import { APP_CONFIG } from '../config';
import type { PlayRow } from '../scoring/replay';

export interface PlayHero {
  id: string;
  name: string;
  posScore: number;
}

export interface PlayPreset {
  title: string;
  note: string;
  heroes: PlayHero[];
  rows: Record<string, PlayRow[]>;
}

export const PLAY_CFG = APP_CONFIG.scoring;

export const PLAY_PRESETS: PlayPreset[] = [
  {
    title: '55%/100g vs 53%/10k',
    note: 'Raw WR favors A (+5.0 vs +3.0), shrunk nearly ties (+3.13 vs +2.98) — the confidence multiplier (0.65 vs 1.0) decides: final +1.83 vs +2.71.',
    heroes: [
      { id: 'A', name: 'Hero A — 55% WR', posScore: 7 },
      { id: 'B', name: 'Hero B — 53% WR', posScore: 7 },
    ],
    rows: {
      A: [{ id: 'a1', enemy: 'Puck', games: 100, wr: 55 }],
      B: [{ id: 'b1', enemy: 'Puck', games: 10000, wr: 53 }],
    },
  },
  {
    title: 'Higher mean wins: 60/60/40 vs 53/53/53',
    note: 'Current model rewards the higher weighted mean and has NO variance penalty. Spiky wins: team +2.78 vs +2.50, final +2.30 vs +2.10 (posScore 7). Numbers pinned in replay.test.ts.',
    heroes: [
      { id: 'A', name: 'Hero A — higher mean', posScore: 7 },
      { id: 'B', name: 'Hero B — flat profile', posScore: 7 },
    ],
    rows: {
      A: [
        { id: 'a1', enemy: 'Puck', games: 300, wr: 60 },
        { id: 'a2', enemy: 'Tidehunter', games: 300, wr: 60 },
        { id: 'a3', enemy: 'Juggernaut', games: 300, wr: 40 },
      ],
      B: [
        { id: 'b1', enemy: 'Puck', games: 300, wr: 53 },
        { id: 'b2', enemy: 'Tidehunter', games: 300, wr: 53 },
        { id: 'b3', enemy: 'Juggernaut', games: 300, wr: 53 },
      ],
    },
  },
  {
    title: 'Average confidence trap: 5x200g vs 4x2000g+40g',
    note: 'Same 55% everywhere. Average sample (1608g) gives B confidence 1.0 vs A 0.71 — and B also shrinks less, so B wins big (final ~4.1 vs ~2.7). A min-based confidence would cut B to sqrt(40/400)=0.32: the average masks the 40g weak link.',
    heroes: [
      { id: 'A', name: 'Hero A — even 200g', posScore: 7 },
      { id: 'B', name: 'Hero B — 40g weak link', posScore: 7 },
    ],
    rows: {
      A: ['Puck', 'Tide', 'Jugg', 'Sven', 'Lion'].map((e, i) => ({ id: `a${i}`, enemy: e, games: 200, wr: 55 })),
      B: ['Puck', 'Tide', 'Jugg', 'Sven', 'Lion'].map((e, i) => ({ id: `b${i}`, enemy: e, games: i === 4 ? 40 : 2000, wr: 55 })),
    },
  },
];

export function num(v: string, fb: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}
