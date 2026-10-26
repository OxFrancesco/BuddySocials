/** George: warm, steady, not salesy. */
export const VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

/** One line per section. Text, timings and sound cues all live in this folder's data files. */
export const LINES = [
  { id: "01-hook", text: "BuddySocials. YouTube, Instagram, TikTok, X and LinkedIn. One home screen." },
  { id: "02-home", text: "Every chart is dithered. One colour. No noise." },
  { id: "03-customise", text: "The home is made of widgets. Resize one, change what it measures, add more, drag them anywhere." },
  { id: "04-post", text: "Open a post and you get the numbers that platform's own dashboard shows." },
  { id: "05-inbox", text: "Comments from all five land in one inbox. Reply right there." },
  { id: "06-goals", text: "Set goals. The pace line tells you when you're behind. Hit one, and you'll know." },
  { id: "07-widgets", text: "It lives on your home screen too. Six widgets that grow when you resize them." },
  { id: "08-end", text: "BuddySocials. Built on Leo's Social SDK." },
] as const;

export type LineId = (typeof LINES)[number]["id"];
