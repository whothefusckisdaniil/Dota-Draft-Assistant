import type { Hero } from '../types';
import type { PositionFilter } from '../config';

export type Lane = Exclude<PositionFilter, 'all'>;

const EXTRA_AFFINITY: Record<string, Partial<Record<Lane, number>>> = {
  Bristleback: { 3: 1.5 },
  Timbersaw: { 3: 1.5 },
  Slardar: { 3: 1.5 },
  Beastmaster: { 3: 1.5 },
  'Sand King': { 3: 1.5 },
  Enigma: { 3: 1.5 },
  'Dark Seer': { 3: 1.5 },
  Doom: { 3: 1 },
  'Night Stalker': { 3: 1 },
  Tusk: { 4: 2, 3: 0.5 },
  Rubick: { 4: 2 },
  Hoodwink: { 4: 2 },
  'Earth Spirit': { 4: 2 },
  Earthshaker: { 4: 1.5 },
  Mirana: { 4: 1.5 },
  'Bounty Hunter': { 4: 1.5 },
  Clockwerk: { 4: 1, 3: 1 },
  Disruptor: { 5: 2 },
  'Shadow Demon': { 5: 2 },
  Warlock: { 5: 2 },
  'Crystal Maiden': { 5: 2 },
  Lion: { 5: 1.5, 4: 1 },
  'Shadow Shaman': { 5: 1.5 },
  Dazzle: { 5: 1.5 },
  'Witch Doctor': { 5: 1.5 },
  Lich: { 5: 1.5 },
  'Ancient Apparition': { 5: 1.5 },
  Oracle: { 5: 1.5 },
  'Treant Protector': { 5: 1.5 },
  'Keeper of the Light': { 5: 1 },
  Jakiro: { 5: 1, 4: 0.5 },
  'Skywrath Mage': { 4: 1, 5: 1 },
  'Winter Wyvern': { 5: 1 },
  Silencer: { 5: 1, 2: 0.5 },
};

export { EXTRA_AFFINITY };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function positionScoreBase(
  hero: Hero,
  pos: Lane,
  affinity: Partial<Record<Lane, number>>,
): number {
  const r = new Set(hero.roles);
  const has = (...xs: string[]) => xs.some((x) => r.has(x));
  let s = 3.2;
  switch (pos) {
    case '1':
      if (has('Carry')) s += 4;
      if (has('Escape')) s += 0.8;
      if (has('Pusher')) s += 0.5;
      if (has('Durable')) s += 0.4;
      if (has('Support')) s -= 3.2;
      if (has('Initiator') && !has('Carry')) s -= 1;
      break;
    case '2':
      if (has('Nuker')) s += 1.8;
      if (has('Carry')) s += 1.4;
      if (has('Escape')) s += 1;
      if (has('Disabler')) s += 0.4;
      if (has('Support')) s -= 1.6;
      if (has('Durable') && !has('Carry')) s -= 0.8;
      if (has('Pusher') && !has('Nuker')) s -= 0.5;
      break;
    case '3':
      if (has('Initiator')) s += 2;
      if (has('Durable')) s += 1.8;
      if (has('Disabler')) s += 0.8;
      if (has('Carry')) s += 0.5;
      if (has('Support') && !has('Durable') && !has('Initiator')) s -= 2.2;
      if (has('Escape') && !has('Initiator')) s -= 0.4;
      break;
    case '4':
      if (has('Support')) s += 1.6;
      if (has('Disabler')) s += 1.2;
      if (has('Nuker')) s += 1;
      if (has('Escape')) s += 0.9;
      if (has('Initiator')) s += 0.6;
      if (has('Carry') && !has('Support')) s -= 2.4;
      if (has('Durable') && !has('Initiator')) s -= 0.6;
      break;
    case '5':
      if (has('Support')) s += 2.4;
      if (has('Disabler')) s += 1.2;
      if (has('Nuker')) s += 0.8;
      if (has('Carry') && !has('Support')) s -= 3;
      if (has('Escape') && !has('Support')) s -= 1.2;
      if (has('Initiator') && !has('Support') && !has('Disabler')) s -= 1;
      break;
  }
  s += affinity[pos] ?? 0;
  return clamp(Math.round(s * 10) / 10, 0, 10);
}
