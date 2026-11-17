# BuddySocials demo (17 Nov 2026)

A 57.5-second product video of BuddySocials, led by the desktop app, in two shapes: 16:9 (`Landscape`, 1920x1080) and 9:16 (`Vertical`, 1080x1920). Made from scratch: it shares no code, script, pacing or layout with the 26 Oct and 13 Nov videos.

Story: five platforms mean five dashboards and five tabs → they fold into one board → the board is yours (swap, resize, reorder on the phone, the desktop follows) → every post with its native numbers → write once, crop, pick accounts, publish → one inbox and goals → macOS and Linux with self-update, and the Android app with 7 home screen widgets → the name and the line.

## Style

The app's own design language: black, white and coral #D6544B, Chakra Petch Bold uppercase for display, IBM Plex Mono for text, square outlines. No style from the attentionmachine skill is used (its ready-made style is for talking-head videos); its rules for sound, safe zones, motion and checking are followed.

- Scenes change with hard cuts on bars of the music (120 BPM, a bar is 2 s).
- The app is shown in an outlined window that moves in on what is being said.
- 9:16 has its own layout: stacked, closer in, all text inside the Reels safe zone (`src/safe-zones.ts`).
- All text, timings and sound cues are in `src/data.ts`. Positions per shape are in `src/layout.ts`.

## Footage

Desktop app, rendered headless by the release binary from the saved data of 17 Nov (`e2e/artifacts/desktop-fixture-2026-11-17.json`), with `BUDDYSOCIALS_NOW=1794918600000` so the 28-day queries match the file:

- `public/app/board-A.png`: home, the layout as saved.
- `public/app/board-B.png`, `board-C.png`, `board-D.png`: the same data with the layout changed (X views tile swapped for the goals widget; the chart resized from XL to L; everything reordered). Only `layouts:get` in a copy of the fixture was edited; every tile is drawn by the real app. The video moves between them.
- `public/app/chart-hover.png`, `posts.png`, `draft-editor.png`, `draft-media.png`, `media-editor.png`, `inbox.png`, `update.png`: the app's own scenes.
- `public/app/goals.png`: the goals scene at `--size 860x560 --scale 3`, so the rows fit a narrow frame.

Android, copied or hard-linked from the main checkout:

- `public/clips/customise.mp4` = `/run/media/oddofrancesco/T6-7/Coding/Personal/BuddySocials/e2e/artifacts/scene-customise.mp4`
- `public/clips/home.mp4` = `/run/media/oddofrancesco/T6-7/Coding/Personal/BuddySocials/e2e/artifacts/scene-home.mp4`
- `public/images/widget-*.png`: home screen widget captures from `videos/2026-11-13-buddysocials-post/public/images/`. `widget-inbox.png` is cropped to its count, because the rest shows other people's comments.
- `public/images/icon.png`: `assets/icon.png`.

Not real, and why: the typing of the draft, the cursor, the lit account buttons and the "published" flash are drawn over real screens (the app captures are stills). The phone clips show demo data, the desktop shows the real account.

## Sound

- Voice: ElevenLabs, "Chris" (iP95p4xoKVk53GoZ742B), `eleven_multilingual_v2`, 8 lines, one take each, 735 credits. `scripts/narration.json` holds the text and settings, `scripts/narrate.py` made the files. Word timings came free with the same request (`public/voice/*.json`); nothing was transcribed.
- Music: ElevenLabs Music, one 60-second generation, 2,292 credits (the account counter went from 10,357 to 12,649). Saved in `.attentionmachine/sounds/music-warm-electronica-120bpm.mp3` of the main checkout, copied to `public/sounds/music.mp3`. Exactly 120 BPM; drums enter at 16 s.
- Effects: all from the attentionmachine skill's `assets/sounds/` (pop, click, swoosh-in, swoosh-out, thud, ding, typing). None generated. Levels from the skill's `effect-levels.mjs`, 10 dB under the voice (`src/volumes.json`).
- Final loudness set with the skill's `finish-sound.mjs` (-14 LUFS).

## Exports

- v1: first cut, `export/buddysocials-demo-16x9-v1.mp4` and `export/buddysocials-demo-9x16-v1.mp4`.
