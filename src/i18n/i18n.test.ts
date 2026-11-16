import { describe, expect, it } from 'vitest';
import heroesRaw from '../../public/data/heroes.json';
import type { CandidateScore, Hero } from '../types';
import { searchHeroes } from '../data/heroes';
import { HERO_NAMES_RU } from './heroNamesRu';
import { STRINGS } from './strings';
import { detectLang, explainCandidate, heroDisplayName, ruPlural, type I18n } from './index';
import { buildDraftSearch, parseDraftUrl } from '../data/draftUrl';

const heroes = (heroesRaw as unknown as Omit<Hero, 'nameRu'>[]).map((h) => ({
  ...h,
  nameRu: HERO_NAMES_RU[h.key.replace('npc_dota_hero_', '')]?.ru ?? '',
})) as Hero[];
const byName = (name: string) => heroes.find((h) => h.name === name)!;

describe('UI strings', () => {
  const en = STRINGS.en;
  const ru = STRINGS.ru;
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('RU has exactly the EN keys, none empty', () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries(ru)) expect(v.trim(), k).not.toBe('');
  });

  it('placeholders match between languages', () => {
    for (const k of Object.keys(en) as (keyof typeof en)[]) expect(vars(ru[k]), k).toEqual(vars(en[k]));
  });

  it('RU strings are actually Russian (no untranslated English left)', () => {
    const allowedLatin = /STRATZ|OpenDota|Dota|Dotabuff|Valve|Steam|ID|WR|jug|\{\w+\}/g;
    for (const [k, v] of Object.entries(ru)) {
      if (k === 'title.base' || k === 'title.draft') continue;
      expect(/[а-яё]/i.test(v.replace(allowedLatin, '')), k).toBe(true);
    }
  });
});

describe('Russian hero names', () => {
  // A hero released yesterday has no Russian name yet: the RU UI shows the
  // English name and the daily data job warns (scripts/check-hero-assets.mjs).
  // It must not fail the tests, or the refresh would stop for every hero.
  it('every hero has a full Cyrillic name (a few just-released heroes may lag)', () => {
    const missing = heroes.filter((h) => !HERO_NAMES_RU[h.key.replace('npc_dota_hero_', '')]);
    expect(missing.length, `missing in src/i18n/heroNamesRu.ts: ${missing.map((h) => h.name).join(', ')}`).toBeLessThanOrEqual(3);
    for (const h of heroes) {
      const entry = HERO_NAMES_RU[h.key.replace('npc_dota_hero_', '')];
      if (entry) expect(entry.ru, h.name).toMatch(/[А-ЯЁа-яё]/);
    }
  });

  it('few stale entries for heroes that are not in the game', () => {
    const keys = new Set(heroes.map((h) => h.key.replace('npc_dota_hero_', '')));
    const stale = Object.keys(HERO_NAMES_RU).filter((k) => !keys.has(k));
    expect(stale.length, `stale: ${stale.join(', ')}`).toBeLessThanOrEqual(3);
  });

  it('aliases are lower-case and distinct from the full name', () => {
    for (const [k, { ru, aliases }] of Object.entries(HERO_NAMES_RU)) {
      for (const a of aliases) {
        expect(a, k).toBe(a.toLowerCase());
        expect(a, k).not.toBe(ru.toLowerCase());
      }
      expect(new Set(aliases).size, k).toBe(aliases.length);
    }
  });

  it('display name follows the language and falls back to English for an unknown hero', () => {
    expect(heroDisplayName(byName('Shadow Fiend'), 'ru')).toBe('Шадоу Финд');
    expect(heroDisplayName(byName('Shadow Fiend'), 'en')).toBe('Shadow Fiend');
    expect(heroDisplayName({ ...byName('Pudge'), key: 'npc_dota_hero_new_guy', name: 'New Guy' }, 'ru')).toBe('New Guy');
  });
});

describe('search: English, full Russian names and community slang', () => {
  const first = (q: string) => searchHeroes(heroes, q)[0]?.name;
  it.each([
    ['сф', 'Shadow Fiend'],
    ['вд', 'Witch Doctor'],
    ['фурион', "Nature's Prophet"],
    ['бара', 'Spirit Breaker'],
    ['дровка', 'Drow Ranger'],
    ['пудж', 'Pudge'],
    ['Пак', 'Puck'],
    ['квопа', 'Queen of Pain'],
    ['ам', 'Anti-Mage'],
    ['рингмастер', 'Ringmaster'],
    ['ёж', 'Bristleback'],
    ['еж', 'Bristleback'],
    ['шадоу финд', 'Shadow Fiend'],
    ['jug', 'Juggernaut'],
    ['anti', 'Anti-Mage'],
    ['natures', "Nature's Prophet"],
  ])('%s → %s', (q, name) => {
    expect(first(q)).toBe(name);
  });
});

describe('ruPlural', () => {
  it.each([[1, 'пик'], [2, 'пика'], [4, 'пика'], [5, 'пиков'], [11, 'пиков'], [12, 'пиков'], [21, 'пик'], [22, 'пика'], [15, 'пиков'], [111, 'пиков']])('%i %s', (n, form) => {
    expect(ruPlural(n, 'пик', 'пика', 'пиков')).toBe(form);
  });
});

describe('detectLang', () => {
  it('URL beats the stored choice beats the browser language', () => {
    expect(detectLang('?lang=ru', 'en', ['en-US'])).toBe('ru');
    expect(detectLang('?lang=en', 'ru', ['ru-RU'])).toBe('en');
    expect(detectLang('', 'ru', ['en-US'])).toBe('ru');
    expect(detectLang('', null, ['ru-RU', 'en'])).toBe('ru');
    expect(detectLang('', null, ['uk-UA'])).toBe('ru');
    expect(detectLang('', null, ['de-DE', 'en'])).toBe('en');
    expect(detectLang('?lang=fr', null, [])).toBe('en');
  });

  it('a shared Russian link keeps lang=ru', () => {
    const search = buildDraftSearch('', { enemies: [13], position: 'all', rank: 'ALL', lang: 'ru' });
    expect(search).toBe('?enemy=13&lang=ru');
    expect(detectLang(search, null, ['en-US'])).toBe('ru');
    expect(parseDraftUrl(search).enemies).toEqual([13]);
  });
});

describe('explainCandidate (RU)', () => {
  const ruI18n: I18n = {
    lang: 'ru', setLang: () => {},
    t: (k, v) => STRINGS.ru[k].replace(/\{(\w+)\}/g, (_, x: string) => String(v?.[x])),
    heroName: (h) => heroDisplayName(h, 'ru'), heroAltName: () => null, role: (r) => r,
    plural: (n) => String(n), number: (n) => String(n),
  };
  it('names enemies in Russian and keeps the numbers', () => {
    const puck = byName('Puck');
    const tide = byName('Tidehunter');
    const m = (enemyId: number, delta: number) => ({ enemyId, delta, usable: true, games: 5000, winsForCandidate: 0, winrate: 50, expectedWinrate: 50, rawDelta: delta });
    const c = { matchups: [m(puck.id, 3.2), m(tide.id, -2.5)], avgGames: 5000, positionScore: 8 } as unknown as CandidateScore;
    const lines = explainCandidate(c, 'Мид', ruI18n, new Map(heroes.map((h) => [h.id, h])));
    expect(lines).toEqual([
      'Статистически выгоден против: Пак.',
      'Слабое место: Тайдхантер (−2.5).',
      'Выигрывает матчап у 1 из 2 выбранных врагов.',
      'Большая выборка — высокая уверенность.',
      'Хорошо подходит на роль: Мид.',
    ]);
  });
});
