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
