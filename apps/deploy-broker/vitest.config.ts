import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    allowOnly: false,
    include: ["test/unit/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
