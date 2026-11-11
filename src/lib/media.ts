import { File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { MEDIA_RULES } from "@shared/drafts";

/** A JPEG on this phone with its real pixel size, orientation already applied. */
export type LocalImage = { uri: string; width: number; height: number };

export const SHAPES = [
  { value: "original", label: "Original", ratio: null },
  { value: "1:1", label: "1:1", ratio: 1 },
  { value: "4:5", label: "4:5", ratio: 4 / 5 },
  { value: "16:9", label: "16:9", ratio: 16 / 9 },
] as const;

export type Shape = (typeof SHAPES)[number]["value"];

/** An edit is always applied to the original: quarter turns clockwise, then the mirror, then the centre crop. */
export type ImageEdit = { shape: Shape; turns: number; flip: boolean };

export const NO_EDIT: ImageEdit = { shape: "original", turns: 0, flip: false };

export function isEdited(edit: ImageEdit): boolean {
  return edit.shape !== "original" || edit.turns % 4 !== 0 || edit.flip;
}

/** X takes at most 4096 px a side. */
const MAX_SIDE = 4096;
/** The smallest image limit of any platform (X: 5 MB), so one file suits them all. */
const TARGET_BYTES = Math.min(...Object.values(MEDIA_RULES).map((rule) => rule.imageBytes));
const QUALITIES = [0.9, 0.8, 0.65];

/** The image's size after its quarter turns. */
export function turned(image: { width: number; height: number }, turns: number) {
  return turns % 2 === 0 ? { width: image.width, height: image.height } : { width: image.height, height: image.width };
}

/** The largest centred rectangle of the given width/height ratio, in whole pixels. */
export function centreCrop(width: number, height: number, ratio: number) {
  const cropWidth = Math.max(1, Math.min(width, Math.round(height * ratio)));
  const cropHeight = Math.max(1, Math.min(height, Math.round(width / ratio)));
  return { originX: Math.floor((width - cropWidth) / 2), originY: Math.floor((height - cropHeight) / 2), width: cropWidth, height: cropHeight };
}

export function sizeOf(uri: string): number {
  return new File(uri).size;
}

/**
 * Renders an image as a JPEG every platform takes: HEIC and WebP become JPEG, the long
 * side is capped at 4096 px, and quality drops a step while the file is over X's 5 MB.
 */
export async function renderImage(source: { uri: string; width?: number; height?: number }, edit: ImageEdit = NO_EDIT): Promise<LocalImage> {
  // The cap is applied while decoding, so a huge photo never sits in memory at full size.
  const context = ImageManipulator.manipulate(source.uri, { maxWidth: MAX_SIDE, maxHeight: MAX_SIDE });
  const loaded = await context.renderAsync();
  let { width, height } = loaded;
  const turns = ((edit.turns % 4) + 4) % 4;
  if (turns !== 0) {
    context.rotate(turns * 90);
    ({ width, height } = turned({ width, height }, turns));
  }
  if (edit.flip) context.flip("horizontal");
  const ratio = SHAPES.find((shape) => shape.value === edit.shape)?.ratio ?? null;
  if (ratio !== null) {
    const rect = centreCrop(width, height, ratio);
    context.crop(rect);
    ({ width, height } = rect);
  }
  const image = await context.renderAsync();
  try {
    let saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: QUALITIES[0] });
    for (const quality of QUALITIES.slice(1)) {
      if (sizeOf(saved.uri) <= TARGET_BYTES) break;
      saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: quality });
    }
    return { uri: saved.uri, width: saved.width, height: saved.height };
  } finally {
    image.release();
    loaded.release();
    context.release();
  }
}

/** Fetches a saved draft's image to the cache so it can be edited. */
export async function downloadImage(url: string, name: string): Promise<string> {
  const file = await File.downloadFileAsync(url, new File(Paths.cache, `edit-${name}`), { idempotent: true });
  return file.uri;
}

/**
 * Sends a file to an upload URL straight from disk, so a large video never sits in
 * JS memory. `onProgress` gets a fraction from 0 to 1.
 */
export async function uploadFile(uri: string, mimeType: string, uploadUrl: string, onProgress?: (fraction: number) => void): Promise<string> {
  const result = await new File(uri).upload(uploadUrl, {
    httpMethod: "POST",
    headers: { "Content-Type": mimeType },
    mimeType,
    onProgress: onProgress ? ({ bytesSent, totalBytes }) => onProgress(totalBytes > 0 ? Math.min(1, bytesSent / totalBytes) : 0) : undefined,
  });
  if (result.status < 200 || result.status >= 300) throw new Error("Upload failed");
  const { storageId } = JSON.parse(result.body) as { storageId?: string };
  if (!storageId) throw new Error("Upload failed");
  return storageId;
}

/** "0:42" for a video's length in milliseconds. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
