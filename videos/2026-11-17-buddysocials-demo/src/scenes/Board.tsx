import React from "react";
import { Video } from "@remotion/media";
import { Sequence, staticFile, useCurrentFrame } from "remotion";
import { CUE, f, FPS, PHONE_CUTS, PLATFORMS, TAGS } from "../data";
import { easeInOut, easeOut, lerp, ramp, track } from "../motion";
import { AppWindow, Cursor, PlatformChips, Shot, Tag, useLayout } from "../parts";
import { C } from "../theme";

// The desktop home is a 4-column grid that wraps, exactly like the app lays it out.
const GRID = { x: 420, y: 40, cell: 448, row: 322, gap: 32 };
const SPAN = { s: [1, 1], l: [2, 2], xl: [4, 2] } as const;
type Size = keyof typeof SPAN;
type Box = { x: number; y: number; w: number; h: number };

const flow = (items: [key: string, size: Size][]) => {
  const boxes: Record<string, Box> = {};
  let col = 0;
  let y = GRID.y;
  let rowH = 0;
  for (const [key, size] of items) {
    const [cols, rows] = SPAN[size];
    if (col + cols > 4) {
      y += rowH + GRID.gap;
      col = 0;
      rowH = 0;
    }
    const h = rows * GRID.row + (rows - 1) * GRID.gap;
    boxes[key] = { x: GRID.x + col * (GRID.cell + GRID.gap), y, w: cols * GRID.cell + (cols - 1) * GRID.gap, h };
    col += cols;
    rowH = Math.max(rowH, h);
  }
  return boxes;
};

// Four saved layouts of the same board, each rendered by the real desktop app (public/app/board-*.png):
// A is the layout as saved today, B swaps one widget, C resizes the chart, D reorders everything.
const STATES = [
  { shot: "board-A", at: 0, boxes: flow([["yt", "s"], ["ig", "s"], ["tt", "s"], ["slot", "s"], ["mix", "xl"], ["top", "l"], ["inbox", "l"]]) },
  { shot: "board-B", at: CUE.pick, boxes: flow([["yt", "s"], ["ig", "s"], ["tt", "s"], ["slot", "s"], ["mix", "xl"], ["top", "l"], ["inbox", "l"]]) },
  { shot: "board-C", at: CUE.resize, boxes: flow([["yt", "s"], ["ig", "s"], ["tt", "s"], ["slot", "s"], ["mix", "l"], ["top", "l"], ["inbox", "l"]]) },
  { shot: "board-D", at: CUE.drag, boxes: flow([["mix", "l"], ["top", "l"], ["yt", "s"], ["ig", "s"], ["tt", "s"], ["slot", "s"], ["inbox", "l"]]) },
];
const TILES = ["yt", "ig", "tt", "slot", "mix", "top", "inbox"];
const MOVE = 0.6; // seconds a layout change takes
const NAMED: Record<string, number> = { yt: 0, ig: 1, tt: 2, slot: 3 }; // the tile each spoken platform lights

const Tile: React.FC<{ id: string; order: number }> = ({ id, order }) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  // Which layout change is running, or the last one that finished.
  let to = 0;
  for (let i = 1; i < STATES.length; i++) if (t >= STATES[i].at) to = i;
  const from = Math.max(0, to - 1);
  const p = to === 0 ? 1 : ramp(frame, STATES[to].at, MOVE, easeInOut);
  const a = STATES[from].boxes[id];
  const b = STATES[to].boxes[id];
  const box = { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), w: lerp(a.w, b.w, p), h: lerp(a.h, b.h, p) };
  const moving = p > 0 && p < 1 && (a.x !== b.x || a.y !== b.y || a.w !== b.w || (to === 1 && id === "slot"));
  const lift = moving ? Math.sin(Math.PI * p) : 0;
  // Arriving on the board: the outline first, then the content wipes in from the left.
  const start = CUE.oneBoard + 0.15 + order * 0.07;
  const arrive = ramp(frame, start, 0.35, easeOut);
  const wipe = ramp(frame, start + 0.15, 0.7, easeInOut);
  const said = NAMED[id] === undefined ? undefined : CUE.names[NAMED[id]];
  const glow = said === undefined ? 0 : ramp(frame, said, 0.12) * (1 - ramp(frame, said + 0.45, 0.4));
  const swap = STATES[from].shot !== STATES[to].shot;
  return (
    <div style={{ position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h, overflow: "hidden", background: C.bg, opacity: arrive, transform: `scale(${lerp(0.94, 1, arrive) * (1 + 0.025 * lift)})`, zIndex: moving ? 2 : 1 }}>
      <div style={{ position: "absolute", inset: 0, clipPath: `inset(0 ${(1 - wipe) * 100}% 0 0)` }}>
        <Shot name={STATES[from].shot} style={{ left: -a.x, top: -a.y, }} />
        {swap ? <Shot name={STATES[to].shot} style={{ left: -b.x, top: -b.y, opacity: ramp(frame, STATES[to].at + MOVE * 0.15, MOVE * 0.6) }} /> : null}
      </div>
      <div style={{ position: "absolute", inset: 0, border: `4px solid ${C.line}` }} />
      <div style={{ position: "absolute", inset: 0, border: `4px solid ${C.white}`, opacity: lift }} />
      {said === undefined ? null : <div style={{ position: "absolute", inset: 0, border: `6px solid ${PLATFORMS[NAMED[id]].color}`, opacity: glow }} />}
    </div>
  );
};

export const Board: React.FC = () => {
  const L = useLayout();
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const win = track(frame, L.board.win);
  const cam = track(frame, L.board.cam);
  const phone = L.board.phone;
  const phoneIn = ramp(frame, CUE.yours + 0.3, 0.4, easeOut);
  const hover = ramp(frame, CUE.everyAccount + 0.75, 0.15) * (1 - ramp(frame, CUE.yours - 0.3, 0.2));
  const mix = STATES[0].boxes.mix;
  const live = ramp(frame, CUE.follows, 0.15) * (1 - ramp(frame, CUE.follows + 0.9, 0.5));
  return (
    <>
      <div style={{ position: "absolute", inset: 0 }}>
        <AppWindow win={win} cam={cam} tag={t >= CUE.yours + 0.5 ? TAGS.desktop : undefined} outline={live > 0.5 ? C.coral : C.white}>
          <div style={{ position: "absolute", left: 0, top: 0, width: 372, height: 1520, overflow: "hidden" }}>
            <Shot name="board-A" />
          </div>
          {TILES.map((id, order) => (
            <Tile key={id} id={id} order={order} />
          ))}
          <div style={{ position: "absolute", left: mix.x, top: mix.y, width: mix.w, height: mix.h, overflow: "hidden", opacity: hover }}>
            <Shot name="chart-hover" style={{ left: -mix.x, top: -mix.y }} />
          </div>
          <Cursor
            from={CUE.everyAccount - 0.2}
            to={CUE.yours - 0.2}
            path={[
              [CUE.everyAccount - 0.2, [1700, 1180]],
              [CUE.everyAccount + 0.8, [1051, 900], 0.9],
            ]}
          />
        </AppWindow>
      </div>
      <PlatformChips from={CUE.oneBoard - 0.15} to={CUE.yours} litAt={[...CUE.names]} enter={0.1} />
      {t >= CUE.yours ? (
        <div style={{ position: "absolute", left: phone.x, top: phone.y + (1 - phoneIn) * 80, width: phone.w, height: phone.h, opacity: phoneIn }}>
          {PHONE_CUTS.slice(0, -1).map((cut, i) => (
            <Sequence key={cut.at} from={f(cut.at)} durationInFrames={f(PHONE_CUTS[i + 1].at) - f(cut.at)} layout="none">
              <Video src={staticFile("clips/customise.mp4")} trimBefore={f(cut.clip)} muted style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
            </Sequence>
          ))}
          <div style={{ position: "absolute", inset: -2, border: `2px solid ${C.white}` }} />
          <Tag text={TAGS.phone} />
        </div>
      ) : null}
    </>
  );
};
