"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, mediaKindOf } from "../shared/drafts";

type Attached = { storageId: string; kind: "image" | "video"; mimeType: string; byteSize: number; filename: string | null; url: string | null };

/** Only public web addresses: this server fetches the link, so it must not be pointed at a private network. */
function publicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("url must be a full https link.");
  }
  const host = url.hostname.toLowerCase();
  const literal = /^[0-9.]+$/.test(host) || host.includes(":");
  if (url.protocol !== "https:" || literal || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) {
    throw new Error("url must be a public https link.");
  }
  return url;
}

/** Fetches an image or video from a public link and stores it, ready to attach to a draft. */
export const fromUrl = internalAction({
  args: { owner: v.string(), url: v.string(), filename: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Attached> => {
    let url = publicUrl(args.url);
    let response: Response | null = null;
    // Redirects are followed by hand so each hop is checked, not only the first address.
    for (let hop = 0; hop < 5; hop += 1) {
      response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
      const next = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (next === null) break;
      url = publicUrl(new URL(next, url).toString());
      response = null;
    }
    if (response === null || !response.ok) throw new Error("That link could not be fetched.");
    const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const kind = mediaKindOf(mimeType);
    if (kind === null) throw new Error("That link is not an image or a video.");
    const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
    const tooBig = kind === "image" ? "Images can be up to 20 MB." : "Videos can be up to 200 MB.";
    if (Number(response.headers.get("content-length") ?? 0) > limit) throw new Error(tooBig);
    // Read in pieces and stop at the limit, so a link that lies about its size can't fill memory.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("That link could not be fetched.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error(tooBig);
      }
      chunks.push(value);
    }
    const storageId = await ctx.storage.store(new Blob(chunks as BlobPart[], { type: mimeType }));
    const filename = args.filename ?? decodeURIComponent(url.pathname.split("/").pop() ?? "") ?? undefined;
    return await ctx.runMutation(internal.media.attachInternal, { owner: args.owner, storageId, ...(filename ? { filename } : {}) });
  },
});
