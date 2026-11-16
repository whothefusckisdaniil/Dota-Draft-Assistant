import { useEffect, useRef, useState } from 'react';
import type { Hero } from '../types';
import { HeroPool } from './HeroPool';
import { TargetSwitch, type Target } from './Selectors';
import { useI18n } from '../i18n';

/** Bottom sheet hero picker (85% height). It stays open after a pick, so five
 *  enemies take five taps; it closes when the current list fills up, on
 *  "Done", on the scrim, on Escape or on a swipe down. */
export function PickerSheet({ heroes, taken, target, setTarget, counts, limits, onPick, onClose }: {
  heroes: Hero[];
  taken: Set<number>;
  target: Target;
  setTarget: (t: Target) => void;
  counts: Record<Target, number>;
  limits: Record<Target, number>;
  onPick: (h: Hero) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  const prevCounts = useRef(counts);

  // Close once the list being filled is full (the 5th enemy was just picked).
  useEffect(() => {
    const n = counts[target];
    if (n > prevCounts.current[target] && n >= limits[target]) onClose();
    prevCounts.current = counts;
  }, [counts, target, limits, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const onPointerDown = (e: React.PointerEvent) => {
    start.current = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (start.current !== null) setDrag(Math.max(0, e.clientY - start.current));
  };
  const onPointerUp = () => {
    if (drag > 90) onClose();
    start.current = null;
    setDrag(0);
  };

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('picker.title')}
        style={{ height: '85dvh', transform: drag ? `translateY(${drag}px)` : undefined, transition: drag ? 'none' : 'transform 180ms ease-out' }}
      >
        <div
          className="flex-none cursor-grab touch-none px-4 pb-3"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="sheet-handle" aria-hidden="true" />
          <div className="mt-2 flex items-center justify-between gap-3">
            <h2 className="font-display text-[16px] font-bold leading-5">
              {t('picker.title')}
              <span className="tnum ml-2 text-accent">{counts[target]}/{limits[target]}</span>
            </h2>
            <button type="button" onClick={onClose} onPointerDown={(e) => e.stopPropagation()} className="btn btn-accent btn-sm">{t('picker.done')}</button>
          </div>
          <div className="mt-3" onPointerDown={(e) => e.stopPropagation()}>
            <TargetSwitch value={target} onChange={setTarget} counts={counts} limits={limits} />
          </div>
        </div>
        <div className="min-h-0 flex-1 px-4">
          <HeroPool heroes={heroes} taken={taken} onPick={onPick} autoFocus />
        </div>
      </div>
    </>
  );
}
