import { PLATFORM_LABEL, type Platform } from "./platforms";

/** The longest post each platform takes. X counts 280; LinkedIn 3,000. */
export const TEXT_LIMIT: Partial<Record<Platform, number>> = { x: 280, linkedin: 3000 };

/** Platforms a draft can be published to today. The others need video upload or an app review first. */
export const CAN_POST: readonly Platform[] = ["linkedin", "x"];

export const MAX_DRAFT_TEXT = 5000;
export const MAX_DRAFT_MEDIA = 4;

export type DraftMediaKind = "image" | "video";

type AccountForPosting = {
  platform: Platform;
  source: "demo" | "direct";
  status: string;
  scopes?: readonly string[];
};

/** What stops a draft from going to one account, worded for the person writing it. Empty means ready. */
export function postingIssues(account: AccountForPosting, text: string, media: readonly { kind: DraftMediaKind }[]): string[] {
  const label = PLATFORM_LABEL[account.platform];
  if (account.source === "demo") return ["Demo accounts can't post."];
  if (!CAN_POST.includes(account.platform)) return [`Posting to ${label} isn't available yet.`];
  if (account.status === "reconnect") return [`Sign in to ${label} again.`];
  const issues: string[] = [];
  const length = [...text.trim()].length;
  if (length === 0 && media.length === 0) issues.push("Write something first.");
  const limit = TEXT_LIMIT[account.platform];
  if (limit !== undefined && length > limit) issues.push(`${length - limit} characters over ${label}'s limit of ${limit}.`);
  if (media.some((item) => item.kind === "video")) issues.push(`Video posts to ${label} aren't available yet.`);
  if (media.length > MAX_DRAFT_MEDIA) issues.push(`${label} takes up to ${MAX_DRAFT_MEDIA} images.`);
  // X only lets an app attach images when the account allowed it at sign-in.
  if (account.platform === "x" && media.length > 0 && !account.scopes?.includes("media.write")) {
    issues.push("Sign in to X again to allow posts with images.");
  }
  return issues;
}
