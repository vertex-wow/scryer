/** @type {import('jest').Config} */
const config = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
    "^.+\\.lua$": "<rootDir>/test/transforms/lua-text.mjs",
  },
  moduleNameMapper: {
    // Strip .js from relative imports so ts-jest resolves .ts source files.
    "^(\\.{1,2}/.+)\\.js$": "$1",
    "^vscode$": "<rootDir>/test/__mocks__/vscode.ts",
  },
  resetMocks: true,
};

export default config;
