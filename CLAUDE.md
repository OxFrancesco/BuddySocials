
<!-- codeview:start -->

## Reference codebases (codeview)

The `resources/` folder contains read-only clones of reference codebases.
If you need to implement code specific to one of these codebases, read the relevant
folder to gather information, feedback, patterns, and templates before writing code.

- `resources/rune` — Rune GPU UI framework in Rust: crates/rune, examples/hello, headless PNG rendering
- `resources/convex-rs` — Official Convex Rust client: ConvexClient, subscriptions, set_auth
- `resources/social-sdk` — Social SDK direct Instagram and TikTok adapters for UGC publishing feasibility
- `resources/clerk-cli-auth-example` — Clerk reference for CLI sign-in with OAuth Authorization Code + PKCE and a loopback callback
- `resources/convex-js` — Official Convex TypeScript client and React integration source, including React Native and Clerk provider patterns

<!-- codeview:end -->

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
