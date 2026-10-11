import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
it("requires a next URL even when a legacy URL is set", () => {
  const env = {
    ...process.env,
    VITE_CONTROL_PLANE_MODE: "next",
    CLERK_SECRET_KEY: "fixture",
    VITE_BUILD_SHA: "0".repeat(40),
    VITE_CLERK_PUBLISHABLE_KEY: "fixture",
    VITE_CONVEX_URL: "https://legacy.invalid",
    VITE_GATEWAY_URL: "https://gateway.invalid",
  };
  delete env.VITE_NEXT_CONVEX_URL;
  const missing = spawnSync(
    process.execPath,
    [new URL("./build.mjs", import.meta.url).pathname, "--check-env"],
    { env, encoding: "utf8" },
  );
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain("VITE_NEXT_CONVEX_URL is required");
  const configured = spawnSync(
    process.execPath,
    [new URL("./build.mjs", import.meta.url).pathname, "--check-env"],
    {
      env: { ...env, VITE_NEXT_CONVEX_URL: "https://next.invalid" },
      encoding: "utf8",
    },
  );
  expect(configured.status).toBe(0);
});
