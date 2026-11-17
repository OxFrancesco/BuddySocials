import React from "react";
import { useCurrentFrame } from "remotion";
import { CUE, DRAFT_TEXT_CHARS, FPS, SCENES } from "../data";
import { pop, ramp } from "../motion";
import { AppWindow, Cursor, PlatformChips, Shot, useLayout } from "../parts";
import { C } from "../theme";

const TEXT = { x: 453, y: 150, char: 18, h: 72 };
// Account buttons in the draft with a picture attached, in app pixels: [left, top, width, height].
const PICKS = [
  [452, 805, 392, 62], // TikTok
  [1315, 805, 406, 62], // YouTube
  [452, 885, 421, 62], // Instagram, second account
];
const PUBLISH = [576, 1031, 153, 62];

/** Write once, attach a picture, crop it, pick accounts, publish. Each step is a real screen of the app. */
export const Publish: React.FC = () => {
  const L = useLayout();
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const from = SCENES.publish.from;
  const step = t < CUE.picture ? "type" : t < CUE.crop ? "media" : t < CUE.choose ? "crop" : "pick";
  const typed = Math.round(ramp(frame, CUE.typeFrom, CUE.typeTo - CUE.typeFrom, (x) => x) * DRAFT_TEXT_CHARS);
  const caret = TEXT.x + typed * TEXT.char;
  return (
    <>
      <AppWindow win={L.publish.win} cam={L.publish[step]}>
        {step === "type" ? (
          <>
            <Shot name="draft-editor" />
            <div style={{ position: "absolute", left: caret, top: TEXT.y, width: (DRAFT_TEXT_CHARS - typed) * TEXT.char + 60, height: TEXT.h, background: C.bg }} />
            {typed < DRAFT_TEXT_CHARS ? <div style={{ position: "absolute", left: caret + 2, top: TEXT.y + 10, width: 3, height: 48, background: C.coral }} /> : null}
          </>
        ) : step === "crop" ? (
          <Shot name="media-editor" />
        ) : (
          <>
            <Shot name="draft-media" />
            {/* A picked account inverts, exactly as the app draws it: white on black becomes black on white. */}
            {PICKS.map(([x, y, w, h], i) => (t >= CUE.accounts[i] ? <div key={i} style={{ position: "absolute", left: x, top: y, width: w, height: h, background: "#fff", mixBlendMode: "difference", transform: `scale(${pop(frame, CUE.accounts[i], 0.06)})` }} /> : null))}
            {t >= CUE.publish ? <div style={{ position: "absolute", left: PUBLISH[0], top: PUBLISH[1], width: PUBLISH[2], height: PUBLISH[3], background: "#fff", opacity: 0.85 * (1 - ramp(frame, CUE.publish, 0.35)) }} /> : null}
          </>
        )}
        <Cursor
          from={from}
          to={SCENES.publish.to}
          clicks={[CUE.add, CUE.edit, CUE.useImage, ...CUE.accounts, CUE.publish]}
          path={[
            [from, [1500, 700]],
            [CUE.add - 0.05, [640, 482], 0.6],
            [CUE.picture, [640, 482]],
            [CUE.edit - 0.05, [490, 672], 0.5],
            [CUE.crop, [490, 672]],
            [CUE.useImage - 0.05, [600, 1140], 0.45],
            [CUE.choose, [600, 1140]],
            [CUE.accounts[0] - 0.03, [690, 842], 0.15],
            [CUE.accounts[1] - 0.03, [1560, 842], 0.3],
            [CUE.accounts[2] - 0.03, [700, 922], 0.3],
            [CUE.publish - 0.05, [660, 1068], 0.5],
          ]}
        />
      </AppWindow>
      <PlatformChips from={CUE.choose} to={SCENES.publish.to} litAt={[CUE.published + 0.08, CUE.published + 0.16, CUE.published + 0.24, undefined, CUE.published]} />
    </>
  );
};
