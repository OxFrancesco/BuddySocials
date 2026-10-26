/** Lays the voice lines on the video's clock into one wav, for effect levels. */
import { lineStarts, voice } from "../src/timeline";
const out = process.argv[2] ?? "/tmp/voice.wav";
const inputs = voice.flatMap((line) => ["-i", `public/${line.src}`]);
const delays = lineStarts.map((t, i) => `[${i}:a]adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)}[a${i}]`).join(";");
const mix = `${lineStarts.map((_, i) => `[a${i}]`).join("")}amix=inputs=${lineStarts.length}:normalize=0[out]`;
const result = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", ...inputs, "-filter_complex", `${delays};${mix}`, "-map", "[out]", "-ar", "48000", out]);
if (result.exitCode !== 0) throw new Error(result.stderr.toString());
console.log(out);
