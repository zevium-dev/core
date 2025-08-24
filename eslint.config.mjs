// @ts-check

import eslintReact from "@eslint-react/eslint-plugin";
import eslint from "@eslint/js";
import perfectionist from "eslint-plugin-perfectionist";
import reactCompiler from "eslint-plugin-react-compiler";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  eslintReact.configs["recommended-type-checked"],
  reactHooks.configs["recommended-latest"],
  reactCompiler.configs.recommended,
  perfectionist.configs["recommended-alphabetical"],
  {
    rules: {
      "perfectionist/sort-imports": "warn",
      "perfectionist/sort-interfaces": "warn",
      "perfectionist/sort-jsx-props": "warn",
      "perfectionist/sort-named-imports": "warn",
      "perfectionist/sort-object-types": "warn",
      "perfectionist/sort-objects": "warn",
    },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
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
    },
  },
  {
    ignores: [".nitro", ".output", "node_modules", ".tanstack"],
  },
);
