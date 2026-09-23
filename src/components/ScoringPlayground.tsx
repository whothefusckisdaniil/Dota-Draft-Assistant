import { useMemo, useState } from 'react';
import { laneLabel, positionScore } from '../scoring/engine';
import type { Lane } from '../scoring/positionsExtra';
import { replay } from '../scoring/replay';
import { PLAY_CFG, PLAY_PRESETS, num } from './playgroundData';
import { PlayCard } from './PlayCard';

export function ScoringPlayground() {
  const [idx, setIdx] = useState(0);
  const [lane, setLane] = useState<Lane>('1');
  const [cells, setCells] = useState(() => PLAY_PRESETS[0].rows);
  const [heroes, setHeroes] = useState(() => PLAY_PRESETS[0].heroes);

  function load(i: number) {
    setIdx(i);
    setCells(JSON.parse(JSON.stringify(PLAY_PRESETS[i].rows)));
    setHeroes(JSON.parse(JSON.stringify(PLAY_PRESETS[i].heroes)));
  }

  function setCell(hid: string, rid: string, f: 'games' | 'wr', v: string) {
    setCells((p) => ({ ...p, [hid]: p[hid].map((r) => (r.id === rid ? { ...r, [f]: num(v, 0) } : r)) }));
  }

  const demo = useMemo(
    () => ({ roles: ['Carry', 'Escape'], name: 'Demo' }) as unknown as import('../types').Hero,
    [],
  );

  const results = useMemo(
    () =>
      heroes.map((h) => {
        const rows = cells[h.id] ?? [];
        const r = replay(rows, h.posScore);
        return { hero: h, ...r, ok: r.usable >= rows.length };
      }),
    [heroes, cells],
  );
  const ranked = [...results].sort((a, b) => (a.ok ? a.finalScore : -1e9) - (b.ok ? b.finalScore : -1e9));
  const winner = ranked[ranked.length - 1];

  return (
    <div className="rounded-2xl border border-[#30363d] bg-[#0d1117] p-4 sm:p-6">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">SCORING PLAYGROUND <span className="text-xs font-normal text-[#8b949e]">dev-only</span></h2>
        <span className="text-xs text-[#6e7681]">shrink k={PLAY_CFG.shrinkageK} · w=√g · conf=√(avg/{PLAY_CFG.confidenceDenominator}) · final=raw×(0.3+0.7·conf)</span>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {PLAY_PRESETS.map((p, i) => (
          <button
            key={p.title}
            type="button"
            onClick={() => load(i)}
            className={`rounded-lg border px-3 py-1.5 text-xs ${i === idx ? 'border-[#58a6ff] bg-[#1f6feb]/20 text-[#e6edf3]' : 'border-[#30363d] bg-[#161b22] text-[#8b949e] hover:text-[#e6edf3]'}`}
          >
            {p.title}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-xs text-[#8b949e]">
          lane
          <select value={lane} onChange={(e) => setLane(e.target.value as Lane)} className="rounded border border-[#30363d] bg-[#161b22] px-2 py-1 text-xs">
            {(['1', '2', '3', '4', '5'] as Lane[]).map((l) => (
              <option key={l} value={l}>{laneLabel(l)}</option>
            ))}
          </select>
          <span className="font-mono text-[#e6edf3]">DemoCarry → {positionScore(demo, lane).toFixed(1)}/10</span>
        </label>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {results.map((r) => (
          <PlayCard
            key={r.hero.id}
            hid={r.hero.id}
            name={r.hero.name}
            posScore={r.hero.posScore}
            steps={r.steps}
            teamScore={r.teamScore}
            avgGames={r.avgGames}
            confidence={r.confidence}
            positionBonus={r.positionBonus}
            raw={r.raw}
            finalScore={r.finalScore}
            usable={r.usable}
            ok={r.ok}
            win={!!winner && r.hero.id === winner.hero.id && r.ok}
            onName={(v) => setHeroes((p) => p.map((h) => (h.id === r.hero.id ? { ...h, name: v } : h)))}
            onPos={(v) => setHeroes((p) => p.map((h) => (h.id === r.hero.id ? { ...h, posScore: Math.min(10, Math.max(0, num(v, 0))) } : h)))}
            onCell={setCell}
          />
        ))}
      </div>
      {winner && (
        <div className="mt-4 rounded-xl border border-[#30363d] bg-[#161b22] p-3 text-sm text-[#8b949e]">
          <span className="font-semibold text-[#e6edf3]">Verdict: {winner.ok ? winner.hero.name : 'no one (coverage blocked)'} wins.</span>{' '}
          {PLAY_PRESETS[idx].note}
        </div>
      )}
      <p className="mt-3 text-xs leading-relaxed text-[#6e7681]">
        Same steps as engine.ts. Sample size enters 3× by design (V2): shrink, weight, confidence.
        Position model frozen — no new heuristics in positions.ts.
      </p>
    </div>
  );
}
