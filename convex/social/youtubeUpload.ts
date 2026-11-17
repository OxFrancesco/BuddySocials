/**
 * Uploads a stored video to YouTube with its resumable upload API:
 * https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
 *
 * The video is read from storage a piece at a time and passed straight on, so a large one never
 * sits in memory. The published SDK (0.5.0) can't do this job: it asks YouTube for a part it refuses,
 * fails on YouTube's "keep going" answer between pieces, and runs out of memory on a 100 MB video.
 */

const START = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
/** YouTube takes pieces in multiples of 256 KB. */
const PIECE = 16 * 1024 * 1024;

type Video = {
  /** Where the stored file can be read, with support for partial reads. */
  sourceUrl: string;
  byteSize: number;
  mimeType: string;
  title: string;
  description: string;
  visibility: "public" | "unlisted" | "private";
};

/** What YouTube's refusals mean for the person posting. */
async function refusal(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string; errors?: { reason?: string }[] } } | null;
  const reason = body?.error?.errors?.[0]?.reason ?? "";
  console.error("youtube upload", response.status, reason, body?.error?.message ?? "");
  if (response.status === 401) return new Error("Sign in to YouTube again, then publish.");
  if (reason === "quotaExceeded" || reason === "uploadLimitExceeded") {
    return new Error("YouTube's upload limit for today is reached. Publish again tomorrow.");
  }
  if (reason === "insufficientPermissions" || reason === "forbidden") return new Error("Sign in to YouTube again to allow posting.");
  if (reason === "youtubeSignupRequired") return new Error("This Google account has no YouTube channel yet. Create one on YouTube, then publish.");
  return new Error(`YouTube refused the video${body?.error?.message ? `: ${body.error.message}` : ` (HTTP ${response.status})`}`);
}

/** Uploads the video and returns its YouTube ID. */
export async function uploadToYouTube(video: Video, accessToken: string): Promise<string> {
  const start = await fetch(START, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-length": String(video.byteSize),
      "x-upload-content-type": video.mimeType,
    },
    body: JSON.stringify({
      snippet: { title: video.title, description: video.description },
      status: { privacyStatus: video.visibility, selfDeclaredMadeForKids: false },
    }),
  });
  if (!start.ok) throw await refusal(start);
  const session = start.headers.get("location");
  if (!session || !session.startsWith("https://www.googleapis.com/")) throw new Error("YouTube didn't say where to upload the video. Publish again.");
  for (let from = 0; from < video.byteSize; from += PIECE) {
    const to = Math.min(from + PIECE, video.byteSize) - 1;
    const piece = await fetch(video.sourceUrl, { headers: { range: `bytes=${from}-${to}` } });
    const bytes = piece.status === 206 ? await piece.arrayBuffer() : null;
    if (bytes === null || bytes.byteLength !== to - from + 1) throw new Error("The video couldn't be read from storage. Publish again.");
    // YouTube answers every piece but the last with 308, which fetch would otherwise treat as a redirect.
    const sent = await fetch(session, {
      method: "PUT",
      headers: { "content-type": video.mimeType, "content-range": `bytes ${from}-${to}/${video.byteSize}` },
      body: bytes,
      redirect: "manual",
    });
    if (sent.status === 308) continue;
    if (!sent.ok) throw await refusal(sent);
    const id = ((await sent.json().catch(() => null)) as { id?: string } | null)?.id;
    if (!id) throw new Error("YouTube took the video but didn't say where it is. Check YouTube before publishing again.");
    return id;
  }
  throw new Error("YouTube didn't confirm the upload. Check YouTube before publishing again, so it isn't posted twice.");
}

/**
 * Sets a video's thumbnail. YouTube only lets verified channels do this, and says so when it refuses.
 * https://developers.google.com/youtube/v3/docs/thumbnails/set
 */
export async function setYouTubeThumbnail(videoId: string, image: Blob, accessToken: string): Promise<void> {
  const response = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?uploadType=media&videoId=${encodeURIComponent(videoId)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": image.type || "image/jpeg" },
    body: image,
  });
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as { error?: { message?: string; errors?: { reason?: string }[] } } | null;
  const reason = body?.error?.errors?.[0]?.reason ?? "";
  console.error("youtube thumbnail", response.status, reason, body?.error?.message ?? "");
  if (response.status === 401) throw new Error("Sign in to YouTube again to set the cover.");
  if (response.status === 403) throw new Error("YouTube didn't allow the cover. Custom thumbnails need a verified channel: youtube.com/verify.");
  throw new Error(`YouTube refused the cover${body?.error?.message ? `: ${body.error.message}` : ` (HTTP ${response.status})`}`);
}
