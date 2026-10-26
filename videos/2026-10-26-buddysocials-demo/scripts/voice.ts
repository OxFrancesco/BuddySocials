/**
 * Generates the voiceover, one file per line, with word timings for captions.
 * Reads ELEVENLABS_API_KEY from the repo's .attentionmachine/.env.
 * Usage: bun scripts/voice.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LINES, VOICE_ID } from "../src/script";

const env = readFileSync(join(import.meta.dir, "../../../.attentionmachine/.env"), "utf8");
const key = env.match(/^ELEVENLABS_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error("ELEVENLABS_API_KEY missing from .attentionmachine/.env");

type Alignment = { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };

function words(text: string, alignment: Alignment) {
  const out: { word: string; start: number; end: number }[] = [];
  let current = "";
  let start = 0;
  alignment.characters.forEach((char, index) => {
    if (char === " ") {
      if (current) out.push({ word: current, start, end: alignment.character_end_times_seconds[index - 1]! });
      current = "";
      return;
    }
    if (!current) start = alignment.character_start_times_seconds[index]!;
    current += char;
  });
  if (current) out.push({ word: current, start, end: alignment.character_end_times_seconds.at(-1)! });
  return out;
}

async function line(id: string, text: string) {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps?output_format=mp3_44100_192`, {
    method: "POST",
    headers: { "xi-api-key": key!, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true },
    }),
  });
  if (!response.ok) throw new Error(`${id}: ${response.status} ${await response.text()}`);
  const data = (await response.json()) as { audio_base64: string; alignment: Alignment };
  await Bun.write(join(import.meta.dir, "../public/voice", `${id}.mp3`), Buffer.from(data.audio_base64, "base64"));
  const timing = words(text, data.alignment);
  await Bun.write(join(import.meta.dir, "../public/voice", `${id}.json`), JSON.stringify({ text, words: timing }, null, 2));
  console.log(`${id}  ${timing.at(-1)!.end.toFixed(2)}s`);
}

// The free plan allows two requests at a time.
for (let i = 0; i < LINES.length; i += 2) {
  await Promise.all(LINES.slice(i, i + 2).map((entry) => line(entry.id, entry.text)));
}
