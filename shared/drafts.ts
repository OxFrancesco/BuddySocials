import { PLATFORM_LABEL, type Platform } from "./platforms";

/** The longest post each platform takes. X counts 280; LinkedIn 3,000. */
export const TEXT_LIMIT: Partial<Record<Platform, number>> = { x: 280, linkedin: 3000 };

/** Platforms a draft can be published to today. The others need more sign-in permissions or an app review first. */
export const CAN_POST: readonly Platform[] = ["linkedin", "x"];

export const MAX_DRAFT_TEXT = 5000;
export const MAX_DRAFT_MEDIA = 4;

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Publishing loads a video into memory on the server, which has about 512 MB, so this stays well under. */
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
};

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

/** What stops a draft from going to one account, worded for the person writing it. Empty means ready. */
export function postingIssues(account: AccountForPosting, text: string, media: readonly DraftMediaInfo[]): string[] {
  const label = PLATFORM_LABEL[account.platform];
  if (account.source === "demo") return ["Demo accounts can't post."];
  if (!CAN_POST.includes(account.platform)) return [`Posting to ${label} isn't available yet.`];
  if (account.status === "reconnect") return [`Sign in to ${label} again.`];
  const issues: string[] = [];
  const length = [...text.trim()].length;
  if (length === 0 && media.length === 0) issues.push("Write something first.");
  const limit = TEXT_LIMIT[account.platform];
  if (limit !== undefined && length > limit) issues.push(`${length - limit} characters over ${label}'s limit of ${limit}.`);
  issues.push(...mediaIssues(account.platform, media));
  // X only lets an app attach media when the account allowed it at sign-in.
  if (account.platform === "x" && media.length > 0 && !account.scopes?.includes("media.write")) {
    issues.push("Sign in to X again to allow posts with images and video.");
  }
  return issues;
}
