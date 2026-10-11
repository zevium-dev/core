import { afterEach, expect, it, vi } from "vitest";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
it("keeps legacy default and refuses a next switch without its own URL", async () => {
  vi.stubEnv("VITE_CONTROL_PLANE_MODE", "");
  vi.stubEnv("VITE_CONVEX_URL", "https://legacy.invalid");
  vi.stubEnv("VITE_NEXT_CONVEX_URL", "https://next.invalid");
  vi.resetModules();
  const legacy = await import("./control-plane");
  expect(legacy.convexUrl()).toBe("https://legacy.invalid");
  expect(legacy.NEXT_CONTROL_PLANE).toBe(false);
  vi.stubEnv("VITE_CONTROL_PLANE_MODE", "next");
  vi.resetModules();
  const next = await import("./control-plane");
  expect(next.convexUrl()).toBe("https://next.invalid");
  vi.stubEnv("VITE_NEXT_CONVEX_URL", "");
  expect(() => next.convexUrl()).toThrow("not configured");
});
