// Every word on screen, every timing and every sound cue of the video lives here.
// Times are seconds from the start of the video. The music is exactly 120 BPM, so a beat is
// 0.5 s (15 frames) and a bar is 2 s: scenes start on bars, and the drums come in at 16 s.

export const FPS = 30;
export const f = (seconds: number) => Math.round(seconds * FPS);
export const DURATION = 57.5;

export const SCENES = {
  hook: { from: 0, to: 6 },
  board: { from: 6, to: 24 },
  posts: { from: 24, to: 28 },
  publish: { from: 28, to: 36 },
  inbox: { from: 36, to: 42 },
  apps: { from: 42, to: 51 },
  end: { from: 51, to: DURATION },
} as const;

// Narration: ElevenLabs, voice "Chris", one take per line. `speech` is how long the words last.
export const VOICE = [
  { id: "01-hook", at: 0.6, speech: 4.5, text: "Five platforms. Five dashboards. Five tabs you never close." },
  { id: "02-board", at: 6.3, speech: 8.4, text: "BuddySocials puts them all on one board. YouTube, Instagram, TikTok, X and LinkedIn. Every account, side by side." },
  { id: "03-yours", at: 16.1, speech: 7.6, text: "And the board is yours. Pick your widgets, resize them, and drag them into place on your phone. The desktop follows in real time." },
  { id: "04-posts", at: 24.4, speech: 2.6, text: "Every post shows the numbers its own platform reports." },
  { id: "05-publish", at: 28.2, speech: 7.1, text: "Write a post once. Add a picture or a video, crop it, choose your accounts, and publish to all of them at once." },
  { id: "06-inbox", at: 36.2, speech: 5.3, text: "Comments from every platform land in one inbox. And goals tell you if you're on pace." },
  { id: "07-apps", at: 42.2, speech: 8.4, text: "It runs on macOS and Linux, and it updates itself. On Android, seven resizable widgets put your numbers right on the home screen." },
  { id: "08-end", at: 51.4, speech: 3.7, text: "BuddySocials. All your socials, on a board you built." },
] as const;

// When each spoken word that drives a picture is heard (from the narration's own timings).
export const CUE = {
  platforms: 0.6,
  dashboards: 2.14,
  tabs: 3.55,
  oneBoard: 6.0,
  names: [8.74, 9.32, 10.14, 11.11, 11.71], // YouTube, Instagram, TikTok, X, LinkedIn
  everyAccount: 12.95,
  yours: 16.0,
  pick: 17.67,
  resize: 18.85,
  drag: 19.72,
  follows: 21.95,
  numbers: 25.3,
  typeFrom: 28.25,
  typeTo: 29.65,
  add: 29.8,
  picture: 30.07,
  edit: 31.2,
  crop: 31.4,
  useImage: 32.0,
  choose: 32.17,
  accounts: [32.35, 32.7, 33.05],
  publish: 34.0,
  published: 34.2,
  everyPlatform: 36.89,
  caughtUp: 38.07,
  goals: 39.3,
  macos: 42.69,
  linux: 43.35,
  updates: 43.9,
  update: 44.5,
  android: 45.5,
  seven: 46.47,
  resizable: 46.9,
  brand: 51.0,
  tagline: 52.75,
  everywhere: 54.1,
} as const;

export const PLATFORMS = [
  { name: "YOUTUBE", color: "#FF4D4D" },
  { name: "INSTAGRAM", color: "#E1449B" },
  { name: "TIKTOK", color: "#2EE6E0" },
  { name: "X", color: "#F2F2F2" },
  { name: "LINKEDIN", color: "#4C8DFF" },
] as const;

export const HOOK_LINES = [
  { at: 0, text: ["5 PLATFORMS."] },
  { at: CUE.dashboards, text: ["5 DASHBOARDS."] },
  { at: CUE.tabs, text: ["5 TABS YOU", "NEVER CLOSE."] },
];

// The label next to the wordmark: what the picture is showing right now.
export const LABELS = [
  { from: 6, to: 16, index: "01", text: "ONE BOARD" },
  { from: 16, to: 24, index: "02", text: "YOUR LAYOUT" },
  { from: 24, to: 28, index: "03", text: "EVERY POST" },
  { from: 28, to: 36, index: "04", text: "WRITE ONCE" },
  { from: 36, to: CUE.goals, index: "05", text: "ONE INBOX" },
  { from: CUE.goals, to: 42, index: "06", text: "GOALS" },
  { from: 42, to: CUE.android, index: "07", text: "MACOS + LINUX" },
  { from: CUE.android, to: 51, index: "08", text: "ANDROID" },
];

export const TAGS = { desktop: "DESKTOP", phone: "PHONE", android: "ANDROID APP", widgets: "7 HOME SCREEN WIDGETS" };

export const END = {
  wordmark: "BUDDYSOCIALS",
  tagline: ["ALL YOUR SOCIALS,", "ON A BOARD YOU BUILT."],
  where: ["MACOS", "LINUX", "ANDROID"],
};

// The phone beside the desktop: pieces of the real screen recording, each starting on its word.
// `clip` is where the piece starts in public/clips/customise.mp4.
export const PHONE_CUTS = [
  { at: 16.0, clip: 4.3 }, // edit mode switches on
  { at: 17.55, clip: 42.5 }, // the add-widget sheet opens
  { at: 18.75, clip: 9.45 }, // a widget is resized
  { at: 19.65, clip: 67.0 }, // a widget is dragged above another
  { at: 24, clip: 0 },
];

export const DRAFT_TEXT_CHARS = 66; // "Shipping the desktop app this week. Same dashboard, bigger screen."

// Sound effects, all from the attentionmachine skill's assets/sounds. `at` is the moment the
// loudest point of the sound should land; `peak` is where that point sits in the file.
export const PEAK = { click: 0.278, pop: 0.023, "swoosh-in": 0.308, "swoosh-out": 0.128, thud: 0.028, ding: 0.006, typing: 0 } as const;
export type Effect = keyof typeof PEAK;
export const SFX: { at: number; file: Effect; trim?: [number, number] }[] = [
  { at: CUE.platforms, file: "pop" },
  { at: CUE.dashboards + 0.15, file: "swoosh-in" },
  { at: CUE.tabs + 0.15, file: "swoosh-in" },
  { at: CUE.oneBoard, file: "thud" },
  ...CUE.names.map((at) => ({ at, file: "click" as const })),
  { at: CUE.yours + 0.25, file: "swoosh-in" },
  { at: CUE.pick + 0.1, file: "pop" },
  { at: CUE.resize + 0.2, file: "swoosh-out" },
  { at: CUE.drag + 0.25, file: "swoosh-in" },
  { at: CUE.numbers, file: "pop" },
  { at: CUE.typeFrom, file: "typing", trim: [0.9, 0.9 + CUE.typeTo - CUE.typeFrom] },
  { at: CUE.add, file: "click" },
  { at: CUE.edit, file: "click" },
  { at: CUE.useImage, file: "click" },
  ...CUE.accounts.map((at) => ({ at, file: "click" as const })),
  { at: CUE.publish, file: "click" },
  { at: CUE.published, file: "ding" },
  { at: CUE.caughtUp, file: "pop" },
  { at: CUE.goals + 0.3, file: "swoosh-in" },
  { at: CUE.macos, file: "pop" },
  { at: CUE.linux, file: "pop" },
  { at: CUE.update, file: "click" },
  { at: CUE.android + 0.25, file: "swoosh-in" },
  { at: CUE.seven, file: "pop" },
  { at: CUE.resizable + 0.2, file: "swoosh-out" },
  { at: CUE.brand + 0.1, file: "thud" },
  { at: CUE.everywhere, file: "pop" },
];

// Music: ElevenLabs Music, one generation, 60 s at 120 BPM. Quiet intro until the drums at 16 s,
// softer again from 48 s, last chord rings out by 57 s. Levels are per section; it also dips a
// little under every spoken line.
export const MUSIC = {
  sections: [
    { from: 0, volume: 0.8 },
    { from: 15.9, volume: 0.3 },
    { from: 47.9, volume: 0.44 },
  ],
  underVoice: 0.62,
  ramp: 0.3,
};
