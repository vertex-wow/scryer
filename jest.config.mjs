/** @type {import('jest').Config} */
const config = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
  moduleNameMapper: {
    "^vscode$": "<rootDir>/test/__mocks__/vscode.ts",
  },
  resetMocks: true,
};

export default config;
