# BuddySocials demo video

Remotion project for the 40-second demo. See `about.md` for sources and style.

```sh
bun install
bun scripts/voice.ts          # voiceover + word timings (needs ELEVENLABS_API_KEY in .attentionmachine/.env)
bunx remotion studio
bunx remotion render Demo export/buddysocials-demo-v1.mp4
```

`public/` (clips, voice, sounds, images) and `export/` are not committed.
