import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

export const C = { bg: "#000000", white: "#FFFFFF", coral: "#D6544B", line: "#292929", dim: "#A6A6A6" };
export const DISPLAY = "Chakra Petch";
export const MONO = "IBM Plex Mono";

loadFont({ family: DISPLAY, url: staticFile("fonts/ChakraPetch-Bold.ttf"), weight: "700" });
loadFont({ family: MONO, url: staticFile("fonts/IBMPlexMono-Regular.ttf"), weight: "400" });
loadFont({ family: MONO, url: staticFile("fonts/IBMPlexMono-Bold.ttf"), weight: "700" });
