"use node";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { enforceRateLimit } from "./lib/rateLimits";
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

/** Loopback, private, link-local, carrier-grade NAT, multicast and other non-internet ranges. */
function privateAddress(address: string): boolean {
  const lower = address.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateAddress(mapped[1]!);
  if (isIP(lower) === 4) {
    const [a, b] = lower.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  return (
    lower === "::" || lower === "::1" ||
    lower.startsWith("fc") || lower.startsWith("fd") ||
    /^fe[89ab]/.test(lower) ||
    lower.startsWith("ff") ||
    lower.startsWith("64:ff9b:") ||
    lower.startsWith("2001:db8")
  );
}

/** Refuses a host whose name points at a private network, such as `127.0.0.1.nip.io`. */
async function publicHost(url: URL): Promise<URL> {
  let addresses: { address: string }[];
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("That link could not be fetched.");
  }
  if (addresses.length === 0 || addresses.some((entry) => privateAddress(entry.address))) {
    throw new Error("url must be a public https link.");
  }
  return url;
}

/** Fetches an image or video from a public link and stores it, ready to attach to a draft. */
export const fromUrl = internalAction({
  args: { owner: v.string(), url: v.string(), filename: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Attached> => {
    await enforceRateLimit(ctx, "mediaImport", args.owner);
    let url = await publicHost(publicUrl(args.url));
    let response: Response | null = null;
    // Redirects are followed by hand so each hop is checked, not only the first address.
    for (let hop = 0; hop < 5; hop += 1) {
      response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
      const next = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (next === null) break;
      url = await publicHost(publicUrl(new URL(next, url).toString()));
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
