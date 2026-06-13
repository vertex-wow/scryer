import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function luaTextPlugin() {
  return {
    name: "lua-text",
    transform(code: string, id: string) {
      if (id.endsWith(".lua")) {
        return { code: `export default ${JSON.stringify(code)}` };
      }
    },
  };
}

export default defineConfig({
  plugins: [luaTextPlugin()],
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "test/unit/__mocks__/vscode.vitest.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/unit/**/*.test.ts"],
    setupFiles: ["test/unit/setup.vitest.ts"],
    resetMocks: true,
  },
});
