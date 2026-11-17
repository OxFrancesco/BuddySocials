/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounts from "../accounts.js";
import type * as comments from "../comments.js";
import type * as connect from "../connect.js";
import type * as connectStore from "../connectStore.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as desktopReleases from "../desktopReleases.js";
import type * as drafts from "../drafts.js";
import type * as goals from "../goals.js";
import type * as homeWidgets from "../homeWidgets.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as layouts from "../layouts.js";
import type * as lib_owner from "../lib/owner.js";
import type * as mcp from "../mcp.js";
import type * as media from "../media.js";
import type * as mediaImport from "../mediaImport.js";
import type * as profiles from "../profiles.js";
import type * as publish from "../publish.js";
import type * as social_batch from "../social/batch.js";
import type * as social_client from "../social/client.js";
import type * as social_demo from "../social/demo.js";
import type * as social_extract from "../social/extract.js";
import type * as social_linkedinPages from "../social/linkedinPages.js";
import type * as social_oauth from "../social/oauth.js";
import type * as social_probe from "../social/probe.js";
import type * as social_tiktokInbox from "../social/tiktokInbox.js";
import type * as social_youtubeUpload from "../social/youtubeUpload.js";
import type * as sync from "../sync.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  comments: typeof comments;
  connect: typeof connect;
  connectStore: typeof connectStore;
  crons: typeof crons;
  dashboard: typeof dashboard;
  desktopReleases: typeof desktopReleases;
  drafts: typeof drafts;
  goals: typeof goals;
  homeWidgets: typeof homeWidgets;
  http: typeof http;
  ingest: typeof ingest;
  layouts: typeof layouts;
  "lib/owner": typeof lib_owner;
  mcp: typeof mcp;
  media: typeof media;
  mediaImport: typeof mediaImport;
  profiles: typeof profiles;
  publish: typeof publish;
  "social/batch": typeof social_batch;
  "social/client": typeof social_client;
  "social/demo": typeof social_demo;
  "social/extract": typeof social_extract;
  "social/linkedinPages": typeof social_linkedinPages;
  "social/oauth": typeof social_oauth;
  "social/probe": typeof social_probe;
  "social/tiktokInbox": typeof social_tiktokInbox;
  "social/youtubeUpload": typeof social_youtubeUpload;
  sync: typeof sync;
  validators: typeof validators;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
