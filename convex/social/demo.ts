"use node";

import {
  SocialError,
  defineAdapter,
  type AccountRecord,
  type AnalyticsReport,
  type CapabilityManifest,
  type ConnectedAccountRef,
  type JsonObject,
  type MetricValue,
  type PlatformPostRef,
  type SocialAdapter,
} from "@opencoredev/social-sdk";
import type { Platform } from "../../shared/platforms";

/**
 * A deterministic stand-in for the six platforms. It returns the same record
 * shapes the real adapters return (YouTube snippets, Instagram media, X tweets,
 * LinkedIn shares, TikTok videos, Facebook Page posts), so the sync code path is identical. Posts
 * appear on a fixed schedule and their counters grow with real time, so every
 * sync sees movement.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const EPOCH = Date.UTC(2026, 0, 1);
const WINDOW = 200 * DAY;

type Profile = {
  readonly handle: string;
  readonly displayName: string;
  readonly cadenceHours: number;
  readonly medianViews: number;
  readonly halfLifeHours: number;
  readonly likeRate: number;
  readonly commentRate: number;
  readonly shareRate: number;
  readonly saveRate: number;
  readonly followRate: number;
  readonly baseFollowers: number;
};

const PROFILES: Record<Platform, Profile> = {
  youtube: { handle: "@democreator", displayName: "Demo Creator", cadenceHours: 60, medianViews: 14_000, halfLifeHours: 70, likeRate: 0.042, commentRate: 0.006, shareRate: 0.004, saveRate: 0, followRate: 0.004, baseFollowers: 18_400 },
  instagram: { handle: "democreator", displayName: "Demo Creator", cadenceHours: 40, medianViews: 9_000, halfLifeHours: 30, likeRate: 0.06, commentRate: 0.004, shareRate: 0.01, saveRate: 0.012, followRate: 0.002, baseFollowers: 12_900 },
  tiktok: { handle: "democreator", displayName: "Demo Creator", cadenceHours: 30, medianViews: 16_000, halfLifeHours: 26, likeRate: 0.07, commentRate: 0.003, shareRate: 0.008, saveRate: 0.009, followRate: 0.0015, baseFollowers: 21_300 },
  x: { handle: "democreator", displayName: "Demo Creator", cadenceHours: 14, medianViews: 4_200, halfLifeHours: 9, likeRate: 0.018, commentRate: 0.003, shareRate: 0.003, saveRate: 0.004, followRate: 0.0012, baseFollowers: 7_800 },
  linkedin: { handle: "demo-creator", displayName: "Demo Creator", cadenceHours: 52, medianViews: 3_600, halfLifeHours: 34, likeRate: 0.024, commentRate: 0.004, shareRate: 0.002, saveRate: 0.002, followRate: 0.002, baseFollowers: 5_200 },
  facebook: { handle: "democreator", displayName: "Demo Creator", cadenceHours: 48, medianViews: 2_800, halfLifeHours: 20, likeRate: 0.03, commentRate: 0.004, shareRate: 0.005, saveRate: 0, followRate: 0.001, baseFollowers: 3_100 },
};

const TOPICS = [
  "I gave an AI agent my whole calendar for a week",
  "Building a social dashboard on a Galaxy Fold",
  "Why I stopped using CSS frameworks for side projects",
  "Convex in 10 minutes: realtime without the plumbing",
  "Expo SDK 58 on a foldable, first impressions",
  "The design system I use for every project",
  "Shipping an app in a weekend, start to finish",
  "What I learned running Humane Labs for a year",
  "Dithered charts are back and I love them",
  "My terminal setup for agentic coding",
  "Stop writing unit tests nobody reads",
  "One prompt that fixed my product copy",
  "How I record dev videos with zero editing",
  "Reading 40 codebases so you don't have to",
  "Black, white and one colour: a UI rule",
  "I let three agents build the same feature",
  "The fastest way to prototype a mobile idea",
  "Home screen widgets are underrated",
  "Pricing my first AI product",
  "What a solo founder's week looks like",
  "Turning Telegram into my notification centre",
  "Things I would not automate",
  "A tiny habit that made me ship more",
  "Rebuilding my portfolio from scratch",
];

const COMMENT_TEXTS = [
  "Which font is that on the charts?",
  "This is exactly what I needed today, thanks",
  "Can you share the repo?",
  "How long did this take you end to end?",
  "Does it work on iOS too?",
  "The dither style is so good",
  "Would love a full tutorial on this",
  "What do you use for the backend?",
  "Not convinced about the agents part tbh",
  "Saved. Trying this tonight",
  "How do you handle the API limits?",
  "This deserves way more views",
  "Did you try it on the cover screen?",
  "Part 2 when?",
  "The black and coral palette is clean",
  "Is this open source?",
  "Great breakdown, very clear",
  "What laptop are you on?",
  "Followed for the design takes",
  "I tried this and hit an auth error, any tips?",
  "Respect for not using a template",
  "How much does running this cost per month?",
  "Bookmarking this for my team",
  "Can it reply to comments from the widget?",
];

const AUTHORS = [
  ["Giulia Ferri", "giuliaferri"],
  ["Marco Bianchi", "marcob.dev"],
  ["Ana Costa", "anacosta"],
  ["Sam Patel", "sampatel"],
  ["Lea Moreau", "leamoreau"],
  ["Tom Becker", "tbecker"],
  ["Yuki Tanaka", "yuki.builds"],
  ["Diego Ramos", "diegoramos"],
  ["Nora Jensen", "norajensen"],
  ["Luca Romano", "lucaromano"],
  ["Priya Nair", "priyanair"],
  ["Ben Carter", "bencarter"],
  ["Sofia Greco", "sofiagreco"],
  ["Omar Haddad", "omarhaddad"],
  ["Elena Rossi", "elenarossi"],
  ["Kai Müller", "kaimuller"],
] as const;

/** Comment threads per post the demo exposes; real platforms return every comment. */
const COMMENT_CAP: Record<Platform, number> = { youtube: 10, instagram: 6, tiktok: 6, x: 3, linkedin: 5, facebook: 5 };

type DemoPost = {
  readonly id: string;
  readonly platform: Platform;
  readonly index: number;
  readonly publishedAt: number;
  readonly finalViews: number;
  readonly halfLife: number;
  readonly title: string;
  readonly short: boolean;
};

function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Uniform number in [0, 1) that only depends on the key. */
function unit(key: string): number {
  return hash(key) / 4294967296;
}

function lognormal(key: string, sigma: number): number {
  const u1 = Math.max(unit(`${key}:a`), 1e-9);
  const u2 = unit(`${key}:b`);
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.exp(sigma * normal);
}

function postsFor(platform: Platform, now: number): DemoPost[] {
  const profile = PROFILES[platform];
  const interval = profile.cadenceHours * HOUR;
  const first = Math.max(0, Math.floor((now - WINDOW - EPOCH) / interval));
  const last = Math.floor((now - EPOCH) / interval);
  const posts: DemoPost[] = [];
  for (let index = first; index <= last; index++) {
    const key = `${platform}:${index}`;
    const publishedAt = EPOCH + index * interval + Math.floor(unit(`${key}:jitter`) * interval * 0.6);
    if (publishedAt > now || publishedAt < now - WINDOW) continue;
    posts.push({
      id: postId(platform, index),
      platform,
      index,
      publishedAt,
      finalViews: Math.round(profile.medianViews * lognormal(key, 0.75)),
      halfLife: profile.halfLifeHours * HOUR * (0.6 + unit(`${key}:hl`) * 0.9),
      title: TOPICS[hash(key) % TOPICS.length]!,
      short: platform === "youtube" && unit(`${key}:short`) < 0.45,
    });
  }
  return posts;
}

function postId(platform: Platform, index: number): string {
  const n = String(1_000_000 + index);
  switch (platform) {
    case "youtube":
      return `demo${n}`;
    case "linkedin":
      return `urn:li:share:7${n}`;
    case "facebook":
      return `100000000000000_${n}`;
    default:
      return `${platform}${n}`;
  }
}

function findPost(platform: Platform, id: string, now: number): DemoPost {
  const post = postsFor(platform, now).find((candidate) => candidate.id === id);
  if (post === undefined) {
    throw new SocialError({ code: "not_found", operation: "posts.read", message: "Demo post not found" });
  }
  return post;
}

/** Share of a post's lifetime views reached at `at`. */
function progress(post: DemoPost, at: number): number {
  if (at <= post.publishedAt) return 0;
  return 1 - Math.pow(2, -(at - post.publishedAt) / post.halfLife);
}

function counts(post: DemoPost, at: number) {
  const profile = PROFILES[post.platform];
  const views = Math.round(post.finalViews * progress(post, at));
  const flavor = 0.6 + unit(`${post.id}:flavor`) * 0.9;
  return {
    views,
    likes: Math.round(views * profile.likeRate * flavor),
    comments: Math.round(views * profile.commentRate * flavor),
    shares: Math.round(views * profile.shareRate * flavor),
    saves: Math.round(views * profile.saveRate * flavor),
    follows: Math.round(views * profile.followRate * flavor),
  };
}

function nativeMetrics(post: DemoPost, now: number): MetricValue[] {
  const c = counts(post, now);
  const reach = Math.round(c.views * 0.72);
  const named: Record<Platform, Record<string, number>> = {
    youtube: {
      viewCount: c.views,
      likeCount: c.likes,
      commentCount: c.comments,
      shares: c.shares,
      subscribersGained: c.follows,
      estimatedMinutesWatched: Math.round(c.views * (post.short ? 0.45 : 4.1)),
      averageViewDuration: Math.round((post.short ? 27 : 246) * (0.7 + unit(`${post.id}:avd`) * 0.6)),
    },
    instagram: {
      views: c.views,
      reach,
      likes: c.likes,
      comments: c.comments,
      saved: c.saves,
      shares: c.shares,
      profile_visits: Math.round(c.views * 0.011),
      follows: c.follows,
    },
    tiktok: { view_count: c.views, like_count: c.likes, comment_count: c.comments, share_count: c.shares },
    x: {
      impressions: c.views,
      likes: c.likes,
      replies: c.comments,
      reposts: c.shares,
      quotes: Math.round(c.shares * 0.3),
      bookmarks: c.saves,
      url_link_clicks: Math.round(c.views * 0.004),
      user_profile_clicks: Math.round(c.views * 0.006),
    },
    linkedin: {
      IMPRESSION: c.views,
      MEMBERS_REACHED: reach,
      REACTION: c.likes,
      COMMENT: c.comments,
      RESHARE: c.shares,
      POST_SAVE: c.saves,
      LINK_CLICKS: Math.round(c.views * 0.005),
      PROFILE_VIEW_FROM_CONTENT: Math.round(c.views * 0.008),
      FOLLOWER_GAINED_FROM_CONTENT: c.follows,
    },
    facebook: {
      post_media_view: c.views,
      post_total_media_view_unique: reach,
      reactions: c.likes,
      comments: c.comments,
      shares: c.shares,
      post_clicks: Math.round(c.views * 0.02),
    },
  };
  const fetchedAt = new Date(now).toISOString();
  return Object.entries(named[post.platform]).map(([name, value]) => ({
    name,
    value,
    unit: name === "averageViewDuration" ? "seconds" : "count",
    period: "lifetime",
    fetchedAt,
    freshness: "reported",
    source: `demo:${post.platform}`,
  }));
}

function providerRecord(post: DemoPost): JsonObject {
  const iso = new Date(post.publishedAt).toISOString();
  switch (post.platform) {
    case "youtube":
      return {
        id: post.id,
        kind: post.short ? "short" : "video",
        snippet: { title: post.title, description: "", publishedAt: iso },
      };
    case "instagram":
      return {
        id: post.id,
        caption: post.title,
        media_type: "VIDEO",
        media_product_type: "REELS",
        permalink: `https://www.instagram.com/reel/${post.id}/`,
        timestamp: iso,
      };
    case "tiktok":
      return {
        id: post.id,
        title: post.title,
        video_description: post.title,
        create_time: Math.floor(post.publishedAt / 1000),
        share_url: `https://www.tiktok.com/@democreator/video/${post.id}`,
      };
    case "x":
      return { id: post.id, text: post.title, created_at: iso };
    case "linkedin":
      return { id: post.id, commentary: post.title, publishedAt: post.publishedAt };
    case "facebook":
      return {
        id: post.id,
        message: post.title,
        created_time: iso,
        permalink_url: `https://www.facebook.com/${post.id}`,
        status_type: "mobile_status_update",
      };
  }
}

/** Comments arrive in proportion to the post's view curve. */
function commentsFor(post: DemoPost, now: number): JsonObject[] {
  const total = Math.min(COMMENT_CAP[post.platform], counts(post, post.publishedAt + 60 * DAY).comments);
  const items: JsonObject[] = [];
  for (let j = 0; j < total; j++) {
    const key = `${post.id}:c${j}`;
    const share = Math.min(unit(key) * 0.97, 0.97);
    const at = post.publishedAt + -Math.log2(1 - share) * post.halfLife + unit(`${key}:m`) * 40 * 60_000;
    if (at > now) continue;
    const [name, handle] = AUTHORS[hash(`${key}:a`) % AUTHORS.length]!;
    items.push({
      id: `${post.id}-c${j}`,
      authorId: handle,
      authorHandle: handle,
      authorName: name,
      text: COMMENT_TEXTS[hash(`${key}:t`) % COMMENT_TEXTS.length]!,
      createdAt: new Date(at).toISOString(),
      likeCount: Math.floor(unit(`${key}:l`) * 30),
    });
  }
  return items.sort((a, b) => String(b["createdAt"]).localeCompare(String(a["createdAt"])));
}

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

const CAPABILITIES: CapabilityManifest = {
  schemaVersion: 1,
  backend: "demo",
  apiRevision: "demo-1",
  runtime: ["node"],
  capabilities: [
    { operation: "accounts.read", platform: "*", availability: "available" },
    { operation: "posts.list", platform: "*", availability: "available" },
    { operation: "posts.read", platform: "*", availability: "available" },
    { operation: "comments.read", platform: "*", availability: "available" },
    { operation: "comments.write", platform: "*", availability: "available" },
    { operation: "analytics.read", platform: "*", availability: "available" },
    { operation: "analytics.account.read", platform: "*", availability: "available" },
    { operation: "analytics.report.read", platform: "*", availability: "available" },
  ],
};

export type DemoNative = {
  /** Lifetime views of a post at past instants, used once to seed the growth curve. */
  history(platform: Platform, postId: string, at: readonly number[]): number[];
};

export function demoAdapter(clock: () => number = Date.now): SocialAdapter<DemoNative> {
  const platformOf = (ref: { readonly platform: string }) => ref.platform as Platform;

  return defineAdapter<DemoNative, SocialAdapter<DemoNative>>({
    id: "demo",
    capabilities: CAPABILITIES,
    accounts: {
      async list() {
        return { items: [] };
      },
      async get(ref: ConnectedAccountRef): Promise<AccountRecord> {
        const profile = PROFILES[platformOf(ref)];
        return { ref, displayName: profile.displayName, handle: profile.handle, status: "connected" };
      },
    },
    posts: {
      async list(account, input) {
        const all = postsFor(platformOf(account), clock()).reverse();
        const offset = input.cursor === undefined ? 0 : Number(input.cursor);
        const limit = input.limit ?? 25;
        const page = all.slice(offset, offset + limit);
        return {
          items: page.map(providerRecord),
          ...(offset + limit < all.length ? { nextCursor: String(offset + limit) } : {}),
        };
      },
      async get(ref: PlatformPostRef) {
        return providerRecord(findPost(platformOf(ref), ref.postId, clock()));
      },
      // Publishing is not declared in the manifest, so the client rejects it before reaching here.
      prepareTarget() {
        return [];
      },
      async publishTarget() {
        throw new SocialError({
          code: "unsupported_capability",
          operation: "posts.publish",
          message: "Demo accounts do not publish",
        });
      },
    },
    comments: {
      async list(post, input) {
        const items = commentsFor(findPost(platformOf(post), post.postId, clock()), clock());
        const offset = input.cursor === undefined ? 0 : Number(input.cursor);
        const limit = input.limit ?? 25;
        return {
          items: items.slice(offset, offset + limit),
          ...(offset + limit < items.length ? { nextCursor: String(offset + limit) } : {}),
        };
      },
      async reply(comment, content) {
        if (content.text.trim().length === 0) {
          throw new SocialError({ code: "invalid_input", operation: "comments.write", message: "Reply text is empty" });
        }
        return { ...comment, commentId: `${comment.commentId}-reply-${clock()}` };
      },
    },
    analytics: {
      async getPostMetrics(post) {
        return nativeMetrics(findPost(platformOf(post), post.postId, clock()), clock());
      },
      async getAccountMetrics(account) {
        const platform = platformOf(account);
        const now = clock();
        const gained = postsFor(platform, now).reduce((sum, post) => sum + counts(post, now).follows, 0);
        return [
          {
            name: platform === "youtube" ? "subscriberCount" : "followers_count",
            value: PROFILES[platform].baseFollowers + gained,
            unit: "count",
            period: "lifetime",
            fetchedAt: new Date(now).toISOString(),
            freshness: "reported",
            source: `demo:${platform}`,
          },
        ];
      },
      async getReport(account, query): Promise<AnalyticsReport> {
        const platform = platformOf(account);
        const now = clock();
        const posts = postsFor(platform, now);
        const rows = [];
        for (let start = dayStart(query.from); start <= dayStart(query.to); start += DAY) {
          const end = Math.min(start + DAY, now);
          if (end <= start) break;
          const totals = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0, followers: 0 };
          for (const post of posts) {
            if (post.publishedAt >= end) continue;
            const before = counts(post, start);
            const after = counts(post, end);
            totals.views += after.views - before.views;
            totals.likes += after.likes - before.likes;
            totals.comments += after.comments - before.comments;
            totals.shares += after.shares - before.shares;
            totals.saves += after.saves - before.saves;
            totals.followers += after.follows - before.follows;
          }
          rows.push({ dimensions: { day: new Date(start).toISOString().slice(0, 10) }, metrics: totals });
        }
        return { query, rows, fetchedAt: new Date(now).toISOString(), source: `demo:${platform}` };
      },
    },
    native: {
      history(platform, id, at) {
        const post = findPost(platform, id, clock());
        return at.map((instant) => counts(post, instant).views);
      },
    },
  });
}

export function demoProfile(platform: Platform) {
  const profile = PROFILES[platform];
  return { handle: profile.handle, displayName: profile.displayName };
}
