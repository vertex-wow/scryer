declare module "js-blp" {
  interface BufoBridge {
    /** Underlying raw RGBA bytes (width * height * 4). */
    readonly raw: Buffer;
  }

  class BLPFile {
    constructor(data: Buffer | ArrayBuffer | ArrayBufferView);
    readonly width: number;
    readonly height: number;
    /** Returns mipmap 0 pixel data as interleaved RGBA bytes. */
    getPixels(mipmap?: number): BufoBridge;
  }

  export = BLPFile;
}
