/**
 * Every timing in the video lives here: voice lines, which footage plays
 * under them, headlines and sound cues. Change a number here and everything
 * that depends on it moves with it.
 */
import l1 from "../public/voice/01-hook.json";
import l2 from "../public/voice/02-home.json";
import l3 from "../public/voice/03-customise.json";
import l4 from "../public/voice/04-post.json";
import l5 from "../public/voice/05-inbox.json";
import l6 from "../public/voice/06-goals.json";
import l7 from "../public/voice/07-widgets.json";
import l8 from "../public/voice/08-end.json";

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;

const s = (seconds: number) => Math.round(seconds * FPS);

type Word = { word: string; start: number; end: number };
type Line = { text: string; words: Word[] };
const lines: Line[] = [l1, l2, l3, l4, l5, l6, l7, l8];

/** Silence between voice lines, in seconds. */
const GAPS = [0.35, 0.3, 0.35, 0.3, 0.3, 0.45, 0.6, 0];
const LEAD_IN = 0.3;

/** Absolute start of each voice line, in seconds. */
export const lineStarts: number[] = [];
{
  let t = LEAD_IN;
  lines.forEach((line, i) => {
    lineStarts.push(t);
    t += line.words.at(-1)!.end + GAPS[i]!;
  });
}

export const voice = lines.map((line, i) => ({
  src: `voice/0${i + 1}-${["hook", "home", "customise", "post", "inbox", "goals", "widgets", "end"][i]}.mp3`,
  from: s(lineStarts[i]!),
}));

/** Word timings on the video's own clock, for captions and word-locked cues. */
export const words = lines.flatMap((line, i) => line.words.map((w) => ({ ...w, start: w.start + lineStarts[i]!, end: w.end + lineStarts[i]! })));

const wordAt = (line: number, word: string) => {
  const found = lines[line]!.words.find((w) => w.word.replace(/[^\w']/g, "").toLowerCase() === word.toLowerCase());
  if (!found) throw new Error(`No word "${word}" in line ${line + 1}`);
  return lineStarts[line]! + found.start;
};

const lineEnd = (line: number) => lineStarts[line]! + lines[line]!.words.at(-1)!.end;

/** A piece of phone footage: `source` seconds in the recording, starting at `at` on the video clock. */
export type Shot = { clip: string; at: number; source: number; length: number };

function chain(clip: string, at: number, pieces: [number, number][]): Shot[] {
  let t = at;
  return pieces.map(([from, to]) => {
    const shot = { clip, at: t, source: from, length: to - from };
    t += to - from;
    return shot;
  });
}

const homeAt = wordAt(0, "One");
const customiseAt = lineStarts[2]! - 0.1;
const customise = chain("customise", customiseAt, [
  [3.2, 4.4], // edit mode
  [9.1, 10.4], // resize
  [27.1, 28.3], // change the metric
  [42.3, 43.4], // add widget gallery
  [67.0, 69.3], // drag to reorder
]);
const postAt = customise.at(-1)!.at + customise.at(-1)!.length;
const post = chain("post", postAt, [[10.4, 10.4 + (lineStarts[4]! - 0.1 - postAt)]]);
const inboxAt = lineStarts[4]! - 0.1;
const inbox = chain("inbox", inboxAt, [
  [2.4, 3.8],
  [10.6, 12.6],
  [14.3, 14.3 + Math.max(0.6, lineStarts[5]! - 0.1 - (inboxAt + 3.4))],
]);
const goalsAt = lineStarts[5]! - 0.1;
const celebrateAt = wordAt(5, "Hit") - 0.35;
const goals = chain("goals", goalsAt, [
  [2.75, 2.75 + (celebrateAt - goalsAt)],
  [23.35, 23.35 + (lineStarts[6]! - 0.15 - celebrateAt)],
]);

export const shots: Shot[] = [
  { clip: "home", at: homeAt, source: 0.9, length: customiseAt - homeAt },
  ...customise,
  ...post,
  ...inbox,
  ...goals,
];

export const sections = {
  brand: { from: 0, to: homeAt },
  phone: { from: homeAt, to: lineStarts[6]! - 0.15 },
  widgets: { from: lineStarts[6]! - 0.15, to: lineStarts[7]! - 0.1 },
  end: { from: lineStarts[7]! - 0.1, to: lineEnd(7) + 1.4 },
};

/** Headlines over the phone, each from its section's first frame. */
export const headlines = [
  { at: homeAt, text: "One home", accent: "home" },
  { at: customiseAt, text: "Made of widgets", accent: "widgets" },
  { at: postAt, text: "Native numbers", accent: "numbers" },
  { at: inboxAt, text: "One inbox", accent: "inbox" },
  { at: goalsAt, text: "Goals", accent: "Goals" },
];

/** Platform names light up as they're spoken on the brand card. */
export const platformCues = ["YouTube", "Instagram", "TikTok", "X", "LinkedIn"].map((name) => ({
  name,
  at: wordAt(0, name.replace(/[^\w]/g, "")),
}));

/** Widgets arrive one by one; the Platforms widget grows on "grow". */
export const widgetCues = {
  start: sections.widgets.from + 0.2,
  stagger: 0.4,
  growAt: wordAt(6, "grow"),
};

export const sounds = [
  { src: "sounds/thud.wav", at: 0.35 },
  { src: "sounds/swoosh-in.wav", at: homeAt - 0.12 },
  ...customise.slice(1).map((shot) => ({ src: "sounds/click.wav", at: shot.at + 0.25 })),
  { src: "sounds/ding.wav", at: celebrateAt + 0.15 },
  ...Array.from({ length: 3 }, (_, i) => ({ src: "sounds/pop.wav", at: widgetCues.start + i * widgetCues.stagger })),
  { src: "sounds/swoosh-in.wav", at: widgetCues.growAt - 0.1 },
  { src: "sounds/thud.wav", at: sections.end.from + 0.05 },
];

export const DURATION = s(sections.end.to);
export const frames = s;
