import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
it("requires the canonical Convex URL", () => {
  const env = {
    ...process.env,
    CLERK_SECRET_KEY: "fixture",
    VITE_BUILD_SHA: "0".repeat(40),
    VITE_CLERK_PUBLISHABLE_KEY: "fixture",
    VITE_GATEWAY_URL: "https://gateway.invalid",
  };
  delete env.VITE_CONVEX_URL;
  const missing = spawnSync(
    process.execPath,
    [new URL("./build.mjs", import.meta.url).pathname, "--check-env"],
    { env, encoding: "utf8" },
  );
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain("VITE_CONVEX_URL is required");
  const configured = spawnSync(
    process.execPath,
    [new URL("./build.mjs", import.meta.url).pathname, "--check-env"],
    {
      env: { ...env, VITE_CONVEX_URL: "https://canonical.invalid" },
      encoding: "utf8",
    },
  );
  expect(configured.status).toBe(0);
});
