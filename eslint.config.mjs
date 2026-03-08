// @ts-check

import preferArrayAt from "@boi.gg/eslint-plugin-prefer-array-at";
import eslintReact from "@eslint-react/eslint-plugin";
import eslint from "@eslint/js";
import pluginRouter from "@tanstack/eslint-plugin-router";
import tailwindcss from "eslint-plugin-better-tailwindcss";
import drizzlePlugin from "eslint-plugin-drizzle";
import perfectionist from "eslint-plugin-perfectionist";
import reactCompiler from "eslint-plugin-react-compiler";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const drizzle = /** @type {import("eslint").ESLint.Plugin} */ (drizzlePlugin);
const drizzleRecommendedConfig = /** @type {import("eslint").Linter.Config} */ (drizzle.configs?.recommended ?? {});
const drizzleRecommendedRules = /** @type {import("eslint").Linter.RulesRecord} */ (
  drizzleRecommendedConfig.rules ?? {}
);

const tailwind = defineConfig({
  plugins: { "better-tailwindcss": tailwindcss },
  rules: {
    ...tailwindcss.configs["recommended-warn"].rules,
    "better-tailwindcss/enforce-consistent-line-wrapping": "off",
    "better-tailwindcss/no-unregistered-classes": "off",
  },
  settings: { "better-tailwindcss": { entryPoint: "./src/styles/app.css" } },
});

const tsFiles = ["**/*.{ts,tsx}"];

/** @param {import("eslint").Linter.FlatConfig[]} configs */
const scopeToTs = (configs) => configs.map((config) => (config.files ? config : { ...config, files: tsFiles }));

/** @type {Record<string, "readonly" | "writable">} */
const nodeGlobals = {
  Buffer: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  process: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
};

export default defineConfig(
  {
    ignores: [".nitro", ".output", "node_modules", ".tanstack", "dist"],
  },
  eslint.configs.recommended,
  eslintReact.configs.recommended,
  reactHooks.configs["recommended-latest"],
  reactCompiler.configs.recommended,
  perfectionist.configs["recommended-alphabetical"],
  preferArrayAt.configs.all,
  tailwind,
  {
    files: ["scripts/**/*.{js,cjs,mjs}"],
    languageOptions: {
      globals: nodeGlobals,
    },
  },
  {
    files: tsFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...scopeToTs(tseslint.configs.strictTypeChecked),
  ...scopeToTs(tseslint.configs.stylisticTypeChecked),
  {
    ...eslintReact.configs["recommended-type-checked"],
    files: tsFiles,
  },
  ...scopeToTs(pluginRouter.configs["flat/recommended"]),
  {
    files: tsFiles,
    plugins: {
      drizzle,
    },
    rules: {
      ...drizzleRecommendedRules,
    },
  },
  {
    files: tsFiles,
    rules: {
      "@eslint-react/no-context-provider": "off",
      "@typescript-eslint/array-type": ["warn", { default: "generic", readonly: "generic" }],
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/no-misused-promises": ["warn", { checksVoidReturn: false }],
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-unnecessary-condition": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/prefer-nullish-coalescing": ["warn"],
      "@typescript-eslint/restrict-template-expressions": ["warn", { allowBoolean: true, allowNumber: true }],
      "perfectionist/sort-imports": "warn",
      "perfectionist/sort-interfaces": "warn",
      "perfectionist/sort-jsx-props": "warn",
      "perfectionist/sort-named-imports": "warn",
      "perfectionist/sort-object-types": "warn",
      "perfectionist/sort-objects": "warn",
    },
  },
);
