/**
 * Fast BLP2 decoder using typed arrays throughout.
 *
 * js-blp (the npm package) accumulates decoded pixels into plain JS Arrays, which
 * triggers repeated array-growth and GC pressure. For a 1024×1024 DXT1 texture that
 * produces 4 MB of RGBA output, this costs ~4 s on a modern CPU.
 *
 * This module replaces the hot decode paths with Buffer.alloc + Uint8Array operations
 * that V8 can JIT-compile to near-native speed.
 *
 * Supported encodings (covering the entire retail Interface/ corpus):
 *   encoding=2 + alphaBitDepth=0   → DXT1 (no alpha)
 *   encoding=2 + alphaEncoding=7   → DXT5 (interpolated alpha)
 *   encoding=2 + alphaEncoding≠7   → DXT3 (explicit alpha)
 *   encoding=3                      → raw BGRA (direct channel swap)
 *
 * Encoding=1 (palette) is not implemented here; call through to js-blp for that path.
 */

const BLP2_MAGIC = 0x32504c42; // 'BLP2' little-endian

/** Decode a BLP2 buffer to raw RGBA bytes + dimensions. Throws on unsupported formats. */
export function blpToRgba(buf: Buffer): { rgba: Buffer; width: number; height: number } {
  if (buf.readUInt32LE(0) !== BLP2_MAGIC) throw new Error("Not a BLP2 file");
  if (buf.readUInt32LE(4) !== 1) throw new Error("Unsupported BLP type (not 1)");

  const encoding = buf.readUInt8(8);
  const alphaDepth = buf.readUInt8(9);
  const alphaEncoding = buf.readUInt8(10);
  const width = buf.readUInt32LE(12);
  const height = buf.readUInt32LE(16);
  // Mip 0: offset at byte 20, size at byte 84 (offset 20 + 16*4 = 84)
  const mapOffset = buf.readUInt32LE(20);
  const mapSize = buf.readUInt32LE(84);

  const raw = buf.subarray(mapOffset, mapOffset + mapSize);
  const pixelCount = width * height;

  if (encoding === 3) {
    // Raw BGRA: swap B↔R channels into RGBA
    const rgba = Buffer.allocUnsafe(pixelCount * 4);
    for (let i = 0; i < raw.length; i += 4) {
      rgba[i] = raw[i + 2];
      rgba[i + 1] = raw[i + 1];
      rgba[i + 2] = raw[i];
      rgba[i + 3] = raw[i + 3];
    }
    return { rgba, width, height };
  }

  if (encoding === 2) {
    const isDXT1 = alphaDepth <= 1;
    const isDXT5 = !isDXT1 && alphaEncoding === 7;
    const isDXT3 = !isDXT1 && !isDXT5;
    const blockBytes = isDXT1 ? 8 : 16;
    const rgba = Buffer.alloc(pixelCount * 4);

    // Reusable per-block buffers — allocated once, reused every block
    const colors = new Uint8Array(16); // 4 RGBA entries (4 bytes each)
    const alphaTable = new Uint8Array(8); // DXT5: 8 interpolated alpha values
    const alphaIdx = new Uint8Array(16); // DXT5: 16 decoded 3-bit alpha indices

    let pos = 0;
    for (let by = 0; by < height; by += 4) {
      for (let bx = 0; bx < width; bx += 4) {
        const colorOff = isDXT1 ? pos : pos + 8;

        // Decode two RGB565 color endpoints
        const c0 = raw.readUInt16LE(colorOff);
        const c1 = raw.readUInt16LE(colorOff + 2);
        const r0 = ((((c0 >> 11) & 0x1f) * 255) / 31) | 0;
        const g0 = ((((c0 >> 5) & 0x3f) * 255) / 63) | 0;
        const b0 = (((c0 & 0x1f) * 255) / 31) | 0;
        const r1 = ((((c1 >> 11) & 0x1f) * 255) / 31) | 0;
        const g1 = ((((c1 >> 5) & 0x3f) * 255) / 63) | 0;
        const b1 = (((c1 & 0x1f) * 255) / 31) | 0;

        colors[0] = r0;
        colors[1] = g0;
        colors[2] = b0;
        colors[3] = 255;
        colors[4] = r1;
        colors[5] = g1;
        colors[6] = b1;
        colors[7] = 255;

        if (isDXT1 && c0 <= c1) {
          // Punch-through: 3rd color is midpoint, 4th is transparent black
          colors[8] = (r0 + r1) >> 1;
          colors[9] = (g0 + g1) >> 1;
          colors[10] = (b0 + b1) >> 1;
          colors[11] = 255;
          colors[12] = 0;
          colors[13] = 0;
          colors[14] = 0;
          colors[15] = 0;
        } else {
          colors[8] = ((2 * r0 + r1) / 3) | 0;
          colors[9] = ((2 * g0 + g1) / 3) | 0;
          colors[10] = ((2 * b0 + b1) / 3) | 0;
          colors[11] = 255;
          colors[12] = ((r0 + 2 * r1) / 3) | 0;
          colors[13] = ((g0 + 2 * g1) / 3) | 0;
          colors[14] = ((b0 + 2 * b1) / 3) | 0;
          colors[15] = 255;
        }

        // 2-bit color index table (32 bits, little-endian, 2 bits per pixel)
        const colorIndices = raw.readUInt32LE(colorOff + 4);

        // DXT5: decode 8 alpha values and unpack 16 3-bit alpha indices
        if (isDXT5) {
          const a0 = raw[pos];
          const a1 = raw[pos + 1];
          alphaTable[0] = a0;
          alphaTable[1] = a1;
          if (a0 > a1) {
            for (let i = 1; i < 7; i++) alphaTable[i + 1] = (((7 - i) * a0 + i * a1) / 7) | 0;
          } else {
            for (let i = 1; i < 5; i++) alphaTable[i + 1] = (((5 - i) * a0 + i * a1) / 5) | 0;
            alphaTable[6] = 0;
            alphaTable[7] = 255;
          }
          // Unpack 6 bytes → 16 × 3-bit indices (two 24-bit groups of 8)
          const lo = raw[pos + 2] | (raw[pos + 3] << 8) | (raw[pos + 4] << 16);
          const hi = raw[pos + 5] | (raw[pos + 6] << 8) | (raw[pos + 7] << 16);
          for (let i = 0; i < 8; i++) alphaIdx[i] = (lo >>> (i * 3)) & 7;
          for (let i = 0; i < 8; i++) alphaIdx[i + 8] = (hi >>> (i * 3)) & 7;
        }

        // Write 16 pixels (4×4 block) into the output buffer
        for (let py = 0; py < 4; py++) {
          const sy = by + py;
          if (sy >= height) continue;
          const rowOff = (sy * width + bx) * 4;

          for (let px = 0; px < 4; px++) {
            const sx = bx + px;
            if (sx >= width) continue;

            const pi = py * 4 + px;
            const ci = (colorIndices >>> (pi * 2)) & 3;
            const dstOff = rowOff + px * 4;

            rgba[dstOff] = colors[ci * 4];
            rgba[dstOff + 1] = colors[ci * 4 + 1];
            rgba[dstOff + 2] = colors[ci * 4 + 2];
            rgba[dstOff + 3] = colors[ci * 4 + 3];

            if (isDXT5) {
              rgba[dstOff + 3] = alphaTable[alphaIdx[pi]];
            } else if (isDXT3) {
              // 4-bit explicit alpha per pixel, packed two-per-byte
              const abyte = raw[pos + (pi >> 1)];
              rgba[dstOff + 3] = (pi % 2 === 0 ? abyte & 0xf : (abyte >> 4) & 0xf) * 17;
            }
          }
        }

        pos += blockBytes;
      }
    }
    return { rgba, width, height };
  }

  throw new Error(`BLP encoding ${encoding} not supported by fast decoder`);
}
