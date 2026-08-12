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
          CLERK_SECRET_KEY: "",
          CONVEX_URL: "",
          CONVEX_DEPLOY_KEY: "",
          GATEWAY_INTERNAL_SECRET: "",
        },
      },
    }),
  ],
  test: {
    allowOnly: false,
    // Keep fuzz runs deterministic-ish; individual tests set their own seeds.
    testTimeout: 60_000,
  },
});
