/// <reference types="bun" />
// Run with `bun test convex/lib`. Convex skips files with more than one dot, so this never deploys.
import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { parseSignedRequest, verifyMetaRequest } from "./signedRequest";

const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

function sign(payload: object, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  return `${b64url(createHmac("sha256", secret).update(body).digest())}.${body}`;
}

const payload = { algorithm: "HMAC-SHA256", user_id: "17841400000000001", issued_at: 1_700_000_000 };

describe("parseSignedRequest", () => {
  test("accepts a request signed with the app secret", async () => {
    expect(await parseSignedRequest(sign(payload, "s3cret"), "s3cret")).toEqual({ userId: "17841400000000001", issuedAt: 1_700_000_000 });
  });

  test("rejects another app's signature", async () => {
    expect(await parseSignedRequest(sign(payload, "other"), "s3cret")).toBeNull();
  });

  test("rejects a payload changed after signing", async () => {
    const [signature] = sign(payload, "s3cret").split(".");
    const forged = b64url(JSON.stringify({ ...payload, user_id: "1" }));
    expect(await parseSignedRequest(`${signature}.${forged}`, "s3cret")).toBeNull();
  });

  test("rejects malformed input and other algorithms", async () => {
    expect(await parseSignedRequest("", "s3cret")).toBeNull();
    expect(await parseSignedRequest("abc", "s3cret")).toBeNull();
    expect(await parseSignedRequest("a.b.c", "s3cret")).toBeNull();
    expect(await parseSignedRequest(sign({ ...payload, algorithm: "none" }, "s3cret"), "s3cret")).toBeNull();
    expect(await parseSignedRequest(sign({ algorithm: "HMAC-SHA256" }, "s3cret"), "s3cret")).toBeNull();
  });
});

describe("verifyMetaRequest", () => {
  const secrets = [
    { platform: "instagram" as const, secret: "ig" },
    { platform: "facebook" as const, secret: "fb" },
  ];

  test("reports which app signed it", async () => {
    expect((await verifyMetaRequest(sign(payload, "fb"), secrets))?.platform).toBe("facebook");
    expect((await verifyMetaRequest(sign(payload, "ig"), secrets))?.platform).toBe("instagram");
  });

  test("skips secrets that are not set", async () => {
    expect(await verifyMetaRequest(sign(payload, ""), [{ platform: "instagram", secret: undefined }])).toBeNull();
  });
});
