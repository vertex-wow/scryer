import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(tseslint.configs.recommended, prettier, {
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
  },
  ignores: ["dist/", "node_modules/"],
});
