import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.output/**",
      "**/.nitro/**",
      "**/coverage/**",
      ".agents/**",
      "apps/web/src/routeTree.gen.ts",
      "apps/gateway/worker-configuration.d.ts",
      "convex/_generated/**",
    ],
  },
  {
    ...js.configs.recommended,
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ...js.configs.recommended.languageOptions,
      globals: globals.node,
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: {
      "jsx-a11y": jsxA11y,
      "react-hooks": reactHooks,
    },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: [
      "apps/gateway/**/*.{ts,tsx}",
      "convex/**/*.{ts,tsx}",
      "packages/shared/**/*.{ts,tsx}",
      "e2e/**/*.{ts,tsx}",
      "scripts/**/*.{ts,tsx}",
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...globals.worker },
    },
  },
  {
    files: ["**/*.{test,spec}.{ts,tsx}", "**/test/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.node,
    },
  },
);
