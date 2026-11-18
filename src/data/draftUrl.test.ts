import { describe, expect, it } from 'vitest';
import { buildDraftSearch, draftTitle, parseDraftUrl, shareableUrl } from './draftUrl';

describe('parseDraftUrl', () => {
  it('reads enemies in pick order, position and rank', () => {
    expect(parseDraftUrl('?enemy=13,29,8&pos=3&rank=divine')).toEqual({
      enemies: [13, 29, 8], allies: [], bans: [], me: null, allyPos: {}, position: '3', rank: 'DIVINE_IMMORTAL', hasDraft: true,
    });
  });

  it('accepts the encoded comma form too', () => {
    expect(parseDraftUrl('?enemy=13%2C29').enemies).toEqual([13, 29]);
  });

  it('drops junk, duplicates, non-positive ids and anything past 5 enemies', () => {
    expect(parseDraftUrl('?enemy=13,abc,13,,0,-4,1.5,7,8,9,10,11,12').enemies).toEqual([13, 7, 8, 9, 10]);
  });

  it('falls back to all positions / all ranks on invalid values', () => {
    expect(parseDraftUrl('?enemy=1&pos=7&rank=gold')).toMatchObject({ position: 'all', rank: 'ALL' });
    expect(parseDraftUrl('?pos=all').position).toBe('all');
  });

  it('rank slugs are case-insensitive', () => {
    expect(parseDraftUrl('?rank=Herald').rank).toBe('HERALD_GUARDIAN');
    expect(parseDraftUrl('?rank=LEGEND').rank).toBe('LEGEND_ANCIENT');
    expect(parseDraftUrl('?rank=crusader').rank).toBe('CRUSADER_ARCHON');
  });

  it('a link without draft parameters leaves the rank to the stored preference', () => {
    expect(parseDraftUrl('')).toEqual({ enemies: [], allies: [], bans: [], me: null, allyPos: {}, position: 'all', rank: null, hasDraft: false });
    expect(parseDraftUrl('?utm_source=discord').rank).toBeNull();
  });

  it('a shared draft without a rank means all ranks (the sender looked at all ranks)', () => {
    expect(parseDraftUrl('?enemy=1,2').rank).toBe('ALL');
  });
});

describe('allies and bans', () => {
  it('reads allies (max 4) and bans (max 14); a hero lives in one place only', () => {
    const s = parseDraftUrl('?enemy=13,8&ally=1,13,2,3,4,5&ban=8,9,10');
    expect(s.enemies).toEqual([13, 8]);
    expect(s.allies).toEqual([1, 2, 3, 4]); // 13 is an enemy already, 5th ally dropped
    expect(s.bans).toEqual([9, 10]); // 8 is an enemy already
    expect(s.hasDraft).toBe(true);
  });

  it('round-trips allies and bans', () => {
    const state = { enemies: [13], allies: [8, 14], bans: [74], position: 'all' as const, rank: 'ALL' };
    expect(buildDraftSearch('', state)).toBe('?enemy=13&ally=8,14&ban=74');
    expect(parseDraftUrl(buildDraftSearch('', state))).toMatchObject({ enemies: [13], allies: [8, 14], bans: [74] });
  });

  it('allies alone are a draft too', () => {
    expect(parseDraftUrl('?ally=8').rank).toBe('ALL');
  });
});

describe('buildDraftSearch', () => {
  it('encodes the draft with readable commas', () => {
    expect(buildDraftSearch('', { enemies: [1, 5, 23], position: '3', rank: 'ALL' })).toBe('?enemy=1,5,23&pos=3');
    expect(buildDraftSearch('', { enemies: [1], position: 'all', rank: 'DIVINE_IMMORTAL' })).toBe('?enemy=1&rank=divine');
  });

  it('gives a clean URL for an empty default draft', () => {
    expect(buildDraftSearch('?enemy=1&pos=2&rank=herald', { enemies: [], position: 'all', rank: 'ALL' })).toBe('');
  });

  it('keeps unrelated parameters (utm tags)', () => {
    expect(buildDraftSearch('?utm_source=tg&enemy=9', { enemies: [1, 2], position: 'all', rank: 'ALL' }))
      .toBe('?utm_source=tg&enemy=1,2');
  });

  it('round-trips through parseDraftUrl', () => {
    const state = { enemies: [74, 11, 42, 7, 13], position: '5' as const, rank: 'LEGEND_ANCIENT' };
    const parsed = parseDraftUrl(buildDraftSearch('', state));
    expect(parsed).toMatchObject(state);
  });
});

describe('lang in the link', () => {
  it('keeps lang=ru, drops lang for English', () => {
    expect(buildDraftSearch('?lang=en', { enemies: [1], position: 'all', rank: 'ALL', lang: 'ru' })).toBe('?enemy=1&lang=ru');
    expect(buildDraftSearch('?lang=ru', { enemies: [1], position: 'all', rank: 'ALL', lang: 'en' })).toBe('?enemy=1');
  });
});

describe('draftTitle', () => {
  it('names the enemies', () => {
    expect(draftTitle(['Puck', 'Tidehunter'], 'Dota Draft Assistant — Counter Picks')).toBe('Counters to Puck, Tidehunter — Dota Draft Assistant');
    expect(draftTitle([], 'Dota Draft Assistant — Counter Picks')).toBe('Dota Draft Assistant — Counter Picks');
    expect(draftTitle(['Пак'], 'base', 'Контрпики против {names} — Dota Draft Assistant')).toBe('Контрпики против Пак — Dota Draft Assistant');
  });
});

describe('shareableUrl', () => {
  it('drops tracking tags but keeps the draft', () => {
    expect(shareableUrl('https://x.app/?utm_source=tg&enemy=13,8&utm_medium=chat&pos=2&fbclid=abc'))
      .toBe('https://x.app/?enemy=13,8&pos=2');
    expect(shareableUrl('https://x.app/?enemy=13%2C8')).toBe('https://x.app/?enemy=13,8');
  });
});

describe('your hero (?hero=)', () => {
  it('parses and writes your hero, never twice in the draft', async () => {
    const { parseDraftUrl, buildDraftSearch } = await import('./draftUrl');
    expect(parseDraftUrl('?hero=26&enemy=1,2').me).toBe(26);
    expect(parseDraftUrl('?enemy=26&hero=26').me).toBeNull();
    expect(parseDraftUrl('?hero=junk').me).toBeNull();
    expect(parseDraftUrl('?hero=26').hasDraft).toBe(true);
    expect(buildDraftSearch('', { enemies: [1], me: 26, position: '5', rank: 'ALL' })).toBe('?enemy=1&hero=26&pos=5');
  });
});

describe('ally positions (?allypos=)', () => {
  it('parses positions only for listed allies and writes them back', async () => {
    const { parseDraftUrl, buildDraftSearch } = await import('./draftUrl');
    expect(parseDraftUrl('?ally=85,27&allypos=85-4,27-9,99-3').allyPos).toEqual({ 85: '4' });
    expect(buildDraftSearch('', { enemies: [], allies: [85, 27], allyPos: { 85: '4' }, position: '3', rank: 'ALL' })).toBe('?ally=85,27&allypos=85-4&pos=3');
  });
});
