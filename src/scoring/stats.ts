/** Ranking statistics for the experiment lab. */

/** Spearman ρ with ties handled via average ranks. Requires ≥2 pairs. */
export function spearmanRho(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2 || n !== ys.length) return NaN;
  const rx = averageRanks(xs);
  const ry = averageRanks(ys);
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let k = 0; k < n; k += 1) {
    num += (rx[k] - mx) * (ry[k] - my);
    dx += (rx[k] - mx) ** 2;
    dy += (ry[k] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return NaN; // no variance in one ranking
  return num / Math.sqrt(dx * dy);
}

/** Ranks 1..n, equal values receive the average of their rank span. */
function averageRanks(v: number[]): number[] {
  const idx = v.map((val, i) => [val, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(v.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[idx[k][1]] = avg;
    i = j + 1;
  }
  return out;
}