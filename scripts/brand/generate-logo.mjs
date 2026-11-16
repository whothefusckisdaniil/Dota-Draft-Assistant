// LASTPICK brand generator: mark + outlined wordmark SVGs (public/brand).
// The wordmark is converted to outlines, so the files need no font.
// Run (one-off, nothing is added to package.json):
//   npm i --no-save opentype.js@1.3.4 @fontsource/unbounded@5.1.0
//   node scripts/brand/generate-logo.mjs public/brand
// then copy public/brand/favicon.svg over public/favicon.svg and run
//   node scripts/brand/render-brand.mjs   (PNG icons + og-image.png)
import fs from 'node:fs';
import path from 'node:path';
import opentype from 'opentype.js';

const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
const font = opentype.parse(fs.readFileSync('node_modules/@fontsource/unbounded/files/unbounded-latin-700-normal.woff').buffer);
const upm = font.unitsPerEm;
const capH = font.tables.os2.sCapHeight || font.charToGlyph('L').getBoundingBox().y2;

// ---------- mark (100×100 box) ----------
// Rounded diamond: vertices (50,4) (96,50) (50,96) (4,50); side ≈ 65, corner r = 12% ≈ 7.8.
const r = 7.8, o = +(r / Math.SQRT2).toFixed(2);
const diamond = [
  `M${50 - o} ${4 + o}`, `A${r} ${r} 0 0 1 ${50 + o} ${4 + o}`,
  `L${96 - o} ${50 - o}`, `A${r} ${r} 0 0 1 ${96 - o} ${50 + o}`,
  `L${50 + o} ${96 - o}`, `A${r} ${r} 0 0 1 ${50 - o} ${96 - o}`,
  `L${4 + o} ${50 + o}`, `A${r} ${r} 0 0 1 ${4 + o} ${50 - o}`, 'Z',
].join(' ');
// Advantage arrow, drawn pointing +x around the centre, then turned to point up-right.
// Rotated back, the diamond is the square 17.5–82.5: the arrow stays inside with a margin.
const arrowLocal = 'M27 44 L53 44 L53 31 L75 50 L53 69 L53 56 L27 56 Z';
const arrowT = 'rotate(-45 50 50)';
// Small sizes (favicon, ≤32 px): a bolder arrow, also fully inside.
const smallArrowLocal = 'M29 42 L49 42 L49 28 L73 50 L49 72 L49 58 L29 58 Z';

const grad = (id) => `<linearGradient id="${id}" x1="0" y1="4" x2="0" y2="96" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFC857"/><stop offset="1" stop-color="#FF9F1C"/></linearGradient>`;

function markGroup({ id = 'lp', fill, cut = arrowLocal, x = 0, y = 0, s = 1 }) {
  const paint = fill ?? `url(#${id}-g)`;
  const defs = `${fill ? '' : grad(`${id}-g`)}<mask id="${id}-m" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect width="100" height="100" fill="#fff"/><path d="${cut}" transform="${arrowT}" fill="#000"/></mask>`;
  return { defs, body: `<g transform="translate(${x} ${y}) scale(${s})"><path d="${diamond}" fill="${paint}" mask="url(#${id}-m)"/></g>` };
}

const svg = (w, h, defs, body, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"${extra}>\n<defs>${defs}</defs>\n${body}\n</svg>\n`;

function write(name, content) {
  fs.writeFileSync(path.join(OUT, name), content);
  console.log(name, content.length);
}

// mark only
{
  const m = markGroup({});
  write('lastpick-mark.svg', svg(100, 100, m.defs, m.body));
  const s = markGroup({ id: 'lps', cut: smallArrowLocal });
  write('lastpick-mark-small.svg', svg(100, 100, s.defs, s.body));
}

// ---------- wordmark ----------
const FS = 100; // font size in px
const scale = FS / upm;
const cap = capH * scale;
const track = 0.02 * FS;
function textPath(str, x0, baseline) {
  let x = x0;
  const parts = [];
  for (const ch of str) {
    const g = font.charToGlyph(ch);
    parts.push(g.getPath(x, baseline, FS).toPathData(2));
    x += g.advanceWidth * scale + track;
  }
  return { d: parts.join(''), end: x - track };
}
const lWidth = font.charToGlyph('L').getBoundingBox();
const gap = (lWidth.x2 - lWidth.x1) * scale; // spacing = width of "L"
const pad = cap; // clear space = cap height of "L"
const markSize = cap * 1.2 / 0.92; // diamond spans 92% of the mark box

function horizontal({ mono } = {}) {
  const capTop = pad + cap * 0.1;           // diamond (1.2 × cap) starts at the clear-space line
  const baseline = capTop + cap;
  const centre = capTop + cap / 2;
  const m = markGroup({ id: 'h', fill: mono, x: pad - markSize * 0.04, y: centre - markSize / 2, s: markSize / 100 });
  const tx = pad - markSize * 0.04 + markSize * 0.96 + gap;
  const last = textPath('LAST', tx, baseline);
  const pick = textPath('PICK', last.end + track, baseline);
  const w = Math.ceil(pick.end + pad), h = Math.ceil(baseline + cap * 0.1 + pad);
  return svg(w, h, m.defs,
    `${m.body}<path d="${last.d}" fill="${mono ?? '#F2F5FA'}"/><path d="${pick.d}" fill="${mono ?? '#FFB43A'}"/>`);
}
write('lastpick-horizontal.svg', horizontal());
write('lastpick-mono-white.svg', horizontal({ mono: '#FFFFFF' }));
write('lastpick-mono-black.svg', horizontal({ mono: '#000000' }));

// vertical: mark over the word, centred (mark bigger: 2.4× cap)
{
  const word = textPath('LASTPICK', 0, 0);
  const wordW = word.end;
  const big = cap * 2.4 / 0.92;
  const w = Math.ceil(wordW + pad * 2);
  const markY = pad;
  const baseline = markY + big + gap + cap;
  const m = markGroup({ id: 'v', x: (w - big) / 2, y: markY, s: big / 100 });
  const last = textPath('LAST', pad, baseline);
  const pick = textPath('PICK', last.end + track, baseline);
  write('lastpick-vertical.svg', svg(w, Math.ceil(baseline + pad), m.defs,
    `${m.body}<path d="${last.d}" fill="#F2F5FA"/><path d="${pick.d}" fill="#FFB43A"/>`));
}

// app icon: dark rounded square, mark centred at 60% of the area (side √0.6 ≈ 77.5%)
{
  const side = 512, k = Math.sqrt(0.6) * side;
  const m = markGroup({ id: 'a', x: (side - k) / 2, y: (side - k) / 2, s: k / 100 });
  write('lastpick-app-icon.svg', svg(side, side, m.defs, `<rect width="${side}" height="${side}" rx="112" fill="#090B0F"/>${m.body}`));
  // maskable: full-bleed background, mark inside the 80% safe zone
  const k2 = side * 0.56;
  const m2 = markGroup({ id: 'am', x: (side - k2) / 2, y: (side - k2) / 2, s: k2 / 100 });
  write('lastpick-maskable.svg', svg(side, side, m2.defs, `<rect width="${side}" height="${side}" fill="#090B0F"/>${m2.body}`));
}

// favicon: simplified mark (no arrow) — reads at 16px
{
  const s = markGroup({ id: 'f', cut: smallArrowLocal });
  write('favicon.svg', svg(100, 100, s.defs, s.body));
}
console.log({ upm, capH, cap, gap });
