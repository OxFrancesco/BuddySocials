# BuddySocials for the desktop

The dashboard, Studio with embedded Claude Code, posts, inbox, goals and accounts, built with [Rune](https://github.com/anomalyco/rune) on the same Convex backend as the phone app.

```sh
cd desktop
cargo run                 # the window
cargo build --release     # target/release/buddysocials
bun ../e2e/desktop.ts     # end to end: real sign-in, live data, a PNG of every screen
```

- **Studio & Claude Code:** the **Studio** tab runs your local `claude` CLI directly (using `stream-json` + `--resume` session persistence, the same way T3 Code integrates Claude Code — no API key needed) connected to a localhost-only MCP bridge inside the app. Claude can inspect your accounts, drafts, recent posts and open comments, edit the live draft and per-platform copy overrides side-by-side, attach local media or video covers, schedule posts, update YouTube visibility, and publish when asked.
- **Drafts, previews & publishing:** write a core post and optionally override copy per platform (`X`, `LinkedIn`, `Instagram`, `TikTok`, `YouTube`), set YouTube title & visibility (`public`, `unlisted`, `private`), attach a JPEG video cover (YouTube thumbnail & Instagram Reel cover), watch live platform mock-ups update as you or Claude edit, schedule auto-publishing, or publish/retry per account.
- **Install:** `./install-linux.sh` on Linux (binary in `~/.local/bin`, icon and launcher entry), `./bundle.sh --install` on a Mac (`/Applications/BuddySocials.app`).
- **Updates:** `./release.sh` builds for the machine it runs on and publishes the build to the Convex deployment. Run it on Linux for Linux and on a Mac for macOS. An installed app checks when it opens and every six hours; when its own program differs from the newest build it shows **Update** in the sidebar, which downloads the build, checks its SHA-256, replaces the app and starts it again. `buddysocials --update` does the same from a terminal. Development builds and a Mac binary outside `BuddySocials.app` don't update themselves.
- **Sign-in** opens the browser (Clerk OAuth with PKCE and a loopback callback). Release builds keep the session in the OS keychain. Debug builds keep it in `~/Library/Application Support/BuddySocials/dev-session.json`, because macOS asks for keychain access again after every rebuild.
- **Data** comes from live Convex queries on a background thread (`src/backend.rs`). The last dashboard is cached on disk so the window opens with numbers.
- **The home screen** shows the widget layout saved from the phone. Editing the layout, creating goals and post thumbnails are phone-only for now.
- **Another deployment:** set `BUDDYSOCIALS_CONVEX_URL`, `BUDDYSOCIALS_CLERK_ISSUER` and `BUDDYSOCIALS_CLERK_CLIENT_ID`. The Convex deployment needs `CLERK_DESKTOP_CLIENT_ID` set to the same client ID.
- **Headless:** `BUDDYSOCIALS_FIXTURE=file.json target/debug/buddysocials --snap out.png [--scene studio|posts|drafts|inbox|goals|accounts|signed-out]` renders saved data without a network. `--fetch file.json` writes that file from the live backend.
- **Attachments:** a draft takes up to four images or one video, added with the button, by dropping files on Studio or Drafts, or by pasting an image. Images can be cropped, turned and flipped; videos can be trimmed, which needs `ffmpeg` on the Mac (`brew install ffmpeg`). Scenes `studio`, `draft-media` and `media-editor` render them headless.
- **Media check:** `target/debug/buddysocials --check-media FILE` uses the stored sign-in to upload FILE, edit it, save it on a draft, and delete what it made. It prints one line per step that worked.
