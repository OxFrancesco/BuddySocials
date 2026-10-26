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

/** One colour per platform, toned so each reads on black next to the others. */
export const PLATFORM_COLOR: Record<Platform, `#${string}`> = {
  youtube: "#FF4D4D",
  instagram: "#E1449B",
  tiktok: "#2EE6E0",
  x: "#F2F2F2",
  linkedin: "#4C8DFF",
};

/** The colour a chart uses: the platform's own when it shows one platform, coral for all of them. */
export function accentFor(platform: Platform | "all", fallback: `#${string}`): `#${string}` {
  return platform === "all" ? fallback : PLATFORM_COLOR[platform];
}

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}
