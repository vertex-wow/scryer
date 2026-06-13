import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "test/unit/__mocks__/vscode.vitest.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/unit-casc/**/*.test.ts"],
    setupFiles: ["test/unit/setup.vitest.ts"],
    resetMocks: true,
  },
});
