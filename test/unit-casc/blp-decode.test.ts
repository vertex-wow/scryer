/**
 * CASC BLP decode tests — require a populated scryer.cacheDir.
 *
 * Set scryer.cacheDir in dev/settings.local.json then run:
 *   pnpm test:casc
 *
 * These are skipped automatically when the directory is not configured.
 */

import * as path from "path";
import { PNG } from "pngjs";
import { blpToPng } from "../../src/assets/blp";
import { getExtractedAssetsDir } from "./helpers";

const assetsDir = getExtractedAssetsDir();

const describeIf = (condition: boolean) => (condition ? describe : describe.skip);

describeIf(assetsDir !== null)("CASC BLP decode", () => {
  // Mirrors the texture used in test/manual/direct_texture.xml.
  test("decodes Interface/Buttons/UI-CheckBox-Check.blp to a valid PNG", () => {
    const blpPath = path.join(assetsDir!, "Interface", "Buttons", "UI-CheckBox-Check.blp");
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
