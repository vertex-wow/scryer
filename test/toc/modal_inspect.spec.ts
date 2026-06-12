import { test } from "@playwright/test";
import { renderTocFixture } from "./helpers";
import * as path from "path";
import * as fs from "fs";

test("Inspect Modal Dialog Borders", async ({ page }) => {
  await renderTocFixture(page, path.resolve("test/manual/ExampleFrameModalDialog__Vertex"));
  await page.waitForTimeout(500);

  const els = await page.locator("#viewport *").all();
  let out = "";
  for (const el of els) {
    const tag = await el.evaluate((e) => e.tagName);
    const kind = (await el.getAttribute("data-kind")) || "";
    const name = (await el.getAttribute("data-name")) || "";
    const asset = (await el.getAttribute("data-asset-path")) || "";
    if (kind || name || asset) {
      const s = await el.evaluate((e) => {
        const cs = window.getComputedStyle(e);
        return `left:${cs.left}, top:${cs.top}, w:${cs.width}, h:${cs.height}, bg:${cs.backgroundImage}`;
      });
      out += `tag:${tag} name:${name} kind:${kind} asset:${asset} -> ${s}\n`;
    }
  }
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync("test-results/inspect_output.txt", out);
});
