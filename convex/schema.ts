import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  dayCountersFields,
  platformValidator,
  postCountersValidator,
  widgetValidator,
} from "./validators";

export default defineSchema({
  accounts: defineTable({
    owner: v.string(),
    platform: platformValidator,
    /** "demo" accounts run the generated demo adapter; "direct" accounts call the platform. */
    source: v.union(v.literal("demo"), v.literal("direct")),
    platformAccountId: v.string(),
    handle: v.string(),
    displayName: v.string(),
    status: v.union(
      v.literal("connected"),
      v.literal("syncing"),
      v.literal("reconnect"),
      v.literal("error"),
    ),
    followers: v.optional(v.number()),
    lastSyncedAt: v.optional(v.number()),
    /** When the running sync was claimed. A claim older than SYNC_STALE_MS is treated as abandoned. */
    syncStartedAt: v.optional(v.number()),
    /** When the last sync ended, whether it worked or not. The hourly job spaces retries from this. */
    lastAttemptAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    /** Parts of the account the platform doesn't share with this app, e.g. LinkedIn posts before approval. */
    limited: v.optional(v.array(v.string())),
    /** What the account allowed at sign-in. Missing on accounts connected before posting existed. */
    scopes: v.optional(v.array(v.string())),
    /** Set on LinkedIn company Pages, whose tokens come from the separate Pages developer app. */
    app: v.optional(v.literal("linkedinPages")),
  })
    .index("by_owner", ["owner"])
    .index("by_owner_and_platform", ["owner", "platform"]),

  /** Encrypted platform tokens for direct accounts. Never returned to clients. */
  credentials: defineTable({
    accountId: v.id("accounts"),
    keyId: v.string(),
    iv: v.string(),
    ciphertext: v.string(),
    expiresAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_account", ["accountId"]),

  posts: defineTable({
    owner: v.string(),
    accountId: v.id("accounts"),
    platform: platformValidator,
    platformPostId: v.string(),
    kind: v.string(),
    title: v.optional(v.string()),
    text: v.optional(v.string()),
    permalink: v.optional(v.string()),
    thumbnailUrl: v.optional(v.string()),
    publishedAt: v.number(),
    counters: postCountersValidator,
    /** Provider metric names and values as the platform reported them. */
    native: v.record(v.string(), v.number()),
    lastSyncedAt: v.number(),
  })
    .index("by_owner_and_publishedAt", ["owner", "publishedAt"])
    .index("by_owner_and_platform_and_publishedAt", ["owner", "platform", "publishedAt"])
    .index("by_account_and_platformPostId", ["accountId", "platformPostId"]),

  /** One row per sync per post, used for the growth curve on the post screen. */
  postSnapshots: defineTable({
    postId: v.id("posts"),
    takenAt: v.number(),
    views: v.optional(v.number()),
    likes: v.optional(v.number()),
    comments: v.optional(v.number()),
    shares: v.optional(v.number()),
  }).index("by_post_and_takenAt", ["postId", "takenAt"]),

  /** Per-account counters for one UTC day. */
  dailyStats: defineTable({
    owner: v.string(),
    accountId: v.id("accounts"),
    platform: platformValidator,
    day: v.string(),
    ...dayCountersFields,
    followersTotal: v.optional(v.number()),
    /** True when the platform reported the day directly instead of us summing post deltas. */
    fromReport: v.boolean(),
  })
    .index("by_owner_and_day", ["owner", "day"])
    .index("by_account_and_day", ["accountId", "day"]),

  comments: defineTable({
    owner: v.string(),
    accountId: v.id("accounts"),
    postId: v.id("posts"),
    platform: platformValidator,
    platformCommentId: v.string(),
    parentId: v.optional(v.string()),
    authorName: v.string(),
    authorHandle: v.optional(v.string()),
    text: v.string(),
    publishedAt: v.number(),
    likeCount: v.optional(v.number()),
    state: v.union(v.literal("open"), v.literal("replied"), v.literal("done")),
    reply: v.optional(
      v.object({
        text: v.string(),
        at: v.number(),
        status: v.union(v.literal("sending"), v.literal("sent"), v.literal("failed")),
        error: v.optional(v.string()),
      }),
    ),
  })
    .index("by_owner_and_publishedAt", ["owner", "publishedAt"])
    .index("by_owner_and_state_and_publishedAt", ["owner", "state", "publishedAt"])
    .index("by_post_and_publishedAt", ["postId", "publishedAt"])
    .index("by_account_and_platformCommentId", ["accountId", "platformCommentId"]),

  layouts: defineTable({
    owner: v.string(),
    widgets: v.array(widgetValidator),
    updatedAt: v.number(),
  }).index("by_owner", ["owner"]),

  /** Targets the owner sets for themselves. Progress is computed from dailyStats and posts. */
  goals: defineTable({
    owner: v.string(),
    metric: v.union(
      v.literal("views"),
      v.literal("likes"),
      v.literal("comments"),
      v.literal("shares"),
      v.literal("followers"),
      v.literal("engagement"),
      v.literal("posts"),
    ),
    platform: v.union(v.literal("all"), platformValidator),
    target: v.number(),
    /** "week" and "month" follow the calendar (UTC) and can repeat; "range" is a fixed window. */
    period: v.union(v.literal("week"), v.literal("month"), v.literal("range")),
    repeat: v.boolean(),
    startDay: v.string(),
    endDay: v.string(),
    /** Period start (YYYY-MM-DD) whose completion was already celebrated. */
    celebrated: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_owner", ["owner"]),

  /** A post written once and published later to one or more connected accounts. */
  drafts: defineTable({
    owner: v.string(),
    text: v.string(),
    media: v.array(
      v.object({
        storageId: v.id("_storage"),
        kind: v.union(v.literal("image"), v.literal("video")),
        mimeType: v.string(),
        byteSize: v.number(),
        filename: v.optional(v.string()),
      }),
    ),
    /** The accounts this draft goes to. */
    accountIds: v.array(v.id("accounts")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_owner_and_updatedAt", ["owner", "updatedAt"]),

  /** Every file uploaded for a draft. `unusedSince` is set while no draft holds it; `expiresAt` is when cleanup deletes it. */
  uploads: defineTable({
    owner: v.string(),
    storageId: v.id("_storage"),
    kind: v.union(v.literal("image"), v.literal("video")),
    mimeType: v.string(),
    byteSize: v.number(),
    filename: v.optional(v.string()),
    draftId: v.optional(v.id("drafts")),
    unusedSince: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
  })
    .index("by_storageId", ["storageId"])
    .index("by_owner_and_unusedSince", ["owner", "unusedSince"])
    .index("by_expiresAt", ["expiresAt"]),

  /** Per-owner choices. `cleanupAfterDays` is null when unused uploads are only deleted by hand. */
  settings: defineTable({
    owner: v.string(),
    cleanupAfterDays: v.union(v.null(), v.number()),
  }).index("by_owner", ["owner"]),

  /** One row per draft and account, so a failure on one platform never hides a success on another. */
  draftDeliveries: defineTable({
    owner: v.string(),
    draftId: v.id("drafts"),
    accountId: v.id("accounts"),
    platform: platformValidator,
    state: v.union(v.literal("queued"), v.literal("sending"), v.literal("published"), v.literal("failed")),
    permalink: v.optional(v.string()),
    platformPostId: v.optional(v.string()),
    error: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_draft", ["draftId"]),

  /** Who signed in, by email, so the MCP server can find the same person the apps know. */
  profiles: defineTable({
    owner: v.string(),
    email: v.string(),
  })
    .index("by_owner", ["owner"])
    .index("by_email", ["email"]),

  /** In-flight OAuth connections, keyed by the state sent to the platform. Ten minutes to finish. */
  connectAttempts: defineTable({
    owner: v.string(),
    platform: platformValidator,
    state: v.string(),
    codeVerifier: v.string(),
    providerState: v.optional(v.string()),
    redirectUri: v.string(),
    /** Set when the desktop app started it, so the callback ends on a web page instead of the phone app. */
    client: v.optional(v.literal("desktop")),
    /** Set when connecting LinkedIn company Pages instead of the member profile. */
    app: v.optional(v.literal("linkedinPages")),
    createdAt: v.number(),
  }).index("by_state", ["state"]),

  /** Read-only tokens the Android home screen widgets use to fetch a snapshot. */
  widgetTokens: defineTable({
    owner: v.string(),
    tokenHash: v.string(),
    createdAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_owner", ["owner"]),

  /** Builds of the desktop app. The newest per platform is what installed apps update to. */
  desktopReleases: defineTable({
    /** The build's operating system and chip, such as "linux-aarch64" or "macos-aarch64". */
    platform: v.string(),
    version: v.string(),
    /** The file to download: the program itself on Linux, a .tar.gz of the app bundle on macOS. */
    storageId: v.id("_storage"),
    byteSize: v.number(),
    /** SHA-256 of the downloaded file, and of the program inside it. An app whose own program differs is out of date. */
    fileSha256: v.string(),
    programSha256: v.string(),
    createdAt: v.number(),
  }).index("by_platform_and_createdAt", ["platform", "createdAt"]),
});
