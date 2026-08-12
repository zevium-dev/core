import { describe, expect, it } from "vitest";

import { applyProductionEnv } from "./build-env.mjs";

describe("applyProductionEnv", () => {
  it("overrides inherited dev values with production values", () => {
    const env = {
      CLERK_PUBLISHABLE_KEY: "pk_test_dev_server",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_test_dev_browser",
      VITE_CONVEX_URL: "https://dev.convex.cloud",
    };

    applyProductionEnv(
      env,
      [
        "CLERK_PUBLISHABLE_KEY=pk_live_production",
        "VITE_CONVEX_URL=https://production.convex.cloud",
      ].join("\n"),
    );

    expect(env.CLERK_PUBLISHABLE_KEY).toBe("pk_live_production");
    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBe("pk_live_production");
    expect(env.VITE_CONVEX_URL).toBe("https://production.convex.cloud");
  });

  it("aligns browser Clerk with a shell-provided server key", () => {
    const env = {
      CLERK_PUBLISHABLE_KEY: "pk_live_production",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_test_stale",
    };

    applyProductionEnv(env);

    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBe("pk_live_production");
  });

  it("retains a standalone browser key when no server key is supplied", () => {
    const env = { VITE_CLERK_PUBLISHABLE_KEY: "pk_live_ci" };

    applyProductionEnv(env);

    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBe("pk_live_ci");
  });
});
