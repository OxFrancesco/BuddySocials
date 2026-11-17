import { PLATFORM_LABEL, type Platform } from "./platforms";

/** The longest post each platform takes. X counts 280; LinkedIn 3,000; an Instagram caption 2,200. */
export const TEXT_LIMIT: Partial<Record<Platform, number>> = { x: 280, linkedin: 3000, instagram: 2200 };

/** Platforms a draft can be published to. */
export const CAN_POST: readonly Platform[] = ["linkedin", "x", "instagram", "tiktok", "youtube"];

/** How a YouTube upload is shown. Change it on YouTube once the video is up. */
export const YOUTUBE_VISIBILITY = "unlisted" as const;
/** YouTube's longest title, in characters, and its longest description, in UTF-8 bytes. */
export const YOUTUBE_TITLE_LIMIT = 100;
export const YOUTUBE_DESCRIPTION_BYTES = 5000;

/** The video's title on YouTube: the draft's first line, or a plain fallback when the draft has no text. */
export function youtubeTitle(text: string, filename?: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  // YouTube refuses angle brackets; the text itself is checked before publishing, a file name isn't.
  const name = filename?.replace(/\.[^.]+$/, "").replace(/[<>]/g, "").trim() ?? "";
  const title = line || name || "New video";
  return [...title].slice(0, YOUTUBE_TITLE_LIMIT).join("");
}

/** The permission each platform needs at sign-in before it lets the app post. Any one of them is enough. */
const POSTING_SCOPES: Partial<Record<Platform, readonly string[]>> = {
  instagram: ["instagram_business_content_publish", "instagram_content_publish"],
  tiktok: ["video.upload", "video.publish"],
  youtube: [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/youtube.force-ssl",
  ],
};

export const MAX_DRAFT_TEXT = 5000;
export const MAX_DRAFT_MEDIA = 4;

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** TikTok and LinkedIn uploads load the video into memory on the server, which has about 512 MB, so this stays well under. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/** How long an unused upload is kept before it is deleted. The owner can also choose to clean up by hand only. */
export const CLEANUP_DAYS: readonly number[] = [1, 7, 30];
export const DEFAULT_CLEANUP_DAYS = 7;

export type DraftMediaKind = "image" | "video";

export function mediaKindOf(mimeType: string): DraftMediaKind | null {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return null;
}

type AccountForPosting = {
  platform: Platform;
  source: "demo" | "direct";
  status: string;
  scopes?: readonly string[];
};

/** What a post's attachment is, as far as the rules below need. Type and size are checked when known. */
export type DraftMediaInfo = { kind: DraftMediaKind; mimeType?: string; byteSize?: number };

type MediaRule = { images: number; imageTypes: readonly string[]; imageBytes: number; imageNames: string; videoBytes: number };

/** What each platform takes: how many images, in which formats and sizes. Video is always one MP4 on its own. */
export const MEDIA_RULES: Partial<Record<Platform, MediaRule>> = {
  x: { images: 4, imageTypes: ["image/jpeg", "image/png"], imageBytes: 5 * 1024 * 1024, imageNames: "JPEG or PNG", videoBytes: MAX_VIDEO_BYTES },
  linkedin: {
    images: 20,
    imageTypes: ["image/jpeg", "image/png", "image/gif"],
    imageBytes: MAX_IMAGE_BYTES,
    imageNames: "JPEG, PNG or GIF",
    videoBytes: MAX_VIDEO_BYTES,
  },
  // Instagram fetches each file from its link and only takes JPEG images, up to 8 MB.
  instagram: { images: 10, imageTypes: ["image/jpeg"], imageBytes: 8 * 1024 * 1024, imageNames: "JPEG", videoBytes: MAX_VIDEO_BYTES },
};

/** Platforms that take one video and nothing else. */
const VIDEO_ONLY: readonly Platform[] = ["tiktok", "youtube"];

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

function mediaIssues(platform: Platform, media: readonly DraftMediaInfo[]): string[] {
  const label = PLATFORM_LABEL[platform];
  const rule = MEDIA_RULES[platform];
  if (media.length === 0 || rule === undefined) return [];
  const issues: string[] = [];
  const videos = media.filter((item) => item.kind === "video");
  const images = media.filter((item) => item.kind === "image");
  if (videos.length > 0) {
    if (media.length > 1) issues.push(`${label} takes one video on its own, without other attachments.`);
    if (videos.some((item) => item.mimeType !== undefined && item.mimeType !== "video/mp4")) issues.push(`${label} takes MP4 video.`);
    if (videos.some((item) => item.byteSize !== undefined && item.byteSize > rule.videoBytes)) {
      issues.push(`Videos can be up to ${megabytes(rule.videoBytes)}. Trim it or export it smaller.`);
    }
    return issues;
  }
  if (images.length > rule.images) issues.push(`${label} takes up to ${rule.images} images.`);
  if (images.some((item) => item.mimeType !== undefined && !rule.imageTypes.includes(item.mimeType))) {
    issues.push(`${label} takes ${rule.imageNames} images.`);
  }
  if (images.some((item) => item.byteSize !== undefined && item.byteSize > rule.imageBytes)) {
    issues.push(`${label} takes images up to ${megabytes(rule.imageBytes)}.`);
  }
  return issues;
}

function videoOnlyIssues(platform: Platform, media: readonly DraftMediaInfo[]): string[] {
  const label = PLATFORM_LABEL[platform];
  const videos = media.filter((item) => item.kind === "video");
  if (videos.length === 1 && media.length === 1) {
    const video = videos[0]!;
    const issues: string[] = [];
    if (video.mimeType !== undefined && video.mimeType !== "video/mp4") issues.push(`${label} takes MP4 video.`);
    if (video.byteSize !== undefined && video.byteSize > MAX_VIDEO_BYTES) {
      issues.push(`Videos can be up to ${megabytes(MAX_VIDEO_BYTES)}. Trim it or export it smaller.`);
    }
    return issues;
  }
  if (media.length === 0) return [`${label} needs a video.`];
  return [`${label} takes one video on its own, without images or other attachments.`];
}

/** What stops an account from posting anything at all. Empty means it can post. */
export function accountIssues(account: AccountForPosting, { permissions = true }: { permissions?: boolean } = {}): string[] {
  const label = PLATFORM_LABEL[account.platform];
  if (account.source === "demo") return ["Demo accounts can't post."];
  if (!CAN_POST.includes(account.platform)) return [`Posting to ${label} isn't available yet.`];
  if (account.status === "reconnect") return [`Sign in to ${label} again.`];
  // Accounts connected before posting was added only allowed reading, so they need one more sign-in.
  const needed = POSTING_SCOPES[account.platform];
  if (permissions && needed !== undefined && account.scopes !== undefined && !needed.some((scope) => account.scopes!.includes(scope))) {
    return [`Sign in to ${label} again to allow posting.`];
  }
  return [];
}

/**
 * What stops a draft from going to one account, worded for the person writing it. Empty means ready.
 * Pass `permissions: false` where the account's sign-in permissions aren't known, such as on the phone.
 */
export function postingIssues(
  account: AccountForPosting,
  text: string,
  media: readonly DraftMediaInfo[],
  { permissions = true }: { permissions?: boolean } = {},
): string[] {
  const label = PLATFORM_LABEL[account.platform];
  const blocked = accountIssues(account, { permissions });
  if (blocked.length > 0) return blocked;
  const issues: string[] = [];
  const trimmed = text.trim();
  const length = [...trimmed].length;
  if (length === 0 && media.length === 0) issues.push("Write something first.");
  const limit = TEXT_LIMIT[account.platform];
  if (limit !== undefined && length > limit) issues.push(`${length - limit} characters over ${label}'s limit of ${limit}.`);
  if (VIDEO_ONLY.includes(account.platform)) issues.push(...videoOnlyIssues(account.platform, media));
  else issues.push(...mediaIssues(account.platform, media));
  if (account.platform === "instagram" && media.length === 0) issues.push("Instagram needs an image or a video.");
  if (account.platform === "youtube") {
    if (/[<>]/.test(trimmed)) issues.push("YouTube doesn't allow < or > in a title or description.");
    const bytes = new TextEncoder().encode(trimmed).byteLength;
    if (bytes > YOUTUBE_DESCRIPTION_BYTES) issues.push(`YouTube descriptions take up to ${YOUTUBE_DESCRIPTION_BYTES} bytes. Shorten the text.`);
  }
  // X only lets an app attach media when the account allowed it at sign-in.
  if (permissions && account.platform === "x" && media.length > 0 && !account.scopes?.includes("media.write")) {
    issues.push("Sign in to X again to allow posts with images and video.");
  }
  return issues;
}
