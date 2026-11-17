import { Easing, interpolate } from "remotion";
import { FPS } from "./data";

export const easeOut = Easing.bezier(0.22, 1, 0.36, 1); // entrances
export const easeIn = Easing.bezier(0.64, 0, 0.78, 0); // exits
export const easeInOut = Easing.bezier(0.76, 0, 0.24, 1); // camera moves (in-out quart)

/** 0 → 1 over `duration` seconds starting at `start` seconds. `frame` is the video's frame. */
export const ramp = (frame: number, start: number, duration: number, easing = easeOut) =>
  interpolate(frame, [start * FPS, (start + duration) * FPS], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing });

/** A quick pop: 1 → 1 + amount → 1 around `at`. */
export const pop = (frame: number, at: number, amount = 0.08, seconds = 0.2) => {
  const t = (frame / FPS - at) / seconds;
  return t <= 0 || t >= 1 ? 1 : 1 + amount * Math.sin(Math.PI * t);
};

export type Key = [seconds: number, values: number[], glide?: number];

/** Values that hold on each key and glide to the next one over the last `glide` seconds before it. */
export const track = (frame: number, keys: Key[], glide = 0.7, easing = easeInOut): number[] => {
  const t = frame / FPS;
  let current = keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [at, next, own] = keys[i];
    const start = Math.max(at - (own ?? glide), keys[i - 1][0]);
    if (t <= start) break;
    const p = at === start ? 1 : easing(Math.min(1, (t - start) / (at - start)));
    current = current.map((v, n) => v + (next[n] - v) * p);
    if (t < at) break;
  }
  return current;
};

export const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
