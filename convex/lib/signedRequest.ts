/**
 * Meta's `signed_request`: `<signature>.<payload>`, both base64url. The signature is
 * HMAC-SHA256 of the payload string, keyed with the app secret. Uses Web Crypto only,
 * so it runs in the default Convex runtime and under Bun.
 */

export type SignedRequest = {
  /** The app-scoped ID of the person who removed the app or asked for deletion. */
  userId: string;
  issuedAt: number | null;
};

function fromBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** Returns the request's user when the signature matches `secret`, otherwise null. */
export async function parseSignedRequest(signedRequest: string, secret: string): Promise<SignedRequest | null> {
  if (!secret) return null;
  const parts = signedRequest.split(".");
  if (parts.length !== 2) return null;
  const [encodedSignature, encodedPayload] = parts as [string, string];
  const signature = fromBase64url(encodedSignature);
  const payloadBytes = fromBase64url(encodedPayload);
  if (signature === null || payloadBytes === null || encodedPayload.length === 0) return null;
  if (!sameBytes(signature, await hmac(secret, encodedPayload))) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const { algorithm, user_id, issued_at } = payload as Record<string, unknown>;
  if (typeof algorithm !== "string" || algorithm.toUpperCase() !== "HMAC-SHA256") return null;
  const userId = typeof user_id === "string" || typeof user_id === "number" ? String(user_id) : "";
  if (userId === "") return null;
  return { userId, issuedAt: typeof issued_at === "number" ? issued_at : null };
}

/** Tries each configured app secret. `platform` says whose app signed it. */
export async function verifyMetaRequest<P extends string>(
  signedRequest: string,
  secrets: readonly { platform: P; secret: string | undefined }[],
): Promise<(SignedRequest & { platform: P }) | null> {
  for (const { platform, secret } of secrets) {
    if (!secret) continue;
    const parsed = await parseSignedRequest(signedRequest, secret);
    if (parsed !== null) return { ...parsed, platform };
  }
  return null;
}
