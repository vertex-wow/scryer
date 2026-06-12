import { test } from "@playwright/test";
import { renderTocFixtureWithBlizzard, getBlizzardAddonsDir } from "./helpers";
import * as path from "path";
import * as fs from "fs";

test("Inspect Modal Dialog Borders with CASC", async ({ page }) => {
  const addonsDir = getBlizzardAddonsDir();
  await renderTocFixtureWithBlizzard(
    page,
    path.resolve("test/manual/ExampleFrameModalDialog__Vertex"),
    addonsDir!,
  );
  await page.waitForTimeout(500);

  const els = await page.locator('#viewport [data-kind="Texture"]').all();
  let out = "";
  for (const el of els) {
    const name = await el.getAttribute("data-name");
    const assetPath = await el.getAttribute("data-asset-path");
    const atlasCrop = await el.getAttribute("data-atlas-crop");
    const bgSize = await el.evaluate((e) => window.getComputedStyle(e).backgroundSize);
    const bgPos = await el.evaluate((e) => window.getComputedStyle(e).backgroundPosition);
    const bgRep = await el.evaluate((e) => window.getComputedStyle(e).backgroundRepeat);
    const rect = await el.boundingBox();
    out += `name: ${name}, Asset: ${assetPath}, Crop: ${atlasCrop}\n`;
    out += `Rect: ${JSON.stringify(rect)}\n`;
    out += `bgSize: ${bgSize}, bgPos: ${bgPos}, bgRep: ${bgRep}\n\n`;
  }
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync("test-results/inspect_output_casc.txt", out);
});
