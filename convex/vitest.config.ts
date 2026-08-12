import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const convexDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: convexDir,
  test: {
    allowOnly: false,
    environment: "edge-runtime",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.ts"],
    // Keep vitest out of apps/* — this config is convex-only.
    exclude: ["node_modules/**", "_generated/**"],
  },
});
