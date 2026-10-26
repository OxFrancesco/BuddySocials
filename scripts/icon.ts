/**
 * Generates the app icon set: three ascending bars drawn with Dither Kit's 4x4
 * Bayer matrix, solid at the top and dissolving toward the baseline.
 *
 * Android adaptive icon rules: a 108dp canvas, everything important inside the
 * 66dp safe circle, background as its own layer, and a monochrome layer for
 * themed icons (Android 13+). Run: bun scripts/icon.ts
 */
import { Resvg } from "@resvg/resvg-js";
import { join } from "node:path";

const CORAL = "#D6544B";
const BLACK = "#000000";
const WHITE = "#FFFFFF";

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** Canvas in dither cells: 108dp at 2dp per cell. */
const GRID = 54;
/** Bars in cells: 6 wide, 2 apart, inside a 22x22 square centred on the canvas (44dp, fits the 66dp circle). */
const BAR_WIDTH = 6;
const BAR_GAP = 2;
const HEIGHTS = [9, 15, 22];
const MARK = BAR_WIDTH * 3 + BAR_GAP * 2;
const ORIGIN_X = Math.round((GRID - MARK) / 2);
const BASELINE = Math.round((GRID + MARK) / 2);

/** Lit cells of the mark, in cell coordinates. */
function markCells(): [number, number][] {
  const cells: [number, number][] = [];
  HEIGHTS.forEach((height, bar) => {
    const x0 = ORIGIN_X + bar * (BAR_WIDTH + BAR_GAP);
    for (let row = 0; row < height; row++) {
      const y = BASELINE - height + row;
      // Top third solid, then thinning toward the baseline.
      const depth = row / Math.max(1, height - 1);
      const density = depth < 0.34 ? 1 : 1 - (depth - 0.34) * 1.05;
      for (let x = x0; x < x0 + BAR_WIDTH; x++) {
        if ((BAYER4[y % 4]![x % 4]! + 0.5) / 16 < density) cells.push([x, y]);
      }
    }
  });
  return cells;
}

function svg({ size, background, ink, scale = 1 }: { size: number; background: string | null; ink: string; scale?: number }) {
  const cell = (size / GRID) * scale;
  const offset = (size - GRID * cell) / 2;
  const rects = markCells()
    .map(([x, y]) => `<rect x="${(offset + x * cell).toFixed(2)}" y="${(offset + y * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" fill="${ink}"/>`)
    .join("");
  const bg = background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">${bg}${rects}</svg>`;
}

async function write(file: string, markup: string) {
  const png = new Resvg(markup).render().asPng();
  await Bun.write(join(import.meta.dir, "..", "assets", file), png);
  console.log(`assets/${file}`);
}

// Adaptive layers: the foreground keeps the 108dp geometry, the background is plain black (app.config).
await write("android-icon-foreground.png", svg({ size: 1024, background: null, ink: CORAL }));
await write("android-icon-monochrome.png", svg({ size: 1024, background: null, ink: WHITE }));
// Legacy and store icon: full square, mark scaled up since no launcher mask crops it.
await write("icon.png", svg({ size: 1024, background: BLACK, ink: CORAL, scale: 1.35 }));
// Splash: mark only, on the black splash background.
await write("splash-icon.png", svg({ size: 512, background: null, ink: CORAL, scale: 1.6 }));

// Preview sheet: circle, squircle and themed masks side by side, for checking crops.
const preview = (() => {
  const tile = 220;
  const fg = svg({ size: tile, background: BLACK, ink: CORAL });
  const mono = svg({ size: tile, background: "#E3E8D2", ink: "#3E5A1E" });
  const inner = (markup: string) => markup.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  const clip = (id: string, shape: string) => `<clipPath id="${id}">${shape}</clipPath>`;
  const r = tile / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${tile * 3 + 80}" height="${tile + 40}" shape-rendering="crispEdges">
    <rect width="100%" height="100%" fill="#1A1A1A"/>
    <defs>${clip("c", `<circle cx="${r}" cy="${r}" r="${r}"/>`)}${clip("s", `<rect width="${tile}" height="${tile}" rx="${tile * 0.28}"/>`)}</defs>
    <g transform="translate(20,20)" clip-path="url(#c)">${inner(fg)}</g>
    <g transform="translate(${tile + 40},20)" clip-path="url(#s)">${inner(fg)}</g>
    <g transform="translate(${tile * 2 + 60},20)" clip-path="url(#c)">${inner(mono)}</g>
  </svg>`;
})();
await Bun.write(join(import.meta.dir, "..", "e2e", "artifacts", "icon-preview.png"), new Resvg(preview).render().asPng());
console.log("e2e/artifacts/icon-preview.png");
