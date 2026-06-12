/**
 * CASC BLP decode tests — require a populated scryer.cacheDir.
 *
 * Set scryer.cacheDir in dev/settings.local.json then run:
 *   pnpm test:casc
 *
 * Errors as misconfigured when the directory is not configured.
 */

import * as fs from "fs";
import { PNG } from "pngjs";
import { blpToPng } from "../../src/assets/blp";
import { extractPaths, shutdownAssetClient } from "../../src/assets/extract-core";
import { resolveCI } from "../../src/parser/blizzard-registry";
import { getExtractedAssetsDir, makeExtractCoreOpts, requireExtractedAssetsDir } from "./helpers";

const assetsDir = getExtractedAssetsDir();

const BLP_SUBPATH = "interface/tooltips/tooltip.blp";

describe("CASC BLP decode", () => {
  beforeAll(async () => {
    requireExtractedAssetsDir();
    if (!fs.existsSync(resolveCI(assetsDir!, BLP_SUBPATH))) {
      const coreOpts = makeExtractCoreOpts();
      if (coreOpts) await extractPaths([BLP_SUBPATH], coreOpts, "user");
    }
  }, 120_000);

  afterAll(async () => {
    await shutdownAssetClient();
  });
  test("decodes Interface/Tooltips/Tooltip.blp to a valid PNG", () => {
    const blpPath = resolveCI(assetsDir!, BLP_SUBPATH);
    const pngBuf = blpToPng(blpPath);

    // PNG magic: 0x89 P N G
    expect(pngBuf[0]).toBe(0x89);
    expect(pngBuf[1]).toBe(0x50);
    expect(pngBuf[2]).toBe(0x4e);
    expect(pngBuf[3]).toBe(0x47);

    // Decode and sanity-check dimensions.
    const img = PNG.sync.read(pngBuf);
    expect(img.width).toBeGreaterThan(0);
    expect(img.height).toBeGreaterThan(0);

    // At least some non-transparent pixels (not a blank decode).
    const hasVisiblePixels = Array.from(
      { length: img.width * img.height },
      (_, i) => img.data[i * 4 + 3],
    ).some((a) => a > 0);
    expect(hasVisiblePixels).toBe(true);
  });
});
