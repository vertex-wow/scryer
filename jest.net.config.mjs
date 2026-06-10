/** @type {import('jest').Config} */
const config = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/net/**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.+)\\.js$": "$1",
    "^vscode$": "<rootDir>/test/unit/__mocks__/vscode.ts",
  },
  resetMocks: true,
};

export default config;
