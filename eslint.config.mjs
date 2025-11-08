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

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- drizzle plugin does not ship types
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

export default defineConfig(
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  eslintReact.configs["recommended-type-checked"],
  reactHooks.configs["recommended-latest"],
  reactCompiler.configs.recommended,
  ...pluginRouter.configs["flat/recommended"],
  perfectionist.configs["recommended-alphabetical"],
  preferArrayAt.configs.recommended,
  tailwind,
  {
    plugins: {
      drizzle,
    },
    rules: {
      ...drizzleRecommendedRules,
    },
  },
  {
    ignores: [".nitro", ".output", "node_modules", ".tanstack", "dist"],
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
