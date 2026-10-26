import type { AuthConfig } from "convex/server";

const clerkFrontendApiUrl = process.env.CLERK_FRONTEND_API_URL?.trim().replace(/\/+$/, "");

export default {
  providers: clerkFrontendApiUrl ? [{ domain: clerkFrontendApiUrl, applicationID: "convex" }] : [],
} satisfies AuthConfig;
