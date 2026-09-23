import { PLAY_CFG } from './playgroundData';
import type { ReplayStep } from '../scoring/replay';

interface Props {
  hid: string;
  name: string;
  posScore: number;
  steps: ReplayStep[];
  teamScore: number;
  avgGames: number;
  confidence: number;
  positionBonus: number;
  raw: number;
  finalScore: number;
  usable: number;
  ok: boolean;
  win: boolean;
  onName: (v: string) => void;
  onPos: (v: string) => void;
  onCell: (hid: string, rid: string, f: 'games' | 'wr', v: string) => void;
}

export function PlayCard(p: Props) {
  return (
    <div className={`rounded-xl border p-3 ${p.win ? 'border-[#3fb950]/60 bg-[#161b22]' : 'border-[#30363d] bg-[#161b22]'}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <input value={p.name} onChange={(e) => p.onName(e.target.value)} className="w-full bg-transparent font-semibold text-[#e6edf3] outline-none" />
        <span className="shrink-0 font-mono text-lg font-bold text-[#e6edf3]">final {p.finalScore >= 0 ? '+' : ''}{p.finalScore.toFixed(2)}</span>
      </div>
      <label className="mb-2 flex items-center gap-2 text-xs text-[#8b949e]">
        role fit (0–10)
        <input type="number" min={0} max={10} step={0.5} value={p.posScore} onChange={(e) => p.onPos(e.target.value)} className="w-20 rounded border border-[#30363d] bg-[#0d1117] px-2 py-1 font-mono text-xs" />
        <span className="font-mono">bonus {p.positionBonus >= 0 ? '+' : ''}{p.positionBonus.toFixed(2)}</span>
      </label>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[#6e7681]">
            <th className="py-1 font-normal">enemy</th>
            <th className="py-1 text-right font-normal">games</th>
            <th className="py-1 text-right font-normal">WR%</th>
            <th className="py-1 text-right font-normal">rawΔ</th>
            <th className="py-1 text-right font-normal">shrunkΔ</th>
            <th className="py-1 text-right font-normal">w=√g</th>
          </tr>
        </thead>
        <tbody>
          {p.steps.map((s) => (
            <PlayRowEdit key={s.enemy} hid={p.hid} step={s} onCell={p.onCell} />
          ))}
        </tbody>
      </table>
      <div className="mt-2 space-y-0.5 font-mono text-[11px] text-[#8b949e]">
        <div>teamScore (Σ shrunk×w / Σw) = {p.teamScore >= 0 ? '+' : ''}{p.teamScore.toFixed(3)}</div>
        <div>avgGames = {p.avgGames.toFixed(1)} → confidence = {p.confidence.toFixed(3)}</div>
        <div>raw = team×{PLAY_CFG.wCounter} + bonus×{PLAY_CFG.wPosition} = {p.raw >= 0 ? '+' : ''}{p.raw.toFixed(3)}</div>
        <div className="text-[#e6edf3]">final = raw × (0.3 + 0.7×conf) = {p.finalScore >= 0 ? '+' : ''}{p.finalScore.toFixed(3)}</div>
        {!p.ok && <div className="text-[#e3b341]">hidden by engine: usable {p.usable}/{p.steps.length}</div>}
      </div>
    </div>
  );
}

function PlayRowEdit({ hid, step, onCell }: { hid: string; step: ReplayStep; onCell: Props['onCell'] }) {
  return (
    <tr className="border-t border-[#21262d]">
      <td className="py-1 text-[#c9d1d9]">{step.enemy}</td>
      <td className="py-1 text-right">
        <input type="number" min={0} value={step.games} onChange={(e) => onCell(hid, step.id, 'games', e.target.value)} className="w-20 rounded border border-[#30363d] bg-[#0d1117] px-1 py-0.5 text-right font-mono" />
      </td>
      <td className="py-1 text-right">
        <input type="number" min={0} max={100} step={0.5} value={step.wr} onChange={(e) => onCell(hid, step.id, 'wr', e.target.value)} className="w-20 rounded border border-[#30363d] bg-[#0d1117] px-1 py-0.5 text-right font-mono" />
      </td>
      <td className="py-1 text-right font-mono text-[#8b949e]">{step.raw >= 0 ? '+' : ''}{step.raw.toFixed(1)}</td>
      <td className="py-1 text-right font-mono text-[#e6edf3]">{step.shrunk >= 0 ? '+' : ''}{step.shrunk.toFixed(2)}</td>
      <td className="py-1 text-right font-mono text-[#6e7681]">{step.w.toFixed(1)}</td>
    </tr>
  );
}
