import { defineConfig, devices } from "@playwright/test";

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
