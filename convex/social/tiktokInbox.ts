/**
 * Sends a video file to the creator's TikTok inbox, where they add the caption and choose who sees it.
 * The published SDK (0.5.0) only takes TikTok media from a URL on a domain verified with TikTok, so the
 * file upload is done here: https://developers.tiktok.com/doc/content-posting-api-reference-upload-video
 */

const API = "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
const MiB = 1024 * 1024;
/** TikTok takes a video of up to 64 MB in one piece; larger ones go in 5 to 64 MB chunks, the last holding the rest. */
const SINGLE_CHUNK_MAX = 64 * MiB;
const CHUNK = 10 * MiB;

/** Which byte ranges to send, in order. */
export function tiktokChunks(size: number): { start: number; end: number }[] {
  if (size <= SINGLE_CHUNK_MAX) return [{ start: 0, end: size }];
  const count = Math.floor(size / CHUNK);
  return Array.from({ length: count }, (_, index) => ({
    start: index * CHUNK,
    end: index === count - 1 ? size : (index + 1) * CHUNK,
  }));
}

/** What TikTok's error codes mean for the person posting. */
function refusal(code: string, message: string): Error {
  switch (code) {
    case "access_token_invalid":
      return new Error("Sign in to TikTok again, then publish.");
    case "scope_not_authorized":
      return new Error("Sign in to TikTok again to allow posting.");
    case "spam_risk_too_many_pending_share":
      return new Error("Your TikTok inbox has too many videos waiting. Post or delete some in the TikTok app, then publish again.");
    case "spam_risk_user_banned_from_posting":
      return new Error("TikTok isn't letting this account post right now.");
    case "rate_limit_exceeded":
      return new Error("TikTok asked us to slow down. Publish again in a minute.");
    default:
      return new Error(`TikTok refused the upload${message ? `: ${message}` : ` (${code})`}.`);
  }
}

/** Uploads the video and returns TikTok's publish ID, which says how the upload is going. */
export async function sendToTikTokInbox(video: Blob, mimeType: string, accessToken: string): Promise<string> {
  const chunks = tiktokChunks(video.size);
  const init = await fetch(API, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify({
      source_info: {
        source: "FILE_UPLOAD",
        video_size: video.size,
        chunk_size: chunks[0]!.end - chunks[0]!.start,
        total_chunk_count: chunks.length,
      },
    }),
  });
  const body = (await init.json().catch(() => null)) as {
    data?: { publish_id?: string; upload_url?: string };
    error?: { code?: string; message?: string };
  } | null;
  const code = body?.error?.code ?? (init.ok ? "ok" : `http_${init.status}`);
  if (code !== "ok") throw refusal(code, body?.error?.message ?? "");
  const publishId = body?.data?.publish_id;
  const uploadUrl = body?.data?.upload_url;
  if (!publishId || !uploadUrl) throw new Error("TikTok didn't say where to upload the video. Publish again.");
  // TikTok only hands out upload links on its own hosts; anything else would send the video somewhere unknown.
  const target = new URL(uploadUrl);
  if (target.protocol !== "https:" || !/^open-upload(?:-[a-z0-9]+)*\.tiktokapis\.com$/.test(target.hostname)) {
    throw new Error("TikTok gave an upload link outside its own servers, so the video wasn't sent.");
  }
  for (const { start, end } of chunks) {
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": mimeType,
        "content-range": `bytes ${start}-${end - 1}/${video.size}`,
      },
      body: await video.slice(start, end).arrayBuffer(),
    });
    if (!response.ok) throw new Error(`TikTok stopped the upload part way (HTTP ${response.status}). Publish again.`);
  }
  return publishId;
}
