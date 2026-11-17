import React from "react";
import { Audio } from "@remotion/media";
import { Sequence, staticFile } from "remotion";
import { DURATION, f, FPS, MUSIC, PEAK, SFX, VOICE } from "./data";
import volumes from "./volumes.json";

// Music level at a frame: the section's level, a little lower under every spoken line, and a fade at the very end.
const musicVolume = (frame: number) => {
  const t = frame / FPS;
  const fade = (edge: number) => Math.max(0, Math.min(1, (t - edge) / MUSIC.ramp));
  let level = MUSIC.sections[0].volume;
  for (let i = 1; i < MUSIC.sections.length; i++) {
    const p = fade(MUSIC.sections[i].from - MUSIC.ramp);
    level += (MUSIC.sections[i].volume - level) * p;
  }
  let under = 0;
  for (const line of VOICE) under = Math.max(under, Math.min(fade(line.at - MUSIC.ramp), 1 - fade(line.at + line.speech)));
  return level * (1 - (1 - MUSIC.underVoice) * under) * (1 - fade(DURATION - 0.6) * 0.999);
};

export const Sound: React.FC = () => (
  <>
    <Audio src={staticFile("sounds/music.mp3")} volume={musicVolume} />
    {VOICE.map((line) => (
      <Sequence key={line.id} from={f(line.at)} layout="none">
        <Audio src={staticFile(`voice/${line.id}.mp3`)} />
      </Sequence>
    ))}
    {SFX.map((fx, i) => {
      const lead = fx.trim ? 0 : PEAK[fx.file];
      return (
        <Sequence key={i} from={Math.max(0, f(fx.at - lead))} durationInFrames={fx.trim ? f(fx.trim[1] - fx.trim[0]) : undefined} layout="none">
          <Audio src={staticFile(`sounds/${fx.file}.wav`)} trimBefore={fx.trim ? f(fx.trim[0]) : undefined} volume={(volumes as Record<string, number>)[`${fx.file}.wav`]} />
        </Sequence>
      );
    })}
  </>
);
