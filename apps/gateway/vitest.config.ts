import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // .dev.vars (local wrangler dev creds) must not leak into tests —
      // fixtures configure their own sources; empty bindings keep runs hermetic.
      miniflare: {
        bindings: {
          NEXT_DEPLOYMENT_ID: "next-fixture",
          NEXT_ADMISSION_KEYS: JSON.stringify({
            current: "k1",
            keys: { k1: "test-only-secret-never-use-in-production" },
          }),
          CLERK_SECRET_KEY: "",
          CONVEX_URL: "",
          GATEWAY_INTERNAL_SECRET: "test-admission-secret",
        },
      },
    }),
  ],
  test: {
    allowOnly: false,
    maxWorkers: 2,
    // Keep fuzz runs deterministic-ish; individual tests set their own seeds.
    testTimeout: 60_000,
  },
});
