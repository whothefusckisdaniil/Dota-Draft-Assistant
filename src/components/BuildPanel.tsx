import { useEffect, useMemo, useState } from 'react';
import type { Hero } from '../types';
import { loadBuildIndex, loadHeroBuild, type Build, type BuildIndex, type HeroBuilds } from '../data/dataset';
import { useI18n } from '../i18n';
import type { StringKey } from '../i18n/strings';
import { HeroPortrait } from './HeroPortrait';
import { DiamondLoader } from './Brand';
import { suggestItems, type ItemSuggestion } from '../scoring/itemRules';
import { idealBuild } from '../scoring/idealBuild';

const CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react';
const itemImg = (key: string) => `${CDN}/items/${key}.png`;
const abilityImg = (key: string) => `${CDN}/abilities/${key}.png`;
const pct = (x: number) => Math.round(x * 100);

/** Core = bought in at least this share of games (after the laning items). */
const CORE_PCT = 0.35;
const LANING_MINUTE = 12;

type State = { index: BuildIndex | null; builds: HeroBuilds | null; status: 'loading' | 'ready' | 'none' | 'error' };

/** Statistical build of your hero for a position and rank (MVP: no enemy adaptation). */
export function BuildPanel({ hero, rank, preferLane, onClose, enemies = [] }: {
  hero: Hero;
  /** Enemy heroes: drive the rule-based "for this draft" suggestions. */
  enemies?: Hero[];
  rank: string;
  /** '1'..'5' to prefer that position (role tab, or the lane it was recommended for). */
  preferLane: string | null;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [state, setState] = useState<State>({ index: null, builds: null, status: 'loading' });
  const [lane, setLane] = useState<string | null>(null);
  /** 'mine' = the selected rank (default), 'pro' = Divine–Immortal games. */
  const [source, setSource] = useState<'mine' | 'pro'>('mine');

  useEffect(() => {
    let alive = true;
    setState({ index: null, builds: null, status: 'loading' });
    Promise.all([loadBuildIndex(), loadHeroBuild(hero.id)])
      .then(([index, builds]) => alive && setState({ index, builds, status: index && builds ? 'ready' : 'none' }))
      .catch((e) => {
        console.error(e);
        if (alive) setState({ index: null, builds: null, status: 'error' });
      });
    return () => {
      alive = false;
    };
  }, [hero.id]);

  // positions with a build, most played first
  const lanes = useMemo(() => {
    const p = state.builds?.positions ?? {};
    return Object.keys(p).sort((a, b) => (p[b].ALL?.m ?? 0) - (p[a].ALL?.m ?? 0));
  }, [state.builds]);
  useEffect(() => {
    if (!lanes.length) return;
    setLane(preferLane && lanes.includes(preferLane) ? preferLane : lanes[0]);
  }, [lanes, preferLane]);

  const laneName = (l: string) => t(`lane.${l}` as StringKey);
  const rankName = (r: string) => (r === 'ALL' ? t('rank.all') : t(`rank.${r}` as StringKey));
  const byRank = lane ? state.builds?.positions[lane] : undefined;
  const PRO = 'DIVINE_IMMORTAL';
  const wantRank = source === 'pro' ? PRO : rank;
  const exact = byRank?.[wantRank];
  const build: Build | undefined = exact && !exact.low ? exact : byRank?.ALL;
  const fellBack = wantRank !== 'ALL' && build === byRank?.ALL;
  const shownRank = fellBack ? 'ALL' : wantRank;
  const ix = state.index;

  const item = (id: number) => ix?.items[id];
  const suggestions = useMemo<ItemSuggestion[]>(
    () => (lane && build
      ? suggestItems({
        hero, position: Number(lane) as 1 | 2 | 3 | 4 | 5, enemies, build,
        itemKeyOf: (id) => ix?.items[id]?.[0],
        available: ix ? new Set(Object.values(ix.items).map((v) => v[0])) : undefined,
      })
      : []),
    [hero, lane, enemies, build, ix],
  );
  const ability = (id: number) => ix?.abilities[id];
  const abilityName = (id: number) => {
    const a = ability(id);
    return a ? (i18n.lang === 'ru' ? a[2] : a[1]) : `#${id}`;
  };

  return (
    <section id="build-panel" className="fade-up mb-6 min-w-0 rounded-[14px] border border-line bg-surface p-3 sm:p-5" aria-labelledby="build-title">
      <div className="flex items-start gap-3">
        <span className="h-14 w-14 shrink-0 overflow-hidden rounded-xl">
          <HeroPortrait hero={hero} fill variant="large" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="label text-accent">{t('build.title')}</div>
          <h2 id="build-title" className="truncate font-display text-[16px] font-bold leading-5 text-ink sm:text-[20px] sm:leading-6">{i18n.heroName(hero)}</h2>
          {lane && build && (
            <p className="mt-0.5 truncate text-[13px] leading-4 text-muted">
              {laneName(lane)} · {rankName(shownRank)} · {t('build.matches', { n: i18n.number(build.m) })}
            </p>
          )}
        </div>
        <button type="button" onClick={onClose} className="icon-btn -mr-2 -mt-2 flex-none" aria-label={t('build.close')} title={t('build.close')}>
          <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true"><path d="M4 4l10 10M14 4 4 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        </button>
      </div>

      {state.status === 'loading' && <div className="mt-5"><DiamondLoader label={t('build.loading')} /></div>}
      {state.status === 'error' && <p className="notice mt-4">{t('build.unavailable')}</p>}
      {state.status === 'none' && <p className="notice mt-4">{t('build.none')}</p>}

      {state.status === 'ready' && lane && build && (
        <>
          {lanes.length > 1 && (
            <div className="seg seg-sm mt-4" role="tablist" aria-label={t('role.select')}>
              {lanes.map((l) => (
                <button key={l} type="button" role="tab" aria-selected={lane === l} onClick={() => setLane(l)} className={`seg-btn ${lane === l ? 'is-active' : ''}`}>
                  {l} · {t(`pos.sub.${l}` as StringKey)}
                </button>
              ))}
            </div>
          )}
          {preferLane && !lanes.includes(preferLane) && <p className="notice mt-3">{t('build.noPos', { lane: laneName(preferLane) })}</p>}
          {rank !== PRO && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[11px] leading-[14px] text-muted">{t('build.sourceTitle')}</span>
              <div className="seg seg-sm" role="radiogroup" aria-label={t('build.sourceTitle')}>
                {(['mine', 'pro'] as const).map((src) => (
                  <button key={src} type="button" role="radio" aria-checked={source === src} onClick={() => setSource(src)} className={`seg-btn ${source === src ? 'is-active' : ''}`}>
                    {src === 'mine' ? `${t('build.sourceMine')} · ${rankName(rank)}` : t('build.sourcePro')}
                  </button>
                ))}
              </div>
            </div>
          )}
          {fellBack && <p className="notice mt-3">{t('build.lowData', { rank: rankName(wantRank) })}</p>}

          <IdealRow build={build} itemOf={item} suggestions={suggestions} />
          <Adaptation suggestions={suggestions} enemies={enemies} />
          <h3 className="mt-6 border-t border-line pt-4 font-display text-[13px] font-bold uppercase tracking-[0.06em] text-muted">{t('build.details')}</h3>
          <BuildBody build={build} itemOf={item} abilityOf={ability} abilityName={abilityName} highlight={new Set(suggestions.map((x) => x.key))} />
          <p className="mt-5 text-[11px] leading-[14px] text-muted">{t('build.note')}</p>
        </>
      )}
    </section>
  );
}

function ItemTile({ id, meta, top, bottom, qty, hot, tag, tagHot }: {
  id: number;
  meta: [string, string, string[]?] | undefined;
  top?: string;
  bottom?: string;
  qty?: number;
  /** Also suggested for this enemy draft. */
  hot?: boolean;
  /** Small label under the tile (slot kind). */
  tag?: string;
  tagHot?: boolean;
}) {
  const name = meta?.[1] ?? `#${id}`;
  return (
    <li className="flex w-[72px] flex-none flex-col items-center text-center" title={[name, top, bottom].filter(Boolean).join(' · ')}>
      <span className="relative h-[44px] w-[60px] overflow-hidden rounded-md bg-surface-2">
        {meta && <img src={itemImg(meta[0])} alt="" width={88} height={64} loading="lazy" decoding="async" className="h-full w-full object-cover" />}
        {qty && qty > 1 ? <span className="tnum absolute bottom-0 right-0 rounded-tl-md bg-bg/85 px-1 text-[11px] font-semibold text-ink">×{qty}</span> : null}
        {/* drawn inside the tile: an outer ring is clipped by the scrolling row */}
        {hot && <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-md border-2 border-accent" />}
      </span>
      <span className="mt-1 w-full truncate text-[11px] leading-[14px] text-ink">{name}</span>
      {top && <span className="tnum text-[11px] font-semibold leading-[14px] text-ink">{top}</span>}
      {bottom && <span className="tnum text-[11px] leading-[14px] text-muted">{bottom}</span>}
      {tag && <span className={`mt-0.5 w-full truncate text-[11px] font-semibold leading-[14px] ${tagHot ? 'text-accent' : 'text-muted'}`}>{tag}</span>}
    </li>
  );
}

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <h3 className="label mb-2">{title}</h3>
      <ul className="no-scrollbar -mx-3 flex gap-2 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">{children}</ul>
    </div>
  );
}

function BuildBody({ build, itemOf, abilityOf, abilityName, highlight }: {
  build: Build;
  highlight: Set<string>;
  itemOf: (id: number) => [string, string, string[]?] | undefined;
  abilityOf: (id: number) => [string, string, string] | undefined;
  abilityName: (id: number) => string;
}) {
  const { t } = useI18n();
  const laning = build.items.filter((x) => x[2] < LANING_MINUTE);
  // Plain Boots of Speed is the component of every upgrade: shown only when
  // the hero usually keeps them (no upgraded boots in the list).
  const upgraded = build.boots.filter(([id]) => itemOf(id)?.[0] !== 'boots');
  const boots = upgraded.length ? upgraded : build.boots;
  const core = build.items.filter((x) => x[2] >= LANING_MINUTE && x[1] >= CORE_PCT);
  const situational = build.items.filter((x) => x[2] >= LANING_MINUTE && x[1] < CORE_PCT).sort((a, b) => b[1] - a[1]);
  const pctLabel = (x: number) => `${pct(x)}%`;
  const minLabel = (m: number) => t('build.min', { min: m });
  const hot = (id: number) => highlight.has(itemOf(id)?.[0] ?? '');

  return (
    <>
      {build.start.length > 0 && (
        <Row title={t('build.start')}>
          {build.start.map(([id, p, qty]) => <ItemTile key={id} id={id} meta={itemOf(id)} qty={qty} top={pctLabel(p)} />)}
        </Row>
      )}
      {laning.length > 0 && (
        <Row title={t('build.early')}>
          {laning.map(([id, p, m]) => <ItemTile key={id} id={id} meta={itemOf(id)} top={pctLabel(p)} bottom={minLabel(m)} hot={hot(id)} />)}
        </Row>
      )}
      {boots.length > 0 && (
        <Row title={t('build.boots')}>
          {boots.map(([id, p, m]) => <ItemTile key={id} id={id} meta={itemOf(id)} top={pctLabel(p)} bottom={minLabel(m)} hot={hot(id)} />)}
        </Row>
      )}
      {core.length > 0 && (
        <Row title={t('build.core')}>
          {core.map(([id, p, m]) => <ItemTile key={id} id={id} meta={itemOf(id)} top={pctLabel(p)} bottom={minLabel(m)} hot={hot(id)} />)}
        </Row>
      )}
      {situational.length > 0 && (
        <Row title={t('build.situational')}>
          {situational.slice(0, 12).map(([id, p, m]) => <ItemTile key={id} id={id} meta={itemOf(id)} top={pctLabel(p)} bottom={minLabel(m)} hot={hot(id)} />)}
        </Row>
      )}

      {build.skills.length > 0 && (
        <div className="mt-5">
          <h3 className="label mb-2">{t('build.skills')}</h3>
          <ol className="flex flex-wrap items-center gap-x-2 gap-y-2">
            {build.skills.map(([id, level], i) => {
              const a = abilityOf(id);
              return (
                <li key={id} className="flex items-center gap-2">
                  {i > 0 && <span aria-hidden="true" className="text-muted">→</span>}
                  <span className="h-9 w-9 shrink-0 overflow-hidden rounded-md bg-surface-2">
                    {a && <img src={abilityImg(a[0])} alt="" width={64} height={64} loading="lazy" decoding="async" className="h-full w-full" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block max-w-[140px] truncate text-[13px] font-semibold leading-4 text-ink">{abilityName(id)}</span>
                    <span className="block text-[11px] leading-[14px] text-muted">{t('build.maxFirst', { level })}</span>
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="mt-2 text-[11px] leading-[14px] text-muted">{t('build.ult')}</p>
        </div>
      )}

      {build.talents.length > 0 && (
        <div className="mt-5">
          <h3 className="label mb-2">{t('build.talents')}</h3>
          <div className="grid gap-1.5">
            {build.talents.map(([level, a, b]) => (
              <div key={level} className="grid grid-cols-[minmax(0,1fr)_36px_minmax(0,1fr)] items-stretch gap-1.5">
                {[a, b].map(([id, p], side) => (
                  <div
                    key={id}
                    className={`flex min-w-0 flex-col justify-center rounded-lg border px-2 py-1.5 text-[12px] leading-4 ${side === 0 ? 'col-start-1 text-right' : 'col-start-3'} ${p >= 0.5 ? 'border-accent/60 bg-accent/10 text-ink' : 'border-line text-muted'}`}
                    style={{ gridRow: 1 }}
                  >
                    <span className="line-clamp-2">{abilityName(id)}</span>
                    <span className="tnum text-[11px] font-semibold">{pct(p)}%</span>
                  </div>
                ))}
                <span className="tnum col-start-2 row-start-1 flex items-center justify-center rounded-lg bg-surface-2 font-display text-[13px] font-bold text-ink">{level}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** Rule-based suggestions for the enemy draft, each with "why". */
function Adaptation({ suggestions, enemies }: { suggestions: ItemSuggestion[]; enemies: Hero[] }) {
  const i18n = useI18n();
  const { t } = i18n;
  const names = (hs: Hero[]) => hs.map((h) => i18n.heroName(h)).join(', ');
  if (!enemies.length) return <p className="mt-4 text-[13px] leading-[18px] text-muted">{t('adapt.pickEnemies')}</p>;
  return (
    <div className="mt-4 rounded-xl border border-accent/30 bg-accent/5 p-3">
      <h3 className="label text-accent">{t('adapt.title')}</h3>
      {suggestions.length === 0 ? (
        <p className="mt-2 text-[13px] leading-[18px] text-muted">{t('adapt.none')}</p>
      ) : (
        <ul className="stagger mt-2 grid gap-2">
          {suggestions.map((s, i) => {
            const vs = [...new Map(s.reasons.flatMap((r) => r.heroes).map((h) => [h.id, h])).values()];
            return (
              <li key={s.key} className="flex items-start gap-3" style={{ '--i': i } as React.CSSProperties}>
                <span className="h-[44px] w-[60px] shrink-0 overflow-hidden rounded-md bg-surface-2">
                  <img src={itemImg(s.key)} alt="" width={88} height={64} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[15px] font-semibold leading-5 text-ink">{s.name}</span>
                    <span className="badge badge-accent">{t('adapt.vs', { names: names(vs.slice(0, 3)) })}</span>
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-[14px] text-muted">
                    {s.reasons.map((r) => t(`rule.${r.rule}` as StringKey, { n: r.n })).join(' · ')}
                    {' · '}{s.buildPct > 0.01 ? t('adapt.inBuild', { pct: Math.round(s.buildPct * 100) }) : t('adapt.consumable')}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-[11px] leading-[14px] text-muted">{t('adapt.note')}</p>
    </div>
  );
}

/** Boots + 6 slots in buying order (src/scoring/idealBuild.ts). */
function IdealRow({ build, itemOf, suggestions }: {
  build: Build;
  itemOf: (id: number) => [string, string, string[]?] | undefined;
  suggestions: ItemSuggestion[];
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const ib = useMemo(() => idealBuild(build, itemOf, suggestions), [build, itemOf, suggestions]);
  if (!ib.slots.length) return null;
  const vs = (s?: ItemSuggestion) => (s ? t('adapt.vs', { names: [...new Map(s.reasons.flatMap((r) => r.heroes).map((h) => [h.id, h])).values()].slice(0, 2).map((h) => i18n.heroName(h)).join(', ') }) : '');
  return (
    <div className="mt-4">
      <h3 className="label mb-2 text-ink">{t('build.ideal')}</h3>
      {/* wraps instead of scrolling: the whole build must be visible at once */}
      <ol className="flex flex-wrap gap-x-1 gap-y-3">
        {ib.boots && (
          <ItemTile id={ib.boots.id} meta={itemOf(ib.boots.id)} top={`${Math.round(ib.boots.pct * 100)}%`} bottom={t('build.min', { min: ib.boots.minute })} tag={t('build.boots')} />
        )}
        {ib.slots.map((sl, i) => (
          <ItemTile
            key={sl.id}
            id={sl.id}
            meta={itemOf(sl.id)}
            top={`${i + 1}. ${Math.round(sl.pct * 100)}%`}
            bottom={t('build.min', { min: sl.minute })}
            hot={sl.kind === 'draft'}
            tag={sl.kind === 'core' ? t('build.kindCore') : sl.kind === 'draft' ? vs(sl.suggestion) : t('build.kindSituational')}
            tagHot={sl.kind === 'draft'}
          />
        ))}
      </ol>
      {ib.shard && <p className="mt-1 text-[11px] leading-[14px] text-muted">{t('build.shard', { min: ib.shard.minute, pct: Math.round(ib.shard.pct * 100) })}</p>}
      <p className="mt-2 text-[11px] leading-[14px] text-muted">{t('build.idealNote')}</p>
    </div>
  );
}
