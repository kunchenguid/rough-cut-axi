import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "test-results/**", "coverage/**", ".lavish/**", ".gnhf/**", ".agents/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-regex-spaces": "off",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none", varsIgnorePattern: "^_" }],
    },
  },
];
