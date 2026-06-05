import { defineConfig, devices } from "@playwright/test";
import { readFileSync } from "fs";
import { Module } from "module";

// Playwright has no .lua transform; mirror the Jest lua-text.mjs approach.
(
  Module as unknown as { _extensions: Record<string, (m: Module, filename: string) => void> }
)._extensions[".lua"] = function (m, filename) {
  const src = `module.exports = ${JSON.stringify(readFileSync(filename, "utf-8"))};`;
  (m as unknown as { _compile(code: string, filename: string): void })._compile(src, filename);
};

export default defineConfig({
  testDir: "test/toc",
  testMatch: "*.spec.ts",
  tsconfig: "./tsconfig.playwright.json",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1600, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 900 } },
    },
  ],
});
