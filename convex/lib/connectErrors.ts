import type { Platform } from "../../shared/platforms";

/** Turns what a platform says when a sign-in fails into a next step the person can take. */
export function friendlyConnectError(platform: Platform, error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  const name = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok", x: "X", linkedin: "LinkedIn", facebook: "Facebook" }[platform];
  if (platform === "instagram" && /(business|creator|professional|not.*eligible|invalid scope)/.test(raw)) {
    return "Instagram only lets Business or Creator accounts connect. In Instagram, open Settings → Account type and tools → Switch to professional account, then try again.";
  }
  if (/(tester|not.*(live|approved|active)|developer mode|sandbox|unauthori[sz]ed_client|app.*(review|restricted))/.test(raw)) {
    return `${name} hasn't approved BuddySocials for every account yet, so only test accounts can connect for now.`;
  }
  if (/(access_denied|denied|cancel)/.test(raw)) return "Sign-in was cancelled.";
  if (/(expired|invalid_grant|code.*(used|invalid))/.test(raw)) return "That sign-in link expired. Try connecting again.";
  return `${name} did not accept the sign-in. Try again.`;
}
