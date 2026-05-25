import * as fs from "fs";
import BLPFile from "js-blp";
import { PNG } from "pngjs";

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
