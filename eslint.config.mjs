import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["node_modules/**", ".idea/**"] },
  {
    ...js.configs.recommended,
    files: ["**/*.{js,mjs,ts,mts}"],
    languageOptions: { globals: globals.nodeBuiltin },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.{ts,mts}"],
  })),
  {
    files: ["**/*.{js,mjs,ts,mts}"],
    languageOptions: { sourceType: "module" },
  },
  {
    files: ["**/*.{ts,mts}"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  // Formatting belongs to Prettier, not competing ESLint style rules.
  prettier,
  {
    files: ["**/*.{js,mjs,ts,mts}"],
    rules: {
      curly: ["error", "all"],
    },
  },
];
