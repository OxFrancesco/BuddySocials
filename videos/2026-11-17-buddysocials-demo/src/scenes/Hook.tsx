import React from "react";
import { useCurrentFrame } from "remotion";
import { CUE, FPS, HOOK_LINES, PLATFORMS } from "../data";
import { easeIn, pop, ramp, track } from "../motion";
import { chipSpots, useLayout } from "../parts";
import { C, DISPLAY, MONO } from "../theme";

/** Five platforms as five separate windows: lined up, then a mess, then a pile of tabs, then they fold into the top bar. */
export const Hook: React.FC = () => {
  const L = useLayout();
  const frame = useCurrentFrame();
  const t = frame / FPS;
  if (t >= CUE.oneBoard) return null;
  const H = L.hook;
  const spots = chipSpots(PLATFORMS.map((p) => p.name), L.chips.rows, L.chips.size, L.chips.centerX, L.chips.y, L.chips.rowGap);
  const line = [...HOOK_LINES].reverse().find((l) => t >= l.at)!;
  const leave = ramp(frame, CUE.oneBoard - 0.2, 0.2, easeIn);
  return (
    <>
      {PLATFORMS.map((p, i) => {
        const chip = spots[i];
        const [x, y, scale] = track(
          frame,
          [
            [0, [H.neat[i][0], H.neat[i][1], 1]],
            [CUE.dashboards + 0.5, [H.mess[i][0], H.mess[i][1], 1.16], 0.5],
            [CUE.tabs + 0.5, [H.stack[0] + (i - 2) * H.step[0], H.stack[1] + (i - 2) * H.step[1], 1], 0.5],
            [CUE.oneBoard, [chip.x + chip.w / 2, chip.y + chip.h / 2, chip.h / H.card.h], 0.5],
          ],
          0.5,
        );
        const on = CUE.platforms + i * 0.13;
        const lit = t >= on;
        const s = scale * pop(frame, on, 0.07);
        return (
          <div
            key={p.name}
            style={{
              position: "absolute",
              left: x - H.card.w / 2,
              top: y - H.card.h / 2,
              width: H.card.w,
              height: H.card.h,
              boxSizing: "border-box",
              border: `2px solid ${lit ? C.white : "#5A5A5A"}`,
              background: C.bg,
              transform: `scale(${s})`,
              opacity: 1 - leave,
              zIndex: i,
            }}
          >
            <div style={{ height: 44, borderBottom: `2px solid ${lit ? C.white : "#5A5A5A"}`, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 14px" }}>
              <div style={{ width: 18, height: 18, boxSizing: "border-box", border: `2px solid ${p.color}`, background: lit ? p.color : "transparent" }} />
              <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 22, color: lit ? C.white : C.dim, lineHeight: 1 }}>×</div>
            </div>
            <div style={{ position: "absolute", left: 0, right: 0, top: 46, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: DISPLAY, fontWeight: 700, fontSize: H.card.name, color: lit ? C.white : C.dim }}>{p.name}</div>
          </div>
        );
      })}
      <div style={{ position: "absolute", left: H.text.x, top: H.text.y, fontFamily: DISPLAY, fontWeight: 700, fontSize: H.text.size, lineHeight: 1.08, color: C.white, opacity: 1 - ramp(frame, CUE.oneBoard - 0.5, 0.2, easeIn), whiteSpace: "nowrap" }}>
        {(L.shape === "landscape" ? [line.text.join(" ")] : line.text).map((row) => (
          <div key={row}>
            <span style={{ color: row.startsWith("5") ? C.coral : C.white }}>{row.slice(0, 1)}</span>
            {row.slice(1)}
          </div>
        ))}
      </div>
    </>
  );
};

