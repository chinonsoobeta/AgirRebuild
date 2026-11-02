export const PNG_IEND = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

/**
 * A logo's type from its first bytes (never its name), and its size from the PNG IHDR chunk or the JPEG start-of-frame marker.
 * By default the file must end with IEND or the JPEG end marker. Pictures may allow trailing phone-photo data.
 * This is not a decoder: a whole file with damaged image data still passes.
 */
export function imageInfo(b: Uint8Array, options: { allowTrailing?: boolean } = {}): { mime: "image/png" | "image/jpeg"; width: number; height: number } | "unknown" | "unreadable" {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const sized = (mime: "image/png" | "image/jpeg", width: number, height: number) => (width > 0 && height > 0 ? { mime, width, height } : "unreadable" as const);
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) {
    if (b.length < 45 || dv.getUint32(8) !== 13 || String.fromCharCode(...b.slice(12, 16)) !== "IHDR") return "unreadable";
    if (options.allowTrailing) {
      // Walk chunks rather than mistaking bytes inside compressed pixels for IEND.
      let at = 33, ended = false;
      while (at + 12 <= b.length) {
        if (PNG_IEND.every((x, i) => b[at + i] === x)) { ended = true; break; }
        at += 12 + dv.getUint32(at);
      }
      if (!ended) return "unreadable";
    } else if (!PNG_IEND.every((x, i) => b[b.length - 12 + i] === x)) return "unreadable";
    return sized("image/png", dv.getUint32(16), dv.getUint32(20));
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    if (!options.allowTrailing && (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9)) return "unreadable";
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return "unreadable";
      const marker = b[i + 1]!;
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) return "unreadable"; // the image data starts before any frame header
      const length = dv.getUint16(i + 2);
      if (length < 2) return "unreadable";
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (options.allowTrailing) {
          let ended = false;
          for (let at = i + 2 + length; at + 1 < b.length; at++) {
            if (b[at] === 0xff && b[at + 1] === 0xd9) { ended = true; break; }
          }
          if (!ended) return "unreadable";
        }
        return i + 9 <= b.length ? sized("image/jpeg", dv.getUint16(i + 7), dv.getUint16(i + 5)) : "unreadable";
      }
      i += 2 + length;
    }
    return "unreadable";
  }
  return "unknown";
}

// Only the multi-page refusal uses the count, and a crafted 75 MB file could otherwise hold over ten million directories.
const MAX_TIFF_DIRECTORIES = 1000;

/** Header and directory checks only: never decode or allocate pixels from untrusted dimensions. */
export function pictureInfo(bytes: Uint8Array): { format: "png" | "jpeg" | "tiff"; width: number; height: number; pages: number } | "unknown" | "unreadable" {
  const image = imageInfo(bytes, { allowTrailing: true });
  if (image !== "unknown") return image === "unreadable" ? image : { format: image.mime === "image/png" ? "png" : "jpeg", width: image.width, height: image.height, pages: 1 };
  const little = bytes[0] === 73 && bytes[1] === 73 && bytes[2] === 42 && bytes[3] === 0;
  const big = bytes[0] === 77 && bytes[1] === 77 && bytes[2] === 0 && bytes[3] === 42;
  if (!little && !big) return "unknown";
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = view.getUint32(4, little), width = 0, height = 0, pages = 0;
    const seen = new Set<number>();
    while (offset) {
      if (seen.has(offset) || offset < 8 || offset + 2 > bytes.length) return "unreadable";
      seen.add(offset);
      const count = view.getUint16(offset, little), end = offset + 2 + count * 12;
      if (end + 4 > bytes.length) return "unreadable";
      if (pages === 0) {
        for (let at = offset + 2; at < end; at += 12) {
          const tag = view.getUint16(at, little), type = view.getUint16(at + 2, little);
          if (tag !== 256 && tag !== 257) continue;
          if ((type !== 3 && type !== 4) || view.getUint32(at + 4, little) !== 1) return "unreadable";
          const value = type === 3 ? view.getUint16(at + 8, little) : view.getUint32(at + 8, little);
          if (tag === 256) width = value; else height = value;
        }
      }
      if (++pages > MAX_TIFF_DIRECTORIES) return "unreadable";
      offset = view.getUint32(end, little);
    }
    return width > 0 && height > 0 && pages > 0 ? { format: "tiff", width, height, pages } : "unreadable";
  } catch { return "unreadable"; }
}
