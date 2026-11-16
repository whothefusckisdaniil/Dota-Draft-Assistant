import type { CandidateScore, Hero } from '../types';
import { localPortraitUrl } from '../components/HeroPortrait';

/**
 * Draft card images for sharing: enemies + top counterpicks, drawn on a canvas
 * in the browser. Portraits come from our own origin (public/heroes), so the
 * canvas is not tainted and can be exported.
 *   story — 1080×1920 (TikTok, Reels, Stories)
 *   post  — 1200×630 (link-preview / post format)
 */
export type CardFormat = 'story' | 'post';

export interface CardPick {
  hero: Hero;
  name: string;
  /** Role caption ("Carry") in the per-role overview, or the rank number. */
  tag: string;
  score: number;
}

export interface CardData {
  enemies: { hero: Hero; name: string }[];
  picks: CardPick[];
  /** "Best pick per role · All ranks" */
  context: string;
  labels: { enemies: string; counters: string; slogan: string; notAffiliated: string };
  site: string;
}

const C = {
  bg: '#090B0F', s1: '#11151C', s2: '#181E28', line: '#232B38',
  ink: '#E8ECF2', muted: '#8A94A6', accent: '#FFB43A', pos: '#3DDC97', neg: '#FF5C5C',
};
const DISPLAY = 'Unbounded, Inter, sans-serif';
const UI = 'Inter, system-ui, sans-serif';

const DIAMOND = new Path2D('M44.48 9.52A7.8 7.8 0 0 1 55.52 9.52L90.48 44.48A7.8 7.8 0 0 1 90.48 55.52L55.52 90.48A7.8 7.8 0 0 1 44.48 90.48L9.52 55.52A7.8 7.8 0 0 1 9.52 44.48Z');
const ARROW = new Path2D('M27 44 L53 44 L53 31 L75 50 L53 69 L53 56 L27 56 Z');

export function scoreLabel(v: number): string {
  const r = Math.round(v * 100) / 100;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}`;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Word-wrap into at most `maxLines` lines (the last one ellipsized). */
function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, max: number, lineH: number, maxLines = 2) {
  const lines: string[] = [];
  let line = '';
  for (const w of text.split(' ')) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > max && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown[maxLines - 1] = fit(ctx, `${shown[maxLines - 1]} ${lines.slice(maxLines).join(' ')}`, max);
  shown.forEach((l, i) => ctx.fillText(l, x, y + i * lineH));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

/** Square-cropped portrait (256×144 source → centre square), rounded. */
function portrait(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, hero: Hero, x: number, y: number, size: number, r: number) {
  ctx.save();
  roundRect(ctx, x, y, size, size, r);
  ctx.clip();
  ctx.fillStyle = C.s2;
  ctx.fillRect(x, y, size, size);
  if (img) {
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, x, y, size, size);
  } else {
    ctx.fillStyle = C.muted;
    ctx.font = `600 ${Math.round(size * 0.3)}px ${UI}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(hero.name.split(/[\s'-]+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase(), x + size / 2, y + size / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
}

function logo(ctx: CanvasRenderingContext2D, x: number, y: number, h: number) {
  // mark: diamond with the arrow "cut out" (filled with the background)
  const s = (h * 1.2) / 0.92 / 100;
  const markY = y - (100 * s - h) / 2;
  ctx.save();
  ctx.translate(x, markY);
  ctx.scale(s, s);
  const g = ctx.createLinearGradient(0, 4, 0, 96);
  g.addColorStop(0, '#FFC857');
  g.addColorStop(1, '#FF9F1C');
  ctx.shadowColor = 'rgba(255,180,58,0.35)';
  ctx.shadowBlur = 24 / s;
  ctx.fillStyle = g;
  ctx.fill(DIAMOND);
  ctx.shadowBlur = 0;
  ctx.translate(50, 50);
  ctx.rotate(-Math.PI / 4);
  ctx.translate(-50, -50);
  ctx.save();
  ctx.clip(DIAMOND);
  ctx.fillStyle = C.bg;
  ctx.fill(ARROW);
  ctx.restore();
  ctx.restore();
  // wordmark (cap height ≈ 0.75 em)
  const size = h / 0.75;
  ctx.font = `700 ${size}px ${DISPLAY}`;
  ctx.textBaseline = 'alphabetic';
  const tx = x + 100 * s * 0.96 + size * 0.6;
  ctx.fillStyle = '#F2F5FA';
  ctx.fillText('LAST', tx, y + h);
  ctx.fillStyle = C.accent;
  ctx.fillText('PICK', tx + ctx.measureText('LAST').width, y + h);
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color = C.muted) {
  ctx.font = `600 ${size}px ${UI}`;
  ctx.fillStyle = color;
  ctx.letterSpacing = `${size * 0.08}px`;
  ctx.fillText(text.toUpperCase(), x, y);
  ctx.letterSpacing = '0px';
}

function enemySlot(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, hero: Hero, x: number, y: number, size: number) {
  portrait(ctx, img, hero, x, y, size, size * 0.2);
  ctx.save();
  roundRect(ctx, x, y, size, size, size * 0.2);
  ctx.clip();
  ctx.fillStyle = 'rgba(255,92,92,0.1)';
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = C.neg;
  ctx.fillRect(x, y + size - Math.max(4, size * 0.05), size, Math.max(4, size * 0.05));
  ctx.restore();
}

function emptySlot(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.save();
  ctx.translate(x + size / 2, y + size / 2);
  ctx.rotate(Math.PI / 4);
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = '#2E3847';
  ctx.lineWidth = 3;
  const d = size * 0.42;
  roundRect(ctx, -d / 2, -d / 2, d, d, d * 0.2);
  ctx.stroke();
  ctx.restore();
}

function pickRow(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, p: CardPick, x: number, y: number, w: number, h: number, best: boolean) {
  roundRect(ctx, x, y, w, h, h * 0.18);
  ctx.fillStyle = C.s1;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.stroke();
  if (best) {
    ctx.save();
    roundRect(ctx, x, y, w, h, h * 0.18);
    ctx.clip();
    ctx.fillStyle = C.accent;
    ctx.fillRect(x, y, 6, h);
    ctx.restore();
  }
  const pad = h * 0.14;
  const ps = h - pad * 2;
  portrait(ctx, img, p.hero, x + pad + (best ? 6 : 0), y + pad, ps, ps * 0.16);
  const tx = x + pad * 2 + ps + (best ? 6 : 0);
  const scoreSize = Math.round(h * 0.34);
  ctx.font = `700 ${scoreSize}px ${DISPLAY}`;
  const score = scoreLabel(p.score);
  const sw = ctx.measureText(score).width;
  ctx.fillStyle = p.score > 0.005 ? C.pos : p.score < -0.005 ? C.neg : C.muted;
  ctx.fillText(score, x + w - pad * 1.4 - sw, y + h / 2 + scoreSize * 0.36);
  const maxText = x + w - pad * 2.4 - sw - tx;
  label(ctx, fit(ctx, p.tag, maxText), tx, y + h * 0.4, Math.round(h * 0.15), C.accent);
  ctx.font = `600 ${Math.round(h * 0.25)}px ${UI}`;
  ctx.fillStyle = C.ink;
  ctx.fillText(fit(ctx, p.name, maxText), tx, y + h * 0.74);
}

export async function renderShareCard(format: CardFormat, data: CardData): Promise<Blob> {
  const [W, H] = format === 'story' ? [1080, 1920] : [1200, 630];
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');

  await Promise.all([
    document.fonts.load(`700 40px Unbounded`),
    document.fonts.load(`600 40px Inter`),
  ]).catch(() => undefined);
  const imgs = new Map<number, HTMLImageElement | null>();
  await Promise.all([...data.enemies.map((e) => e.hero), ...data.picks.map((p) => p.hero)].map(async (h) => {
    if (!imgs.has(h.id)) imgs.set(h.id, await loadImage(localPortraitUrl(h)));
  }));

  // background + amber glow
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.9, H * 0.08, 0, W * 0.9, H * 0.08, W * 0.7);
  glow.addColorStop(0, 'rgba(255,180,58,0.16)');
  glow.addColorStop(1, 'rgba(255,180,58,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  if (format === 'story') {
    // content kept inside the ~250 px top/bottom zones that story UIs cover
    const M = 80;
    logo(ctx, M, 236, 46);
    label(ctx, data.labels.enemies, M, 392, 30);
    const gap = 24;
    const size = (W - M * 2 - gap * 4) / 5;
    for (let i = 0; i < 5; i++) {
      const e = data.enemies[i];
      const x = M + i * (size + gap);
      if (e) enemySlot(ctx, imgs.get(e.hero.id) ?? null, e.hero, x, 420, size);
      else emptySlot(ctx, x, 420, size);
    }
    label(ctx, data.labels.counters, M, 682, 30);
    ctx.font = `400 28px ${UI}`;
    ctx.fillStyle = C.muted;
    ctx.fillText(fit(ctx, data.context, W - M * 2), M, 724);
    const rowH = 150;
    data.picks.slice(0, 5).forEach((p, i) => {
      pickRow(ctx, imgs.get(p.hero.id) ?? null, p, M, 758 + i * (rowH + 18), W - M * 2, rowH, i === 0);
    });
    ctx.font = `700 38px ${DISPLAY}`;
    ctx.fillStyle = C.ink;
    wrap(ctx, data.labels.slogan, M, 1636, W - M * 2, 50);
    ctx.font = `600 30px ${UI}`;
    ctx.fillStyle = C.accent;
    ctx.fillText(data.site, M, 1746);
    ctx.font = `400 24px ${UI}`;
    ctx.fillStyle = C.muted;
    const na = data.labels.notAffiliated;
    ctx.fillText(na, W - M - ctx.measureText(na).width, 1746);
  } else {
    const M = 56;
    logo(ctx, M, 60, 34);
    label(ctx, data.labels.enemies, M, 190, 20);
    const size = 88;
    const gap = 14;
    for (let i = 0; i < 5; i++) {
      const e = data.enemies[i];
      const x = M + i * (size + gap);
      if (e) enemySlot(ctx, imgs.get(e.hero.id) ?? null, e.hero, x, 212, size);
      else emptySlot(ctx, x, 212, size);
    }
    ctx.font = `700 30px ${DISPLAY}`;
    ctx.fillStyle = C.ink;
    wrap(ctx, data.labels.slogan, M, 400, 500, 42);
    ctx.font = `600 22px ${UI}`;
    ctx.fillStyle = C.accent;
    ctx.fillText(data.site, M, H - 56);
    ctx.font = `400 18px ${UI}`;
    ctx.fillStyle = C.muted;
    ctx.fillText(data.labels.notAffiliated, M, H - 26);

    const RX = 620;
    const RW = W - RX - M;
    label(ctx, data.labels.counters, RX, 76, 20);
    ctx.font = `400 18px ${UI}`;
    ctx.fillStyle = C.muted;
    ctx.fillText(fit(ctx, data.context, RW), RX, 104);
    const rowH = 90;
    data.picks.slice(0, 5).forEach((p, i) => {
      pickRow(ctx, imgs.get(p.hero.id) ?? null, p, RX, 124 + i * (rowH + 8), RW, rowH, i === 0);
    });
  }

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('export failed'))), 'image/png'));
}

/** Top picks for the card: best per role in the overview, else the role's top 5. */
export function cardPicks(
  results: Map<string, CandidateScore[]> | null,
  summary: boolean,
  laneName: (lane: string) => string,
  heroName: (h: Hero) => string,
): CardPick[] {
  if (!results) return [];
  if (summary) {
    return [...results.entries()]
      .filter(([, list]) => list.length > 0)
      .map(([lane, list]) => ({ hero: list[0].hero, name: heroName(list[0].hero), tag: laneName(lane), score: list[0].finalScore }));
  }
  const [lane, list] = [...results.entries()][0] ?? [];
  if (!list || !lane) return [];
  return list.slice(0, 5).map((c, i) => ({ hero: c.hero, name: heroName(c.hero), tag: `#${i + 1} · ${laneName(lane)}`, score: c.finalScore }));
}
