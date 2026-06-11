import * as fs from "fs";
import BLPFile from "js-blp";
import { PNG } from "pngjs";

const BLP2_MAGIC = 0x32504c42; // 'BLP2' LE
const BLP_HEADER_SIZE = 148; // 4+4+1+1+1+1+4+4+64+64

/**
 * Decode BLP bytes to a PNG-encoded Buffer.
 * Throws if the bytes are not a valid BLP or the variant is unsupported.
 */
export function blpToPngBuffer(buf: Buffer): Buffer {
  const blp = new BLPFile(buf);
  const pixels = blp.getPixels(0);
  const rgba = pixels.raw;

  const png = new PNG({ width: blp.width, height: blp.height });
  png.data = rgba;
  return PNG.sync.write(png);
}

/**
 * Decode a BLP file to a PNG-encoded Buffer.
 * Throws if the file is not a valid BLP or the variant is unsupported.
 */
export function blpToPng(absPath: string): Buffer {
  const raw = fs.readFileSync(absPath);
  const blp = new BLPFile(raw);
  const pixels = blp.getPixels(0);
  const rgba = pixels.raw; // Buffer: width * height * 4 RGBA bytes

  const png = new PNG({ width: blp.width, height: blp.height });
  png.data = rgba;
  return PNG.sync.write(png);
}

/**
 * Encode a PNG file as a BLP2 raw-BGRA file (encoding=3, single mip).
 * Readable by js-blp and the WoW client. Intended for dev tooling and test
 * fixtures — raw BGRA is uncompressed and large, not suitable for shipping.
 */
export function pngToBlp(pngPath: string, blpPath: string): void {
  const { width, height, data } = PNG.sync.read(fs.readFileSync(pngPath));

  const pixelData = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixelData[i * 4 + 0] = data[i * 4 + 2]; // B
    pixelData[i * 4 + 1] = data[i * 4 + 1]; // G
    pixelData[i * 4 + 2] = data[i * 4 + 0]; // R
    pixelData[i * 4 + 3] = data[i * 4 + 3]; // A
  }

  const header = Buffer.alloc(BLP_HEADER_SIZE, 0);
  header.writeUInt32LE(BLP2_MAGIC, 0);
  header.writeUInt32LE(1, 4); // type=1 (required by js-blp)
  header.writeUInt8(3, 8); // encoding=3 (raw BGRA)
  header.writeUInt8(8, 9); // alphaDepth=8
  header.writeUInt32LE(width, 12);
  header.writeUInt32LE(height, 16);
  header.writeUInt32LE(BLP_HEADER_SIZE, 20); // mapOffsets[0]
  header.writeUInt32LE(pixelData.length, 84); // mapSizes[0]

  fs.writeFileSync(blpPath, Buffer.concat([header, pixelData]));
}
