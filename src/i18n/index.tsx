import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CandidateScore, Hero } from '../types';
import type { Freshness } from '../data/dataset';
import { HERO_NAMES_RU } from './heroNamesRu';
import { STRINGS, type StringKey } from './strings';

export type Lang = 'en' | 'ru';
export const LANGS: Lang[] = ['en', 'ru'];
const STORAGE_KEY = 'dda.lang';

/** Languages whose speakers overwhelmingly use the Russian Dota community. */
const RU_LOCALES = /^(ru|uk|be|kk|ky|uz|tg|hy|az|ka)\b/i;

/** URL `?lang=` → stored choice → browser language → English. */
export function detectLang(search: string, stored: string | null, browserLangs: readonly string[]): Lang {
  const fromUrl = new URLSearchParams(search).get('lang');
  if (fromUrl === 'ru' || fromUrl === 'en') return fromUrl;
  if (stored === 'ru' || stored === 'en') return stored;
  return browserLangs.some((l) => RU_LOCALES.test(l)) ? 'ru' : 'en';
}

function initialLang(): Lang {
  try {
    let stored: string | null = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* storage blocked */ }
    return detectLang(window.location.search, stored, navigator.languages ?? [navigator.language]);
  } catch {
    return 'en';
  }
}

/** Russian plural form: 1 пик · 2 пика · 5 пиков (11–14 → many). */
export function ruPlural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export function heroKey(h: Hero): string {
  return h.key.replace('npc_dota_hero_', '');
}

/** Display name in the given language (RU falls back to English for an unknown hero). */
export function heroDisplayName(h: Hero, lang: Lang): string {
  return lang === 'ru' ? HERO_NAMES_RU[heroKey(h)]?.ru ?? h.name : h.name;
}

export interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: StringKey, vars?: Record<string, string | number>) => string;
  heroName: (h: Hero) => string;
  /** The other language's name, shown small next to the main one (RU: the English game name). */
  heroAltName: (h: Hero) => string | null;
  role: (role: string) => string;
  plural: (n: number, key: PluralKey) => string;
  number: (n: number) => string;
}

function makeI18n(lang: Lang, setLang: (l: Lang) => void): I18n {
  const dict = STRINGS[lang];
  const t: I18n['t'] = (key, vars) => format(dict[key] ?? STRINGS.en[key] ?? key, vars);
  return {
    lang,
    setLang,
    t,
    heroName: (h) => heroDisplayName(h, lang),
    heroAltName: (h) => (lang === 'ru' && HERO_NAMES_RU[heroKey(h)] ? h.name : null),
    role: (r) => (lang === 'ru' ? ROLES_RU[r] ?? r : r),
    plural: (n, key) => {
      if (lang === 'en') return n === 1 ? EN_FORMS[key][0] : EN_FORMS[key][1];
      const [one, few, many] = RU_FORMS[key];
      return ruPlural(n, one, few, many);
    },
    number: (n) => n.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US'),
  };
}

type PluralKey = 'pick' | 'game' | 'match' | 'hour' | 'day';

const EN_FORMS: Record<PluralKey, [string, string]> = {
  pick: ['pick', 'picks'],
  game: ['game', 'games'],
  match: ['match', 'matches'],
  hour: ['hour', 'hours'],
  day: ['day', 'days'],
};

const RU_FORMS: Record<PluralKey, [string, string, string]> = {
  pick: ['пик', 'пика', 'пиков'],
  game: ['игра', 'игры', 'игр'],
  match: ['матч', 'матча', 'матчей'],
  hour: ['час', 'часа', 'часов'],
  day: ['день', 'дня', 'дней'],
};

/** OpenDota role tags. */
const ROLES_RU: Record<string, string> = {
  Carry: 'Керри',
  Support: 'Саппорт',
  Nuker: 'Нюкер',
  Disabler: 'Контроль',
  Durable: 'Танк',
  Escape: 'Мобильность',
  Initiator: 'Инициатор',
  Pusher: 'Пушер',
  Jungler: 'Лесник',
};

const I18nContext = createContext<I18n>(makeI18n('en', () => {}));

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(() => initial ?? initialLang());
  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* not remembered */ }
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo(() => makeI18n(lang, setLang), [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}

/**
 * The analysis text under a recommendation, built in the UI language from the
 * same numbers the engine scored with (the engine's own `explanation` is the
 * English reference and is used by tests/tools).
 */
export function explainCandidate(c: CandidateScore, laneName: string, i18n: I18n, heroById: Map<number, Hero>): string[] {
  const { t } = i18n;
  const name = (id: number) => {
    const h = heroById.get(id);
    return h ? i18n.heroName(h) : `#${id}`;
  };
  const usable = c.matchups.filter((m) => m.usable).sort((a, b) => b.delta - a.delta);
  const best = usable.slice(0, 2).filter((m) => m.delta > 0.5);
  const worst = [...usable].reverse().find((m) => m.delta < -2);
  const positive = usable.filter((m) => m.delta > 0).length;
  const out: string[] = [];
  if (best.length > 0) out.push(t('explain.favorable', { names: best.map((m) => name(m.enemyId)).join(t('explain.and')) }));
  if (worst) out.push(t('explain.weakSpot', { name: name(worst.enemyId), delta: fmtSigned(worst.delta) }));
  if (usable.length > 1) {
    out.push(positive === usable.length
      ? t('explain.positiveAll', { n: usable.length })
      : t('explain.positiveSome', { k: positive, n: usable.length }));
  }
  // Synergy with your team. With no enemies picked it leads the explanation.
  const syn = (c.synergy ?? []).filter((x) => x.usable).sort((a, b) => b.delta - a.delta);
  const synLines: string[] = [];
  const synBest = syn.slice(0, 2).filter((x) => x.delta > 0.5);
  const synWorst = [...syn].reverse().find((x) => x.delta < -2);
  if (syn.length > 1 && syn.every((x) => x.delta > 0)) synLines.push(t('explain.synergyAll', { n: syn.length }));
  else if (synBest.length > 0) synLines.push(t('explain.synergyGood', { names: synBest.map((x) => name(x.allyId)).join(t('explain.and')) }));
  if (synWorst) synLines.push(t('explain.synergyBad', { name: name(synWorst.allyId), delta: fmtSigned(synWorst.delta) }));
  if (usable.length === 0) out.unshift(...synLines);
  else out.splice(Math.min(out.length, 1), 0, ...synLines);
  if (c.avgGames >= 800) out.push(t('explain.sampleLarge'));
  else if (c.avgGames >= 200) out.push(t('explain.sampleSolid'));
  else out.push(t('explain.sampleLimited'));
  if (c.positionScore >= 7) out.push(t('explain.roleStrong', { lane: laneName }));
  else if (c.positionScore >= 5) out.push(t('explain.roleOk', { lane: laneName }));
  else out.push(t('explain.roleOff', { lane: laneName }));
  return out;
}

/** Best / worst enemies by name in the UI language (the engine's lists are English names). */
export function bestWorstAgainst(c: CandidateScore, i18n: I18n, heroById: Map<number, Hero>) {
  const usable = c.matchups.filter((m) => m.usable).sort((a, b) => b.delta - a.delta);
  const name = (id: number) => {
    const h = heroById.get(id);
    return h ? i18n.heroName(h) : `#${id}`;
  };
  const syn = (c.synergy ?? []).filter((x) => x.usable).sort((a, b) => b.delta - a.delta);
  return {
    best: usable.filter((m) => m.delta > 0.5).slice(0, 2).map((m) => name(m.enemyId)),
    worst: usable.filter((m) => m.delta < -2).slice(-1).map((m) => name(m.enemyId)),
    goodWith: syn.filter((x) => x.delta > 0.5).slice(0, 2).map((x) => name(x.allyId)),
  };
}

export function freshnessText(f: Freshness, i18n: I18n): string {
  const { t, plural } = i18n;
  switch (f.kind) {
    case 'unknown': return t('fresh.unknown');
    case 'now': return t('fresh.now');
    case 'yesterday': return t('fresh.yesterday');
    case 'outdated': return t('fresh.outdated');
    case 'hours': return t('fresh.ago', { n: f.n, unit: plural(f.n, 'hour') });
    case 'days': return t('fresh.ago', { n: f.n, unit: plural(f.n, 'day') });
  }
}

function fmtSigned(d: number): string {
  const sign = d > 0 ? '+' : d < 0 ? '−' : '';
  return `${sign}${Math.abs(d).toFixed(1)}`;
}
