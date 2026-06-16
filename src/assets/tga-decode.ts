/**
 * TGA (Targa) decoder using typed arrays throughout.
 *
 * Supported image types:
 *   type 2  — uncompressed true-color (BGR / BGRA)
 *   type 10 — RLE-compressed true-color (BGR / BGRA)
 *
 * Supported pixel depths: 24 bpp (BGR) and 32 bpp (BGRA).
 * Output is always RGBA with channels swapped from TGA's BGR order.
 *
 * Origin: bit 5 of image descriptor byte (byte 17) controls row order.
 *   0 = bottom-to-top (most WoW addon TGAs) — flip applied on output.
 *   1 = top-to-bottom — no flip needed.
 */

export interface TgaDecodeResult {
  rgba: Buffer;
  width: number;
  height: number;
}

/** Decode a TGA buffer to raw RGBA bytes + dimensions. Throws on unsupported formats. */
export function tgaToRgba(buf: Buffer): TgaDecodeResult {
  const idLength = buf[0];
  const imageType = buf[2];
  const width = buf.readUInt16LE(12);
  const height = buf.readUInt16LE(14);
  const bitsPerPixel = buf[16];
  const descriptor = buf[17];
  const topToBottom = (descriptor & 0x20) !== 0;

  if (bitsPerPixel !== 24 && bitsPerPixel !== 32) {
    throw new Error(`Unsupported TGA bits-per-pixel: ${bitsPerPixel}`);
  }
  if (imageType !== 2 && imageType !== 10) {
    throw new Error(`Unsupported TGA image type: ${imageType}`);
  }

  const bpp = bitsPerPixel >> 3; // bytes per pixel: 3 or 4
  const dataOffset = 18 + idLength;
  const pixelCount = width * height;
  const rgba = Buffer.allocUnsafe(pixelCount * 4);

  if (imageType === 2) {
    decodeUncompressed(buf, dataOffset, rgba, pixelCount, bpp);
  } else {
    decodeRLE(buf, dataOffset, rgba, pixelCount, bpp);
  }

  if (!topToBottom) {
    flipVertical(rgba, width, height);
  }

  return { rgba, width, height };
}

function decodeUncompressed(
  src: Buffer,
  offset: number,
  dst: Buffer,
  pixelCount: number,
  bpp: number,
): void {
  let si = offset;
  let di = 0;
  if (bpp === 3) {
    for (let i = 0; i < pixelCount; i++) {
      dst[di] = src[si + 2]; // R ← B
      dst[di + 1] = src[si + 1]; // G
      dst[di + 2] = src[si]; // B ← R
      dst[di + 3] = 0xff; // A = opaque
      si += 3;
      di += 4;
    }
  } else {
    for (let i = 0; i < pixelCount; i++) {
      dst[di] = src[si + 2]; // R ← B
      dst[di + 1] = src[si + 1]; // G
      dst[di + 2] = src[si]; // B ← R
      dst[di + 3] = src[si + 3]; // A
      si += 4;
      di += 4;
    }
  }
}

function decodeRLE(
  src: Buffer,
  offset: number,
  dst: Buffer,
  pixelCount: number,
  bpp: number,
): void {
  let si = offset;
  let di = 0;
  let remaining = pixelCount;

  while (remaining > 0) {
    const header = src[si++];
    const count = (header & 0x7f) + 1;

    if (header & 0x80) {
      // Run-length packet: same pixel repeated count times
      const r = src[si + 2];
      const g = src[si + 1];
      const b = src[si];
      const a = bpp === 4 ? src[si + 3] : 0xff;
      si += bpp;
      for (let i = 0; i < count; i++) {
        dst[di] = r;
        dst[di + 1] = g;
        dst[di + 2] = b;
        dst[di + 3] = a;
        di += 4;
      }
    } else {
      // Raw packet: count distinct pixels
      for (let i = 0; i < count; i++) {
        dst[di] = src[si + 2];
        dst[di + 1] = src[si + 1];
        dst[di + 2] = src[si];
        dst[di + 3] = bpp === 4 ? src[si + 3] : 0xff;
        si += bpp;
        di += 4;
      }
    }
    remaining -= count;
  }
}

function flipVertical(rgba: Buffer, width: number, height: number): void {
  const rowBytes = width * 4;
  const row = Buffer.allocUnsafe(rowBytes);
  for (let top = 0, bottom = height - 1; top < bottom; top++, bottom--) {
    const topOff = top * rowBytes;
    const botOff = bottom * rowBytes;
    rgba.copy(row, 0, topOff, topOff + rowBytes);
    rgba.copy(rgba, topOff, botOff, botOff + rowBytes);
    row.copy(rgba, botOff);
  }
}
