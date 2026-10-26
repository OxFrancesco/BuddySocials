import { Easing } from "react-native-reanimated";

/**
 * oddofrancesco.com/design: black, white and one coral. Grey only exists as a
 * 1–3px outline. Text never goes grey; it recedes with opacity (60% floor).
 */
export const color = {
  bg: "#000000",
  fg: "#FFFFFF",
  coral: "#D6544B",
  line: "#292929",
  dim: "rgba(255,255,255,0.7)",
  faint: "rgba(255,255,255,0.6)",
} as const;

/** Chakra Petch carries headings in uppercase; IBM Plex Mono carries every sentence, label and number. */
export const font = {
  display: "ChakraPetch-Bold",
  mono: "IBMPlexMono-Regular",
  monoBold: "IBMPlexMono-Bold",
} as const;

/** 4px base. Cards pad 24 on the web; phone tiles use 16. Grids gap 16 → 12 on the cover screen. */
export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 } as const;

export const motion = {
  easeOut: Easing.bezier(0.23, 1, 0.32, 1),
  easeInOut: Easing.bezier(0.77, 0, 0.175, 1),
  ui: 200,
  press: 120,
} as const;

/** Width at which the Fold counts as open: 4 grid columns and two-pane screens. */
export const WIDE = 600;
