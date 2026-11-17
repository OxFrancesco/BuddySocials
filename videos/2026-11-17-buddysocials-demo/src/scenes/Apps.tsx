import React from "react";
import { Video } from "@remotion/media";
import { Img, Sequence, staticFile, useCurrentFrame } from "remotion";
import { CUE, f, FPS, TAGS } from "../data";
import { easeInOut, easeOut, lerp, pop, ramp, track } from "../motion";
import { AppWindow, Chip, chipSpots, Cursor, Shot, Tag, useLayout } from "../parts";
import { C } from "../theme";

// Home screen widgets captured on the phone. `ratio` is height / width of the capture.
// The inbox widget is cropped to its count: the rest of it shows other people's comments.
const WIDE = 492 / 1042;
const WIDGETS = [
  { file: "widget-views", col: 0, ratio: WIDE },
  { file: "widget-latest-post", col: 1, ratio: WIDE },
  { file: "widget-mix", col: 0, ratio: WIDE },
  { file: "widget-platforms", col: 1, ratio: WIDE, grows: "widget-platforms-tall", grownRatio: 770 / 1042 },
  { file: "widget-goals", col: 0, ratio: WIDE },
  { file: "widget-pulse", col: 1, ratio: WIDE, width: 476 / 1042 },
  { file: "widget-inbox", col: 0, ratio: 262 / 1042 },
];

const Widgets: React.FC = () => {
  const L = useLayout();
  const frame = useCurrentFrame();
  const W = L.apps.widgets;
  const grow = ramp(frame, CUE.resizable, 0.5, easeInOut);
  const tops = [W.y, W.y];
  return (
    <>
      {WIDGETS.map((w, i) => {
        const h = W.col * lerp(w.ratio, w.grownRatio ?? w.ratio, grow);
        const top = tops[w.col];
        tops[w.col] += h + W.gap;
        const at = CUE.seven + i * 0.09;
        const arrive = ramp(frame, at, 0.3, easeOut);
        const width = W.col * (w.width ?? 1);
        return (
          <div key={w.file} style={{ position: "absolute", left: W.x + w.col * (W.col + W.gap), top, width, height: h, overflow: "hidden", borderRadius: W.col * 0.06, background: C.bg, border: `2px solid ${C.line}`, boxSizing: "border-box", opacity: arrive, transform: `scale(${lerp(0.9, 1, arrive) * pop(frame, at, 0.04)})` }}>
            <Img src={staticFile(`images/${w.file}.png`)} style={{ position: "absolute", left: 0, top: 0, width, maxWidth: "none", opacity: w.grows ? 1 - grow : 1 }} />
            {w.grows ? <Img src={staticFile(`images/${w.grows}.png`)} style={{ position: "absolute", left: 0, top: 0, width: W.col, maxWidth: "none", opacity: grow }} /> : null}
          </div>
        );
      })}
    </>
  );
};

/** The desktop app on macOS and Linux updating itself, then the Android app and its home screen widgets. */
export const Apps: React.FC = () => {
  const L = useLayout();
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const os = ["MACOS", "LINUX"];
  const spots = chipSpots(os, [[0, 1]], L.chips.size, L.chips.centerX, L.chips.y, 0);
  if (t < CUE.android) {
    return (
      <>
        <AppWindow win={L.apps.win} cam={track(frame, L.apps.cam)}>
          <Shot name="update" />
          {t >= CUE.update ? <div style={{ position: "absolute", left: 40, top: 1278, width: 138, height: 64, background: "#fff", opacity: 0.85 * (1 - ramp(frame, CUE.update, 0.35)) }} /> : null}
          <Cursor
            from={CUE.updates}
            to={CUE.android}
            clicks={[CUE.update]}
            path={[
              [CUE.updates, [620, 1180]],
              [CUE.update - 0.05, [112, 1312], 0.5],
            ]}
          />
        </AppWindow>
        {os.map((name, i) => {
          const at = i === 0 ? CUE.macos : CUE.linux;
          return t >= at ? <Chip key={name} text={name} color={C.coral} size={L.chips.size} lit={1} scale={pop(frame, at, 0.12)} style={{ left: spots[i].x, top: spots[i].y }} /> : null;
        })}
      </>
    );
  }
  const phone = L.apps.phone;
  const phoneIn = ramp(frame, CUE.android, 0.45, easeOut);
  return (
    <>
      <div style={{ position: "absolute", left: phone.x, top: phone.y + (1 - phoneIn) * 80, width: phone.w, height: phone.h, opacity: phoneIn }}>
        <Sequence from={f(CUE.android)} layout="none">
          <Video src={staticFile("clips/home.mp4")} trimBefore={f(0.9)} playbackRate={0.42} muted style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        </Sequence>
        <div style={{ position: "absolute", inset: -2, border: `2px solid ${C.white}` }} />
        <Tag text={TAGS.android} />
      </div>
      <Widgets />
    </>
  );
};

