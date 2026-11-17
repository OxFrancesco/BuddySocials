import React from "react";
import { Img, staticFile, useCurrentFrame } from "remotion";
import { CUE, END, FPS } from "../data";
import { easeOut, lerp, pop, ramp } from "../motion";
import { Chip, chipSpots, useLayout } from "../parts";
import { C, DISPLAY, MONO } from "../theme";

/** Icon, name, the line, and where it runs. */
export const End: React.FC = () => {
  const L = useLayout();
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const E = L.end;
  const icon = ramp(frame, CUE.brand, 0.35, easeOut);
  const name = ramp(frame, CUE.brand + 0.12, 0.4, easeOut);
  const spots = chipSpots(END.where, [[0, 1, 2]], E.chipSize, L.width / 2, E.chipsY, 0);
  return (
    <>
      <Img src={staticFile("images/icon.png")} style={{ position: "absolute", left: L.width / 2 - E.icon / 2, top: E.iconY, width: E.icon, height: E.icon, opacity: icon, transform: `scale(${lerp(0.8, 1, icon)})` }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: E.wordmarkY, textAlign: "center", fontFamily: DISPLAY, fontWeight: 700, fontSize: E.wordmark, lineHeight: 1, color: C.white, opacity: name, transform: `translateY(${(1 - name) * 24}px)` }}>{END.wordmark}</div>
      <div style={{ position: "absolute", left: 0, right: 0, top: E.taglineY, textAlign: "center", fontFamily: MONO, fontWeight: 700, fontSize: E.tagline, lineHeight: 1.45, letterSpacing: 2, color: C.white }}>
        {(L.shape === "landscape" ? [END.tagline.join(" ")] : END.tagline).map((row, i) => (
          <div key={row} style={{ opacity: ramp(frame, CUE.tagline + (L.shape === "landscape" ? 0 : i * (CUE.everywhere - CUE.tagline)), 0.3) }}>
            {row}
          </div>
        ))}
      </div>
      {END.where.map((name, i) => {
        const at = CUE.everywhere + 0.9 + i * 0.12;
        return t >= at ? <Chip key={name} text={name} color={C.coral} size={E.chipSize} lit={1} scale={pop(frame, at, 0.1)} style={{ left: spots[i].x, top: spots[i].y }} /> : null;
      })}
    </>
  );
};
