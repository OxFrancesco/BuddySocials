/**
 * Reads what platforms ask about a file before taking it, such as an image's size.
 */

/** A JPEG's width and height from its frame header, or null when it can't be read. */
export async function jpegSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  try {
    const view = new DataView(await blob.arrayBuffer());
    if (view.getUint16(0) !== 0xffd8) return null;
    let at = 2;
    while (at + 4 <= view.byteLength) {
      if (view.getUint8(at) !== 0xff) return null;
      const marker = view.getUint8(at + 1);
      // Fill bytes and markers without a length.
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      const length = view.getUint16(at + 2);
      // Start-of-frame markers, apart from the Huffman, arithmetic and JPEG-extension tables.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
      }
      at += 2 + length;
    }
    return null;
  } catch {
    return null;
  }
}
