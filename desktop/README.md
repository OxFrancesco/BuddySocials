# BuddySocials for the desktop

The dashboard, posts, inbox, goals and accounts, built with [Rune](https://github.com/anomalyco/rune) on the same Convex backend as the phone app.

```sh
cd desktop
cargo run                 # the window
cargo build --release     # target/release/buddysocials
bun ../e2e/desktop.ts     # end to end: real sign-in, live data, a PNG of every screen
```

- **Sign-in** opens the browser (Clerk OAuth with PKCE and a loopback callback). Release builds keep the session in the OS keychain. Debug builds keep it in `~/Library/Application Support/BuddySocials/dev-session.json`, because macOS asks for keychain access again after every rebuild.
- **Data** comes from live Convex queries on a background thread (`src/backend.rs`). The last dashboard is cached on disk so the window opens with numbers.
- **The home screen** shows the widget layout saved from the phone. Editing the layout, creating goals and post thumbnails are phone-only for now.
- **Another deployment:** set `BUDDYSOCIALS_CONVEX_URL`, `BUDDYSOCIALS_CLERK_ISSUER` and `BUDDYSOCIALS_CLERK_CLIENT_ID`. The Convex deployment needs `CLERK_DESKTOP_CLIENT_ID` set to the same client ID.
- **Headless:** `BUDDYSOCIALS_FIXTURE=file.json target/debug/buddysocials --snap out.png [--scene posts|inbox|goals|accounts|signed-out]` renders saved data without a network. `--fetch file.json` writes that file from the live backend.
