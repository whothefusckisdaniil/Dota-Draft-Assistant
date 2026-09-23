import type { Hero } from '../types';
import { APP_CONFIG, POSITIONS, type PositionFilter } from '../config';
import { HeroPortrait } from './HeroPortrait';

/** Empty slot focuses the hero picker (§7): slots are part of the draft flow. */
function focusSearch() {
  document.getElementById('hero-search')?.focus();
}

export function EnemySlots({ enemies, heroById, onRemove, onClear }: {
  enemies: number[];
  heroById: Map<number, Hero>;
  onRemove: (id: number) => void;
  onClear: () => void;
}) {
  const slots = Array.from({ length: APP_CONFIG.ui.maxEnemies }, (_, i) => enemies[i]);
  return (
    <div className="min-w-0">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted">Enemy draft</h2>
          <span className="text-xs font-semibold tabular-nums text-dim">{enemies.length} / {APP_CONFIG.ui.maxEnemies}</span>
        </div>
        {enemies.length > 0 && (
          <button type="button" onClick={onClear} className="btn btn-ghost btn-sm">Clear</button>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-5 sm:gap-3">
        {slots.map((id, i) => {
          const h = id !== undefined ? heroById.get(id) : undefined;
          if (!h) {
            return (
              <button key={`e${i}`} type="button" onClick={focusSearch} className="slot slot-empty" aria-label="Add hero">
                <span aria-hidden="true" className="text-2xl font-light leading-none">+</span>
                <span className="text-[10px] font-bold uppercase tracking-widest">Add hero</span>
              </button>
            );
          }
          return (
            <div key={id} className="slot fade-up">
              <HeroPortrait hero={h} fill variant="large" />
              <div className="slot-overlay">
                <div className="truncate text-[13px] font-bold leading-tight text-ink sm:text-sm">{h.name}</div>
                <div className="truncate text-[10px] text-muted">{h.roles.slice(0, 2).join(' · ')}</div>
              </div>
              <button
                type="button"
                onClick={() => onRemove(id)}
                aria-label={`Remove ${h.name}`}
                className="slot-x"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Compact display labels for mobile fit (§10/§16); titles keep full labels. */
const SHORT_LABEL: Record<string, string> = { '4': 'Pos 4', '5': 'Pos 5' };

export function PositionTabs({ value, onChange }: { value: PositionFilter; onChange: (p: PositionFilter) => void }) {
  return (
    <div className="min-w-0">
      <div className="mb-2.5 flex items-center gap-3">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted">Role</h2>
        <span className="h-px flex-1 bg-line" />
      </div>
      <div className="seg" role="tablist" aria-label="Select position">
        {POSITIONS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={value === p.id}
            title={p.label}
            onClick={() => onChange(p.id)}
            className={`seg-btn ${value === p.id ? 'is-active' : ''}`}
          >
            {SHORT_LABEL[p.id] ?? p.short}
          </button>
        ))}
      </div>
    </div>
  );
}
