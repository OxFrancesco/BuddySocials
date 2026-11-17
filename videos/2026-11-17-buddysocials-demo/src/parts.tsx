import React, { createContext, useContext } from "react";
import { Img, staticFile, useCurrentFrame } from "remotion";
import { FPS, LABELS, PLATFORMS } from "./data";
import type { Layout } from "./layout";
import { easeOut, pop, ramp, track, type Key } from "./motion";
import { C, DISPLAY, MONO } from "./theme";

export const LayoutContext = createContext<Layout>(null as unknown as Layout);
export const useLayout = () => useContext(LayoutContext);

/** How many frame pixels one app pixel takes inside the nearest window, for sizing cursors and outlines. */
const ZoomContext = createContext(1);
export const useZoom = () => useContext(ZoomContext);

export const APP = { w: 2360, h: 1520 };

/** One of the desktop captures, laid out in app pixels. */
export const Shot: React.FC<{ name: string; width?: number; height?: number; style?: React.CSSProperties }> = ({ name, width = APP.w, height = APP.h, style }) => (
  <Img src={staticFile(`app/${name}.png`)} style={{ position: "absolute", left: 0, top: 0, width, height, maxWidth: "none", ...style }} />
);

/** A view onto the desktop app: `win` is where it sits in the frame, `cam` the part of the app it shows. */
export const AppWindow: React.FC<{ win: number[]; cam: number[]; tag?: string; children: React.ReactNode; outline?: string }> = ({ win, cam, tag, children, outline = C.white }) => {
  const [x, y, w, h] = win;
  const [sx, sy, sw] = cam;
  const k = w / sw;
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, height: h }}>
      <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: C.bg }}>
        <ZoomContext.Provider value={k}>
          <div style={{ position: "absolute", left: 0, top: 0, width: 2600, height: 1700, transformOrigin: "0 0", transform: `translate(${-sx * k}px, ${-sy * k}px) scale(${k})` }}>{children}</div>
        </ZoomContext.Provider>
      </div>
      <div style={{ position: "absolute", inset: -2, border: `2px solid ${outline}`, pointerEvents: "none" }} />
      {tag ? <Tag text={tag} /> : null}
    </div>
  );
};

/** A small label sitting on the top-left corner of an outline, like a fieldset legend. */
export const Tag: React.FC<{ text: string; color?: string }> = ({ text, color = C.white }) => (
  <div style={{ position: "absolute", left: 18, top: -17, padding: "2px 10px", background: C.bg, color, fontFamily: MONO, fontWeight: 700, fontSize: 20, letterSpacing: 2, lineHeight: "28px", whiteSpace: "nowrap" }}>{text}</div>
);

/** Mouse pointer, placed in app pixels and kept the same size on screen whatever the zoom. */
export const Cursor: React.FC<{ path: Key[]; clicks?: number[]; from: number; to: number }> = ({ path, clicks = [], from, to }) => {
  const frame = useCurrentFrame();
  const k = useZoom();
  const t = frame / FPS;
  if (t < from || t >= to) return null;
  const [x, y] = track(frame, path, 0.45);
  const press = clicks.reduce((s, at) => s * (2 - pop(frame, at - 0.03, 0.18, 0.2)), 1);
  return (
    <div style={{ position: "absolute", left: x, top: y, transformOrigin: "0 0", transform: `scale(${press / k})` }}>
      {clicks.map((at) => {
        const p = ramp(frame, at, 0.3);
        return p > 0 && p < 1 ? <div key={at} style={{ position: "absolute", left: -30 * p - 14, top: -30 * p - 14, width: 28 + 60 * p, height: 28 + 60 * p, border: `3px solid ${C.white}`, opacity: 1 - p }} /> : null;
      })}
      <svg width={44} height={44} viewBox="0 0 22 22" style={{ position: "absolute", left: -4, top: -3, overflow: "visible" }}>
        <path d="M3 2 L3 17 L7.2 13.2 L10 19.4 L12.6 18.2 L9.9 12.2 L15.4 12.2 Z" fill={C.white} stroke={C.bg} strokeWidth={1.4} strokeLinejoin="round" />
      </svg>
    </div>
  );
};

const CHAR = 0.6; // IBM Plex Mono: every character is 0.6 em wide

export const chipWidth = (text: string, size: number) => Math.round(size * (2.6 + 0.3 + text.length * CHAR + (text.length - 1) * 0.06));

/** A small outlined name with a colour square; `lit` 0..1 fills the square and brightens the outline. */
export const Chip: React.FC<{ text: string; color: string; size: number; lit: number; scale?: number; style?: React.CSSProperties }> = ({ text, color, size, lit, scale = 1, style }) => (
  <div
    style={{
      position: "absolute",
      width: chipWidth(text, size),
      height: Math.round(size * 2.2),
      boxSizing: "border-box",
      border: `2px solid ${lit > 0.5 ? C.white : "#5A5A5A"}`,
      background: C.bg,
      display: "flex",
      alignItems: "center",
      gap: size * 0.5,
      paddingLeft: size * 0.7,
      fontFamily: MONO,
      fontWeight: 700,
      fontSize: size,
      letterSpacing: size * 0.06,
      color: lit > 0.5 ? C.white : C.dim,
      transform: `scale(${scale})`,
      ...style,
    }}
  >
    <div style={{ width: size * 0.7, height: size * 0.7, boxSizing: "border-box", border: `2px solid ${color}`, background: lit > 0.5 ? color : "transparent", flexShrink: 0 }} />
    {text}
  </div>
);

/** Where each chip of a row set goes: rows centred on `centerX`. */
export const chipSpots = (names: readonly string[], rows: number[][], size: number, centerX: number, y: number, rowGap: number) => {
  const gap = Math.round(size * 0.6);
  const spots: { x: number; y: number; w: number; h: number }[] = [];
  rows.forEach((row, line) => {
    const widths = row.map((i) => chipWidth(names[i], size));
    let x = centerX - (widths.reduce((a, b) => a + b, 0) + gap * (row.length - 1)) / 2;
    row.forEach((i, n) => {
      spots[i] = { x: Math.round(x), y: y + line * (Math.round(size * 2.2) + rowGap), w: widths[n], h: Math.round(size * 2.2) };
      x += widths[n] + gap;
    });
  });
  return spots;
};

/** The five platform chips. `litAt[i]` is when chip i lights up (undefined: stays dim). */
export const PlatformChips: React.FC<{ from: number; to: number; litAt: (number | undefined)[]; enter?: number }> = ({ from, to, litAt, enter = 0.25 }) => {
  const L = useLayout();
  const frame = useCurrentFrame();
  const t = frame / FPS;
  if (t < from || t >= to) return null;
  const spots = chipSpots(PLATFORMS.map((p) => p.name), L.chips.rows, L.chips.size, L.chips.centerX, L.chips.y, L.chips.rowGap);
  return (
    <>
      {PLATFORMS.map((p, i) => {
        const at = litAt[i];
        const lit = at === undefined ? 0 : t >= at ? 1 : 0;
        return <Chip key={p.name} text={p.name} color={p.color} size={L.chips.size} lit={lit} scale={at === undefined ? 1 : pop(frame, at, 0.12)} style={{ left: spots[i].x, top: spots[i].y, opacity: ramp(frame, from + i * 0.04, enter) }} />;
      })}
    </>
  );
};

/** Wordmark and the label of the current part. */
export const TopBar: React.FC<{ from: number; to: number }> = ({ from, to }) => {
  const L = useLayout();
  const frame = useCurrentFrame();
  const t = frame / FPS;
  if (t < from || t >= to) return null;
  const label = LABELS.find((l) => t >= l.from && t < l.to);
  const size = L.top.wordmarkSize;
  const slide = label ? ramp(frame, label.from, 0.3, easeOut) : 1;
  const right = L.top.label.align === "right";
  return (
    <>
      <div style={{ position: "absolute", left: L.text.left, top: L.top.wordmarkY, height: size * 1.5, display: "flex", alignItems: "center", gap: size * 0.4, opacity: ramp(frame, from, 0.3) }}>
        <Img src={staticFile("images/icon.png")} style={{ width: size * 1.5, height: size * 1.5 }} />
        <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: size, color: C.white, letterSpacing: 1 }}>BUDDYSOCIALS</div>
      </div>
      {label ? (
        <div
          style={{
            position: "absolute",
            top: L.top.label.y,
            ...(right ? { right: L.width - L.top.label.x } : { left: L.top.label.x }),
            height: right ? size * 1.5 : undefined,
            display: "flex",
            alignItems: "baseline",
            gap: L.top.label.size * 0.35,
            transform: `translateY(${(1 - slide) * 14}px)`,
            opacity: slide,
            whiteSpace: "nowrap",
            lineHeight: right ? `${size * 1.5}px` : 1.1,
          }}
        >
          <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: Math.max(22, L.top.label.size * 0.42), color: C.coral }}>{label.index}</span>
          <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: L.top.label.size, color: C.white }}>{label.text}</span>
        </div>
      ) : null}
    </>
  );
};
