import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["tests/**/*.test.ts"],
    maxWorkers: 2,
    allowOnly: false,
  },
});
