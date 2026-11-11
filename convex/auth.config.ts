import type { AuthConfig } from "convex/server";

const clerkFrontendApiUrl = process.env.CLERK_FRONTEND_API_URL?.trim().replace(/\/+$/, "");
/** The desktop app signs in through Clerk's OAuth flow; its tokens carry this client ID as audience. */
const desktopClientId = process.env.CLERK_DESKTOP_CLIENT_ID?.trim();

export default {
  providers: clerkFrontendApiUrl
    ? [
        { domain: clerkFrontendApiUrl, applicationID: "convex" },
        ...(desktopClientId ? [{ domain: clerkFrontendApiUrl, applicationID: desktopClientId }] : []),
      ]
    : [],
} satisfies AuthConfig;
