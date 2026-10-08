import { useState } from 'react';
import { APP_CONFIG } from '../config';
import type { ItemCatalogue } from '../types';
import type { BuildEngine, BuildPosition } from '../scoring/buildEngine';
import { DISPLAY_PHASES } from '../scoring/buildAssembly.mjs';

const POSITIONS: BuildPosition[] = ['1', '2', '3', '4', '5'];
const POSITION_LABELS: Record<BuildPosition, string> = {
  '1': 'Carry',
  '2': 'Mid',
  '3': 'Offlane',
  '4': 'Support 4',
  '5': 'Support 5',
};

export function RecommendedBuildPanel({
  heroId,
  initialPosition,
  buildEngine,
  items,
}: {
  heroId: number;
  initialPosition: BuildPosition;
  buildEngine: BuildEngine;
  items: ItemCatalogue;
}) {
  const [position, setPosition] = useState<BuildPosition>(initialPosition);
  const build = buildEngine.getBuild(heroId, position);
  const generalItems = build.items.filter((item) => item.phase === 'general');

  return (
    <section className="mt-7 border-t border-line pt-5" aria-labelledby="recommended-build-title">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="recommended-build-title" className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted">
            Recommended Build
          </h3>
          <p className="mt-1 text-xs text-dim">{POSITION_LABELS[position]}</p>
        </div>
        <div className="seg !w-fit" role="group" aria-label="Build position">
          {POSITIONS.map((candidatePosition) => (
            <button
              key={candidatePosition}
              type="button"
              aria-pressed={position === candidatePosition}
              title={`Position ${candidatePosition} — ${POSITION_LABELS[candidatePosition]}`}
              onClick={() => setPosition(candidatePosition)}
              className={`seg-btn !px-2.5 !py-1.5 !text-[10px] ${position === candidatePosition ? 'is-active' : ''}`}
            >
              {candidatePosition}
            </button>
          ))}
        </div>
      </div>

      {build.status !== 'ready' ? (
        <div className="panel-2 px-4 py-4 text-sm text-muted" role="status">
          {build.status === 'ineligible-position'
            ? 'There is not enough position data to show recommendations for this hero and position.'
            : 'No build data is available for this hero and position.'}
        </div>
      ) : (
        <>
          <div className="space-y-4">
            {DISPLAY_PHASES.map((phase) => {
              const phaseItems = build.items.filter((item) => item.phase === phase);
              return (
                <section key={phase} aria-labelledby={`build-phase-${phase}`}>
                  <div className="mb-2 flex items-center gap-2">
                    <h4 id={`build-phase-${phase}`} className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-accent-2">
                      {phase}
                    </h4>
                    <span className="h-px flex-1 bg-line" />
                  </div>
                  {phaseItems.length === 0 ? (
                    <p className="px-1 py-1 text-xs text-dim">No recommendations in this phase.</p>
                  ) : (
                    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {phaseItems.map((item) => (
                        <BuildItem key={item.itemId} itemId={item.itemId} rank={item.rank} catalogue={items} />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>

          {generalItems.length > 0 && (
            <details className="panel-2 mt-4">
              <summary className="cursor-pointer px-3.5 py-3 text-[10px] font-extrabold uppercase tracking-[0.16em] text-accent-2">
                <span className="inline-flex items-center gap-2">
                  General
                  <span className="text-dim">({generalItems.length})</span>
                </span>
              </summary>
              <ul className="grid grid-cols-1 gap-2 px-3.5 pb-3.5 sm:grid-cols-2">
                {generalItems.map((item) => (
                  <BuildItem key={item.itemId} itemId={item.itemId} rank={item.rank} catalogue={items} />
                ))}
              </ul>
              <p className="px-3.5 pb-3.5 text-[10px] leading-relaxed text-dim">
                General items have no mappable Valve phase; this is not a source phase.
              </p>
            </details>
          )}
        </>
      )}

      <div className="mt-4 space-y-1 text-[10px] leading-relaxed text-dim">
        <p>Recommendations are based on historical Hero + Position item purchase patterns.</p>
        <p>Build phases are categorical source labels; item order within a phase is a presentation ranking, not exact purchase order.</p>
        <p>Build confidence is not calibrated.</p>
      </div>
    </section>
  );
}

function BuildItem({
  itemId,
  rank,
  catalogue,
}: {
  itemId: number;
  rank: number;
  catalogue: ItemCatalogue;
}) {
  const item = catalogue[itemId];
  const image = item?.image
    ? `${APP_CONFIG.cdnBase}/apps/dota2/images/dota_react/items/${item.image}`
    : null;

  return (
    <li className="panel-2 flex min-w-0 items-center gap-3 px-3 py-2.5">
      {image && (
        <img
          src={image}
          alt=""
          loading="lazy"
          className="h-9 w-12 shrink-0 rounded object-contain"
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      )}
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink" title={item?.name ?? `Item ${itemId}`}>
        {item?.name ?? `Item ${itemId}`}
      </span>
      <span className="shrink-0 text-[10px] text-dim" title="ItemPrior presentation rank">
        Prior #{rank}
      </span>
    </li>
  );
}
