import type { Hero } from '../types';
import type { WinChance as WinChanceData } from '../scoring/winChance';
import { WIN_SLOPE } from '../scoring/winChance';
import { useI18n } from '../i18n';
import { scoreTone } from './CandidateCard';

/** Edge points → approximate points of win chance (slope of the logistic at 50%). */
const toChance = (edge: number) => edge * WIN_SLOPE * 25;
const signed = (v: number) => `${v > 0.05 ? '+' : v < -0.05 ? '−' : ''}${Math.abs(v).toFixed(1)}%`;

/** Full 5 v 5 draft: "Your team 57% — 43% Enemy" with what drives it. */
export function WinChance({ data, heroById }: { data: WinChanceData; heroById: Map<number, Hero> }) {
  const i18n = useI18n();
  const { t } = i18n;
  const you = Math.round(data.chance * 100);
  const name = (id: number) => { const h = heroById.get(id); return h ? i18n.heroName(h) : `#${id}`; };
  const parts: [string, number][] = [
    [t('win.heroes'), toChance(data.heroes)],
    [t('win.counters'), toChance(data.counters)],
    [t('win.synergy'), toChance(data.synergy)],
  ];
  return (
    <section className="panel fade-up mb-5 p-4" aria-labelledby="win-title">
      <h2 id="win-title" className="label">{t('win.title')}</h2>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div>
          <div className="text-[11px] leading-[14px] text-ally">{t('win.you')}</div>
          <div className="tnum font-display text-[32px] font-bold leading-[38px] text-ally">{you}%</div>
        </div>
        <div className="text-right">
          <div className="text-[11px] leading-[14px] text-neg">{t('win.enemy')}</div>
          <div className="tnum font-display text-[32px] font-bold leading-[38px] text-neg">{100 - you}%</div>
        </div>
      </div>
      <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`${you}% — ${100 - you}%`}>
        <i className="block h-full bg-ally transition-[width] duration-500" style={{ width: `${you}%` }} />
        <i className="block h-full flex-1 bg-neg" />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {parts.map(([label, v]) => (
          <div key={label} className="panel-2 px-2 py-2 text-center">
            <div className="text-[11px] leading-[14px] text-muted">{label}</div>
            <div className={`tnum mt-0.5 text-[15px] font-semibold ${scoreTone(v / 100)}`}>{signed(v)}</div>
          </div>
        ))}
      </div>
      {(data.bestCounter || data.worstCounter) && (
        <div className="mt-3 space-y-0.5 text-[13px] leading-[18px] text-muted">
          {data.bestCounter && <p>{t('win.best', { a: name(data.bestCounter.a), b: name(data.bestCounter.b) })} <span className="tnum font-semibold text-pos">{signed(toChance(data.bestCounter.delta))}</span></p>}
          {data.worstCounter && <p>{t('win.worst', { a: name(data.worstCounter.a), b: name(data.worstCounter.b) })} <span className="tnum font-semibold text-neg">{signed(toChance(data.worstCounter.delta))}</span></p>}
        </div>
      )}
      <p className="mt-3 text-[11px] leading-[14px] text-muted">{t('win.note')}</p>
    </section>
  );
}
