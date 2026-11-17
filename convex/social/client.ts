"use node";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  createSocial,
  type CapabilityManifest,
  type SocialAdapter,
} from "@opencoredev/social-sdk";
import { instagram } from "@opencoredev/social-sdk/instagram";
import { linkedin } from "@opencoredev/social-sdk/linkedin";
import { tiktok } from "@opencoredev/social-sdk/tiktok";
import { x } from "@opencoredev/social-sdk/x";
import { youtube } from "@opencoredev/social-sdk/youtube";
import type { Doc } from "../_generated/dataModel";
import { demoAdapter } from "./demo";

export type PlatformCredential = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
};

const LINKEDIN_API_VERSION = "202610";

/**
 * Two fixes for the SDK's YouTube upload (0.5.0). It starts an upload asking for `processingDetails`,
 * which YouTube refuses there ("unexpectedPart"), so that part is dropped. And it reports a refused
 * upload by its status alone, so YouTube's own reason is logged.
 */
const youtubeFetch: typeof fetch = async (input, init) => {
  let target = input;
  if (typeof input === "string" || input instanceof URL) {
    const url = new URL(input);
    if (url.pathname === "/upload/youtube/v3/videos" && url.searchParams.has("part")) {
      const parts = url.searchParams.get("part")!.split(",").filter((part) => part !== "processingDetails");
      url.searchParams.set("part", parts.join(","));
      target = url;
    }
  }
  const response = await fetch(target, init);
  if (!response.ok && response.status !== 308 && String(target).includes("/upload/youtube/")) {
    console.error("youtube upload", response.status, (await response.clone().text().catch(() => "")).slice(0, 1000));
  }
  return response;
};

export function adapterFor(
  account: Doc<"accounts">,
  credential: PlatformCredential | null,
): SocialAdapter<unknown> {
  if (account.source === "demo") return demoAdapter();
  if (credential === null) throw new Error(`${account.platform} needs to be reconnected.`);
  const accessToken = credential.accessToken;
  switch (account.platform) {
    case "youtube":
      return youtube({ auth: { accessToken, channelId: account.platformAccountId }, fetch: youtubeFetch });
    case "instagram": {
      const adapter = instagram({ auth: { accessToken, accountId: account.platformAccountId } });
      // The adapter follows a video until Instagram has processed and posted it, but doesn't declare that it can.
      return {
        ...adapter,
        capabilities: {
          ...adapter.capabilities,
          capabilities: [...adapter.capabilities.capabilities, { platform: "instagram", operation: "posts.status", availability: "available" }],
        },
      };
    }
    case "x":
      return x({ auth: { userId: account.platformAccountId, accessToken } });
    case "linkedin":
      return linkedin({
        auth: { accessToken, author: account.platformAccountId as `urn:li:person:${string}` },
        apiVersion: LINKEDIN_API_VERSION,
      });
    case "tiktok":
      return tiktok({ auth: { accessToken, openId: account.platformAccountId }, verifiedMediaOrigins: [] });
  }
}

export function socialFor(adapter: SocialAdapter<unknown>) {
  return createSocial({ backend: adapter });
}

export function supports(manifest: CapabilityManifest, operation: string, platform: string): boolean {
  return manifest.capabilities.some(
    (entry) =>
      entry.operation === operation &&
      (entry.platform === platform || entry.platform === "*") &&
      entry.availability === "available",
  );
}

/** AES-256-GCM with CREDENTIALS_KEY (32 bytes, base64). Tokens never leave actions in plaintext. */
function key(): { id: string; bytes: Buffer } {
  const raw = process.env.CREDENTIALS_KEY;
  if (!raw) throw new Error("CREDENTIALS_KEY is not set on the Convex deployment.");
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) throw new Error("CREDENTIALS_KEY must be 32 bytes encoded as base64.");
  return { id: process.env.CREDENTIALS_KEY_ID ?? "k1", bytes };
}

export function sealCredential(credential: PlatformCredential) {
  const { id, bytes } = key();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", bytes, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(credential), "utf8"), cipher.final()]);
  return {
    keyId: id,
    iv: iv.toString("base64"),
    ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString("base64"),
  };
}

export function openCredential(sealed: { iv: string; ciphertext: string }): PlatformCredential {
  const { bytes } = key();
  const data = Buffer.from(sealed.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", bytes, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as PlatformCredential;
}
