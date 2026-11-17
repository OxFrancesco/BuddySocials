// Where everything sits in each shape. The two shapes share scenes, never a crop of each other:
// 16:9 shows the whole desktop window with the phone beside it, 9:16 stacks and moves in closer.
// App coordinates ("cam") are pixels of the 2360x1520 desktop captures: [left, top, width shown].
import { CUE } from "./data";
import type { Key } from "./motion";
import { SAFE_ZONE } from "./safe-zones";

export type Rect = { x: number; y: number; w: number; h: number };
const r = (...values: number[]): number[] => values;

export type Layout = {
  shape: "landscape" | "vertical";
  width: number;
  height: number;
  /** Text stays inside this box. */
  text: { left: number; right: number; top: number; bottom: number };
  top: { wordmarkY: number; wordmarkSize: number; label: { x: number; y: number; size: number; align: "left" | "right" } };
  chips: { size: number; rows: number[][]; centerX: number; y: number; rowGap: number };
  hook: { card: { w: number; h: number; name: number }; neat: [number, number][]; mess: [number, number][]; stack: [number, number]; step: [number, number]; text: { x: number; y: number; size: number } };
  board: { win: Key[]; cam: Key[]; phone: Rect };
  posts: { win: number[]; cam: Key[] };
  publish: { win: number[]; type: number[]; media: number[]; crop: number[]; pick: number[] };
  inbox: { win: number[]; cam: Key[]; goalsWin: number[]; goalsCam: Key[] };
  apps: { win: number[]; cam: Key[]; phone: Rect; widgets: { x: number; y: number; col: number; gap: number } };
  end: { icon: number; iconY: number; wordmark: number; wordmarkY: number; tagline: number; taglineY: number; chipsY: number; chipSize: number };
};

const zone = SAFE_ZONE.bands;

export const LANDSCAPE: Layout = {
  shape: "landscape",
  width: 1920,
  height: 1080,
  text: { left: 96, right: 1824, top: 54, bottom: 1026 },
  top: { wordmarkY: 36, wordmarkSize: 34, label: { x: 1824, y: 36, size: 36, align: "right" } },
  chips: { size: 20, rows: [[0, 1, 2, 3, 4]], centerX: 960, y: 40, rowGap: 0 },
  hook: {
    card: { w: 320, h: 210, name: 40 },
    neat: [[272, 440], [616, 440], [960, 440], [1304, 440], [1648, 440]],
    mess: [[340, 300], [770, 540], [1140, 280], [1560, 480], [1010, 640]],
    stack: [960, 440],
    step: [84, 52],
    text: { x: 96, y: 884, size: 104 },
  },
  board: {
    win: [
      [6, r(210, 118, 1500, 904)],
      [CUE.yours + 0.5, r(96, 190, 1200, 760), 0.6],
    ],
    cam: [
      [6, r(0, 0, 2360)],
      [CUE.everyAccount + 0.7, r(380, 330, 1500), 0.9],
      [CUE.yours + 0.5, r(372, 0, 1988), 0.6],
    ],
    phone: { x: 1343, y: 190, w: 481, h: 760 },
  },
  posts: {
    win: r(210, 118, 1500, 904),
    cam: [
      [24, r(0, 0, 2360)],
      [CUE.numbers + 0.5, r(960, 96, 1400), 0.8],
    ],
  },
  publish: { win: r(210, 118, 1500, 904), type: r(400, 100, 1500), media: r(400, 100, 1500), crop: r(400, 150, 1500), pick: r(420, 330, 1900) },
  inbox: {
    win: r(210, 118, 1500, 904),
    cam: [
      [36, r(0, 0, 1700)],
      [CUE.caughtUp, r(0, 0, 1000), 1.6],
    ],
    goalsWin: r(210, 340, 1500, 360),
    goalsCam: [[CUE.goals, r(570, 20, 2010)]],
  },
  apps: {
    win: r(210, 118, 1500, 904),
    cam: [
      [42, r(0, 0, 2360)],
      [CUE.updates + 0.45, r(0, 978, 900), 0.7],
    ],
    phone: { x: 190, y: 128, w: 544, h: 860 },
    widgets: { x: 884, y: 128, col: 460, gap: 20 },
  },
  end: { icon: 200, iconY: 250, wordmark: 150, wordmarkY: 490, tagline: 36, taglineY: 690, chipsY: 800, chipSize: 26 },
};

export const VERTICAL: Layout = {
  shape: "vertical",
  width: 1080,
  height: 1920,
  text: { left: zone[0].left, right: zone[1].right, top: zone[0].top, bottom: zone[1].bottom },
  top: { wordmarkY: 228, wordmarkSize: 34, label: { x: 130, y: 292, size: 68, align: "left" } },
  chips: { size: 26, rows: [[0, 1, 2], [3, 4]], centerX: 540, y: 1300, rowGap: 14 },
  hook: {
    card: { w: 400, h: 230, name: 46 },
    neat: [[310, 620], [770, 620], [310, 900], [770, 900], [540, 1180]],
    mess: [[360, 590], [740, 760], [330, 980], [720, 1160], [520, 880]],
    stack: [540, 900],
    step: [56, 78],
    text: { x: 130, y: 236, size: 76 },
  },
  board: {
    win: [
      [6, r(40, 430, 1000, 830)],
      [CUE.yours + 0.5, r(40, 430, 1000, 520), 0.6],
    ],
    cam: [
      [6, r(404, 0, 1440)],
      [CUE.everyAccount + 0.7, r(420, 300, 1180), 0.9],
      [CUE.yours + 0.5, r(372, 0, 1988), 0.6],
    ],
    phone: { x: 353, y: 990, w: 373, h: 590 },
  },
  posts: {
    win: r(40, 430, 1000, 960),
    cam: [
      [24, r(372, 0, 1382)],
      [CUE.numbers + 0.5, r(978, 0, 1382), 0.8],
    ],
  },
  publish: { win: r(40, 430, 1000, 830), type: r(420, 110, 1250), media: r(420, 110, 1250), crop: r(420, 150, 1100), pick: r(420, 20, 1500) },
  inbox: {
    win: r(40, 430, 1000, 700),
    cam: [
      [36, r(0, 0, 1500)],
      [CUE.caughtUp, r(0, 0, 1000), 1.6],
    ],
    goalsWin: r(40, 620, 1000, 240),
    goalsCam: [[CUE.goals, r(570, 20, 2010)]],
  },
  apps: {
    win: r(40, 480, 1000, 644),
    cam: [
      [42, r(0, 0, 2360)],
      [CUE.updates + 0.45, r(0, 978, 842), 0.7],
    ],
    phone: { x: 397, y: 410, w: 285, h: 450 },
    widgets: { x: 200, y: 884, col: 330, gap: 20 },
  },
  end: { icon: 220, iconY: 560, wordmark: 100, wordmarkY: 840, tagline: 36, taglineY: 990, chipsY: 1150, chipSize: 28 },
};
