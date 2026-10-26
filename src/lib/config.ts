const clerk = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();
const convex = process.env.EXPO_PUBLIC_CONVEX_URL?.trim();
const site = process.env.EXPO_PUBLIC_CONVEX_SITE_URL?.trim();

export const clerkPublishableKey = clerk && /^pk_(test|live)_.+/.test(clerk) ? clerk : undefined;
export const convexUrl = convex && /^https:\/\/[^\s/]+\/?$/.test(convex) ? convex : undefined;
/** The deployment's HTTP actions host, used by the Android home screen widgets. */
export const convexSiteUrl = site && /^https:\/\/[^\s/]+\/?$/.test(site) ? site.replace(/\/$/, "") : undefined;
