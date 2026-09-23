import type { Hero } from '../types';
import { APP_CONFIG, POSITIONS, type PositionFilter } from '../config';
import { HeroPortrait } from './HeroPortrait';

export function EnemySlots({ enemies, heroById, onRemove, onClear }: {
  enemies: number[];
  heroById: Map<number, Hero>;
  onRemove: (id: number) => void;
  onClear: () => void;
}) {
  const slots = Array.from({ length: APP_CONFIG.ui.maxEnemies }, (_, i) => enemies[i]);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[#8b949e]">Enemy team · {enemies.length}/{APP_CONFIG.ui.maxEnemies}</h2>
        {enemies.length > 0 && (
          <button type="button" onClick={onClear} className="text-xs text-[#8b949e] hover:text-[#e6edf3]">Clear</button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {slots.map((id, i) => {
          const h = id !== undefined ? heroById.get(id) : undefined;
          if (!h) {
            return (
              <div key={i} className="flex min-h-[64px] items-center justify-center rounded-lg border border-dashed border-[#30363d] text-2xl text-[#484f58]">
                +
              </div>
            );
          }
          return (
            <div key={id} className="fade-up flex items-center gap-2 rounded-lg border border-[#30363d] bg-[#161b22] p-2">
              <HeroPortrait hero={h} size={36} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-[#e6edf3]">{h.name}</div>
                <div className="truncate text-[11px] text-[#8b949e]">{h.roles.slice(0, 2).join(' · ')}</div>
              </div>
              <button
                type="button"
                onClick={() => onRemove(id)}
                aria-label={`Remove ${h.name}`}
                className="rounded px-1.5 py-0.5 text-sm text-[#8b949e] hover:bg-[#30363d] hover:text-[#e6edf3]"
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

export function PositionTabs({ value, onChange }: { value: PositionFilter; onChange: (p: PositionFilter) => void }) {
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-[#8b949e]">Position</h2>
      <div className="flex flex-wrap gap-2">
        {POSITIONS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.id)}
            title={p.label}
            className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
              value === p.id
                ? 'border-[#58a6ff] bg-[#1f6feb]/20 text-[#e6edf3]'
                : 'border-[#30363d] bg-[#161b22] text-[#8b949e] hover:text-[#e6edf3]'
            }`}
          >
            {p.short}
          </button>
        ))}
      </div>
    </div>
  );
}
