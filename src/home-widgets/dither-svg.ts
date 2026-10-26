/** The 4x4 Bayer matrix Dither Kit uses for every ordered-dither surface. */
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

type Options = {
  width: number;
  height: number;
  /** Pixel size of one dither cell. */
  cell?: number;
  color: string;
  /** Values before `splitAt` (the previous period) render in white at 45% opacity. */
  splitAt?: number;
};

/**
 * A dithered area chart as an SVG string, for Android home screen widgets
 * (they render static views, so Skia charts can't run there). Density fades
 * from the curve down to the baseline like Dither Kit's gradient variant, and
 * runs of lit cells in a row collapse into one rect to keep the SVG small.
 */
export function ditherAreaSvg(values: readonly number[], { width, height, cell = 3, color, splitAt }: Options): string {
  const columns = Math.max(2, Math.floor(width / cell));
  const rows = Math.max(2, Math.floor(height / cell));
  const max = Math.max(1, ...values);
  const last = Math.max(1, values.length - 1);

  const heightAt = (column: number) => {
    const position = (column / (columns - 1)) * last;
    const left = Math.floor(position);
    const right = Math.min(values.length - 1, left + 1);
    const t = position - left;
    const value = (values[left] ?? 0) * (1 - t) + (values[right] ?? 0) * t;
    return Math.round((value / max) * (rows - 2)) + 1;
  };

  const rects: string[] = [];
  const splitColumn = splitAt === undefined ? -1 : Math.round((splitAt / last) * (columns - 1));
  for (let row = 0; row < rows; row++) {
    let runStart = -1;
    let runColor = "";
    const flush = (end: number) => {
      if (runStart < 0) return;
      const fill = runColor === "muted" ? `fill="#FFFFFF" fill-opacity="0.45"` : `fill="${color}"`;
      rects.push(`<rect x="${runStart * cell}" y="${row * cell}" width="${(end - runStart) * cell}" height="${cell}" ${fill}/>`);
      runStart = -1;
    };
    for (let column = 0; column < columns; column++) {
      const top = rows - heightAt(column);
      let on = false;
      if (row >= top) {
        const depth = (row - top) / Math.max(1, rows - top);
        // Solid at the curve, thinning toward the baseline.
        const density = row === top ? 1 : 0.85 * (1 - depth) + 0.08;
        on = (BAYER4[row % 4]![column % 4]! + 0.5) / 16 < density;
      }
      const fill = column < splitColumn ? "muted" : "main";
      if (on && runStart >= 0 && fill !== runColor) flush(column);
      if (on && runStart < 0) {
        runStart = column;
        runColor = fill;
      } else if (!on) {
        flush(column);
      }
    }
    flush(columns);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${columns * cell}" height="${rows * cell}" viewBox="0 0 ${columns * cell} ${rows * cell}" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}

/** A horizontal bar, solid coral with a dithered leading edge, for ranked rows. */
export function ditherBarSvg({ width, height, share, color, cell = 3 }: { width: number; height: number; share: number; color: string; cell?: number }): string {
  const columns = Math.max(1, Math.floor(width / cell));
  const rows = Math.max(1, Math.floor(height / cell));
  const filled = Math.max(1, Math.round(columns * Math.max(0, Math.min(1, share))));
  const fade = Math.min(6, filled);
  const solid = filled - fade;
  // The solid part is one rect so scaling can't open seams between rows.
  const rects: string[] = solid > 0 ? [`<rect x="0" y="0" width="${solid * cell}" height="${rows * cell}" fill="${color}"/>`] : [];
  for (let row = 0; row < rows; row++) {
    for (let column = solid; column < filled; column++) {
      const density = 1 - (column - solid + 1) / (fade + 1);
      if ((BAYER4[row % 4]![column % 4]! + 0.5) / 16 < density) {
        rects.push(`<rect x="${column * cell}" y="${row * cell}" width="${cell}" height="${cell}" fill="${color}"/>`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${columns * cell}" height="${rows * cell}" viewBox="0 0 ${columns * cell} ${rows * cell}" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}

/** Goal progress inside a 2px outline, with a white tick where the pace says you should be. */
export function goalBarSvg({ width, height, progress, pace, color, line }: { width: number; height: number; progress: number; pace?: number; color: string; line: string }): string {
  const inner = Math.max(0, width - 4);
  const fill = Math.round(inner * Math.max(0, Math.min(1, progress)));
  const tick = pace !== undefined && pace > 0 && pace < 1 && progress < 1 ? Math.round(2 + inner * pace) : null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">
<rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="none" stroke="${line}" stroke-width="2"/>
${fill > 0 ? `<rect x="2" y="2" width="${fill}" height="${height - 4}" fill="${color}"/>` : ""}
${tick !== null ? `<rect x="${tick - 1}" y="0" width="2" height="${height}" fill="#FFFFFF"/>` : ""}
</svg>`;
}

/**
 * Overlapping dithered areas, one per platform, matching the in-app Platform
 * mix chart. Series share one scale; later series draw over earlier ones, so
 * pass the biggest first.
 */
export function ditherAreasSvg(
  series: readonly (readonly number[])[],
  colors: readonly string[],
  { width, height, cell = 3 }: { width: number; height: number; cell?: number },
): string {
  const columns = Math.max(2, Math.floor(width / cell));
  const rows = Math.max(4, Math.floor(height / cell));
  const max = Math.max(1, ...series.flat());
  // Each cell keeps the colour of the last series that lit it.
  const grid: (string | null)[][] = Array.from({ length: rows }, () => Array<string | null>(columns).fill(null));
  series.forEach((values, index) => {
    const last = Math.max(1, values.length - 1);
    const topAt = (column: number) => {
      const position = (column / (columns - 1)) * last;
      const left = Math.floor(position);
      const right = Math.min(values.length - 1, left + 1);
      const t = (1 - Math.cos((position - left) * Math.PI)) / 2;
      const value = (values[left] ?? 0) * (1 - t) + (values[right] ?? 0) * t;
      return rows - 2 - Math.round((value / max) * (rows - 4));
    };
    for (let column = 0; column < columns; column++) {
      const top = topAt(column);
      const next = column + 1 < columns ? topAt(column + 1) : top;
      // Solid stroke, filled vertically between neighbours so steep slopes stay connected.
      for (let row = Math.min(top, next); row <= Math.max(top, next) + 1 && row < rows; row++) grid[row]![column] = colors[index]!;
      // Fill down to the baseline, thinning with depth like Dither Kit's gradient areas.
      for (let row = top + 2; row < rows; row++) {
        const density = Math.max(0.08, 0.75 * (1 - (row - top) / Math.max(1, rows - top)));
        if ((BAYER4[row % 4]![column % 4]! + 0.5) / 16 < density) grid[row]![column] = colors[index]!;
      }
    }
  });
  const rects: string[] = [];
  grid.forEach((line, row) => {
    let runStart = -1;
    let runColor: string | null = null;
    for (let column = 0; column <= columns; column++) {
      const fill = column < columns ? line[column]! : null;
      if (fill !== runColor) {
        if (runColor !== null) rects.push(`<rect x="${runStart * cell}" y="${row * cell}" width="${(column - runStart) * cell}" height="${cell}" fill="${runColor}"/>`);
        runStart = column;
        runColor = fill;
      }
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${columns * cell}" height="${rows * cell}" viewBox="0 0 ${columns * cell} ${rows * cell}" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}
