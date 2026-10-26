
<!-- codeview:start -->

## Reference codebases (codeview)

The `resources/` folder contains read-only clones of reference codebases.
If you need to implement code specific to one of these codebases, read the relevant
folder to gather information, feedback, patterns, and templates before writing code.

- `resources/social-sdk` — Social SDK direct Instagram and TikTok adapters for UGC publishing feasibility
- `resources/react-native-dither-kit` — RN Skia port of Dither Kit charts (area/line/bar/pie/sparkline)
- `resources/dither-kit` — Dither Kit official chart components and canvas engine
- `resources/react-native-android-widget` — Android RemoteViews rendering, click handling and configuration reference
- `resources/react-native-sortables` — Reanimated sortable grid/flex for drag-to-reorder
- `resources/attentionmachine-skills` — Skills for demo videos with narration/SFX and landing pages

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
