import * as fs from "fs";
import { PNG } from "pngjs";
import { tgaToRgba } from "./tga-decode";

function encodeRgbaToPng(rgba: Buffer, width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data = rgba;
  return PNG.sync.write(png);
}

/** Decode TGA bytes to a PNG-encoded Buffer. Throws if unsupported. */
export function tgaToPngBuffer(buf: Buffer): Buffer {
  const { rgba, width, height } = tgaToRgba(buf);
  return encodeRgbaToPng(rgba, width, height);
}

/** Decode a TGA file to a PNG-encoded Buffer. Throws if unsupported. */
export function tgaToPng(absPath: string): Buffer {
  const buf = fs.readFileSync(absPath);
  const { rgba, width, height } = tgaToRgba(buf);
  return encodeRgbaToPng(rgba, width, height);
}
