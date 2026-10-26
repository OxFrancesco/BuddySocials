import { loadFont } from "@remotion/fonts";
import { Video } from "@remotion/media";
import { AbsoluteFill, Audio, Easing, Img, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import volumes from "./volumes.json";
import {
  FPS,
  frames,
  headlines,
  platformCues,
  sections,
  shots,
  sounds,
  voice,
  widgetCues,
  words,
} from "./timeline";

/* oddofrancesco.com/design: black, white, one coral. Chakra Petch for headings, IBM Plex Mono for everything else. */
const BG = "#000000";
const FG = "#FFFFFF";
const CORAL = "#D6544B";
const LINE = "#292929";
const DISPLAY = "Chakra Petch";
const MONO = "IBM Plex Mono";

void loadFont({ family: DISPLAY, url: staticFile("fonts/ChakraPetch-Bold.ttf"), weight: "700" });
void loadFont({ family: MONO, url: staticFile("fonts/IBMPlexMono-Regular.ttf"), weight: "400" });
void loadFont({ family: MONO, url: staticFile("fonts/IBMPlexMono-Bold.ttf"), weight: "700" });

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/** Phone recordings are 1248x1972; the status bar (top 105px) and gesture bar (bottom 40px) are cropped off. */
const SOURCE = { width: 1248, height: 1972, top: 105, bottom: 40 };
const PHONE_WIDTH = 860;
const SCALE = PHONE_WIDTH / SOURCE.width;
const PHONE_HEIGHT = Math.round((SOURCE.height - SOURCE.top - SOURCE.bottom) * SCALE);
const PHONE_TOP = 300;
const SHADOW = 10;

const sec = (frame: number) => frame / FPS;

function entrance(frame: number, at: number, duration = 0.35) {
  return interpolate(sec(frame), [at, at + duration], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_OUT });
}

/* ------------------------------------------------------------------ brand */

function Brand() {
  const frame = useCurrentFrame();
  const icon = entrance(frame, 0.15, 0.5);
  const title = entrance(frame, 0.35, 0.3);
  return (
    <AbsoluteFill style={{ backgroundColor: BG, alignItems: "center", justifyContent: "center", gap: 56 }}>
      {/* The icon builds up from the baseline, like the dithered bars in it. */}
      <div style={{ width: 300, height: 300, overflow: "hidden", clipPath: `inset(${(1 - icon) * 100}% 0 0 0)` }}>
        <Img src={staticFile("images/icon.png")} style={{ width: 300, height: 300 }} />
      </div>
      <div
        style={{
          fontFamily: DISPLAY,
          fontSize: 112,
          letterSpacing: -2.8,
          color: FG,
          textTransform: "uppercase",
          opacity: title,
          transform: `scale(${0.96 + 0.04 * title})`,
        }}
      >
        BuddySocials
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 18, width: 900 }}>
        {platformCues.map((cue) => {
          const on = sec(frame) >= cue.at;
          return (
            <div
              key={cue.name}
              style={{
                fontFamily: MONO,
                fontWeight: 700,
                fontSize: 34,
                letterSpacing: 2,
                textTransform: "uppercase",
                padding: "10px 20px",
                border: `3px solid ${on ? CORAL : LINE}`,
                backgroundColor: on ? CORAL : "transparent",
                color: on ? BG : FG,
                opacity: on ? 1 : 0.6,
              }}
            >
              {cue.name}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

/* ------------------------------------------------------------------ phone */

function Headline() {
  const frame = useCurrentFrame();
  const t = sec(frame) + sections.phone.from;
  const current = [...headlines].reverse().find((headline) => t >= headline.at);
  if (!current) return null;
  const pop = entrance(frame, current.at - sections.phone.from, 0.25);
  const parts = current.text.split(new RegExp(`(${current.accent})`, "i"));
  return (
    <div
      style={{
        position: "absolute",
        top: 150,
        width: "100%",
        textAlign: "center",
        fontFamily: DISPLAY,
        fontSize: 84,
        letterSpacing: -2,
        textTransform: "uppercase",
        color: FG,
        opacity: pop,
        transform: `scale(${0.96 + 0.04 * pop})`,
      }}
    >
      {parts.map((part, i) => (
        <span key={i} style={{ color: part.toLowerCase() === current.accent.toLowerCase() ? CORAL : FG }}>
          {part}
        </span>
      ))}
    </div>
  );
}

function Phone() {
  const frame = useCurrentFrame();
  const arrive = entrance(frame, 0, 0.45);
  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      <Headline />
      <div
        style={{
          position: "absolute",
          left: (1080 - PHONE_WIDTH) / 2,
          top: PHONE_TOP,
          width: PHONE_WIDTH + SHADOW,
          height: PHONE_HEIGHT + SHADOW,
          opacity: arrive,
          transform: `translateY(${(1 - arrive) * 60}px)`,
        }}
      >
        {/* The design system's hard shadow: a solid white block, offset. */}
        <div style={{ position: "absolute", left: SHADOW, top: SHADOW, width: PHONE_WIDTH, height: PHONE_HEIGHT, backgroundColor: FG }} />
        <div style={{ position: "absolute", left: 0, top: 0, width: PHONE_WIDTH, height: PHONE_HEIGHT, overflow: "hidden", backgroundColor: BG, outline: `3px solid ${FG}` }}>
          {shots.map((shot, i) => (
            <Sequence key={i} from={frames(shot.at - sections.phone.from)} durationInFrames={Math.max(1, frames(shot.length))} layout="none">
              <Video
                src={staticFile(`clips/${shot.clip}.mp4`)}
                trimBefore={frames(shot.source)}
                muted
                style={{ position: "absolute", left: 0, top: -SOURCE.top * SCALE, width: SOURCE.width * SCALE, height: SOURCE.height * SCALE }}
              />
            </Sequence>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
}

/* ---------------------------------------------------------------- widgets */

/** Real captures from the Fold's home screen, one column. */
const SCALE_W = 0.72;
const WIDE = { w: 1042 * SCALE_W, h: 492 * SCALE_W };
const TALL_H = 770 * SCALE_W;
const GAP = 28;
const LEFT = (1080 - WIDE.w) / 2;

function Tile({ src, x, y, w, h, at, children }: { src?: string; x: number; y: number; w: number; h: number; at: number; children?: React.ReactNode }) {
  const frame = useCurrentFrame();
  const pop = entrance(frame, at, 0.3);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        borderRadius: 26,
        overflow: "hidden",
        backgroundColor: BG,
        opacity: pop,
        transform: `scale(${0.92 + 0.08 * pop})`,
      }}
    >
      {src ? <Img src={staticFile(src)} style={{ width: w, height: h }} /> : children}
    </div>
  );
}

function Widgets() {
  const frame = useCurrentFrame();
  const t = sec(frame) + sections.widgets.from;
  const at = (i: number) => widgetCues.start + i * widgetCues.stagger - sections.widgets.from;
  // Platforms grows to its expanded layout when the voice says "grow"; Goals below moves with it.
  const grow = interpolate(t, [widgetCues.growAt, widgetCues.growAt + 0.45], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.77, 0, 0.175, 1),
  });
  const row1 = 300;
  const row2 = row1 + WIDE.h + GAP;
  const platformsH = WIDE.h + (TALL_H - WIDE.h) * grow;
  const row3 = row2 + platformsH + GAP;
  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      <div style={{ position: "absolute", top: 150, width: "100%", textAlign: "center", fontFamily: DISPLAY, fontSize: 84, letterSpacing: -2, textTransform: "uppercase", color: FG }}>
        On your <span style={{ color: CORAL }}>home screen</span>
      </div>
      <Tile src="images/widget-views.png" x={LEFT} y={row1} w={WIDE.w} h={WIDE.h} at={at(0)} />
      <Tile x={LEFT} y={row2} w={WIDE.w} h={platformsH} at={at(1)}>
        <Img src={staticFile("images/widget-platforms.png")} style={{ position: "absolute", width: WIDE.w, height: WIDE.h, opacity: 1 - grow }} />
        <Img src={staticFile("images/widget-platforms-tall.png")} style={{ position: "absolute", width: WIDE.w, height: TALL_H, opacity: grow }} />
      </Tile>
      <Tile src="images/widget-goals.png" x={LEFT} y={row3} w={WIDE.w} h={WIDE.h} at={at(2)} />
    </AbsoluteFill>
  );
}

/* -------------------------------------------------------------------- end */

function End() {
  const frame = useCurrentFrame();
  const a = entrance(frame, 0.05, 0.3);
  const b = entrance(frame, 0.25, 0.3);
  return (
    <AbsoluteFill style={{ backgroundColor: BG, alignItems: "center", justifyContent: "center", gap: 48 }}>
      <Img src={staticFile("images/icon.png")} style={{ width: 260, height: 260, opacity: a }} />
      <div style={{ fontFamily: DISPLAY, fontSize: 112, letterSpacing: -2.8, color: FG, textTransform: "uppercase", opacity: a, transform: `scale(${0.96 + 0.04 * a})` }}>
        BuddySocials
      </div>
      <div style={{ fontFamily: MONO, fontSize: 38, color: FG, opacity: b }}>
        Built on Leo's <span style={{ color: CORAL }}>Social SDK</span>
      </div>
    </AbsoluteFill>
  );
}

/* --------------------------------------------------------------- captions */

/** Short phrases, the whole phrase at once, in time with the voice. No full stops or commas. */
const phrases = (() => {
  const out: { text: string; start: number; end: number }[] = [];
  let current: typeof words = [];
  const flush = () => {
    if (current.length === 0) return;
    out.push({
      text: current.map((w) => w.word).join(" ").replace(/[.,]/g, ""),
      start: current[0]!.start,
      end: current.at(-1)!.end,
    });
    current = [];
  };
  for (const word of words) {
    current.push(word);
    if (/[.,!?]$/.test(word.word) || current.length >= 4) flush();
  }
  flush();
  return out.map((phrase, i) => ({ ...phrase, end: Math.min(out[i + 1]?.start ?? phrase.end + 0.6, phrase.end + 0.6) }));
})();

function Captions() {
  const frame = useCurrentFrame();
  const t = sec(frame);
  // The brand and end cards say the name on screen already.
  if (t < sections.brand.to || t >= sections.end.from) return null;
  const phrase = phrases.find((p) => t >= p.start && t < p.end);
  if (!phrase) return null;
  return (
    <div style={{ position: "absolute", bottom: 150, width: "100%", display: "flex", justifyContent: "center" }}>
      <div style={{ fontFamily: MONO, fontSize: 46, color: FG, backgroundColor: BG, padding: "8px 20px", maxWidth: 960, textAlign: "center" }}>{phrase.text}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ video */

export function Demo() {
  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      <Sequence from={frames(sections.brand.from)} durationInFrames={frames(sections.brand.to - sections.brand.from)}>
        <Brand />
      </Sequence>
      <Sequence from={frames(sections.phone.from)} durationInFrames={frames(sections.phone.to - sections.phone.from)}>
        <Phone />
      </Sequence>
      <Sequence from={frames(sections.widgets.from)} durationInFrames={frames(sections.widgets.to - sections.widgets.from)}>
        <Widgets />
      </Sequence>
      <Sequence from={frames(sections.end.from)} durationInFrames={frames(sections.end.to - sections.end.from)}>
        <End />
      </Sequence>
      <Captions />
      {voice.map((line) => (
        <Sequence key={line.src} from={line.from} layout="none">
          <Audio src={staticFile(line.src)} />
        </Sequence>
      ))}
      {sounds.map((sound, i) => (
        <Sequence key={i} from={Math.max(0, frames(sound.at))} layout="none">
          <Audio src={staticFile(sound.src)} volume={(volumes as Record<string, number>)[sound.src.split("/").pop()!] ?? 0.3} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
