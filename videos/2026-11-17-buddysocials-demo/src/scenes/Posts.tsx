import React from "react";
import { useCurrentFrame } from "remotion";
import { CUE, SCENES } from "../data";
import { easeOut, pop, ramp, track } from "../motion";
import { AppWindow, Shot, useLayout, useZoom } from "../parts";
import { C } from "../theme";

const ROW = { top: 128, pitch: 130.4, count: 11 };

const Numbers: React.FC = () => {
  const frame = useCurrentFrame();
  const k = useZoom();
  const p = ramp(frame, CUE.numbers, 0.3, easeOut);
  return <div style={{ position: "absolute", left: 1622, top: 132, width: 716, height: 1500, boxSizing: "border-box", border: `${3 / k}px solid ${C.coral}`, opacity: p, transformOrigin: "50% 0", transform: `scale(${pop(frame, CUE.numbers, 0.03)})` }} />;
};

/** Every post in one list: the rows arrive top to bottom, then the view moves onto the numbers. */
export const Posts: React.FC = () => {
  const L = useLayout();
  const frame = useCurrentFrame();
  const from = SCENES.posts.from;
  return (
    <AppWindow win={L.posts.win} cam={track(frame, L.posts.cam)}>
      <Shot name="posts" />
      {Array.from({ length: ROW.count }, (_, i) => (
        <div key={i} style={{ position: "absolute", left: 380, top: ROW.top + i * ROW.pitch, width: 1980, height: ROW.pitch - 4, background: C.bg, opacity: 1 - ramp(frame, from + 0.05 + i * 0.05, 0.25) }} />
      ))}
      <Numbers />
    </AppWindow>
  );
};
