export const PLATFORMS = ["youtube", "instagram", "tiktok", "x", "linkedin"] as const;

export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABEL: Record<Platform, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
  x: "X",
  linkedin: "LinkedIn",
};

/** Two-letter tags used where a full name does not fit (chart legends, post rows). */
export const PLATFORM_TAG: Record<Platform, string> = {
  youtube: "YT",
  instagram: "IG",
  tiktok: "TT",
  x: "X",
  linkedin: "LI",
};

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}
