import { describe, expect, it } from "vitest";

import { needsAuthenticatedProviders } from "./provider-scope";

describe("needsAuthenticatedProviders", () => {
  it.each([
    "/app",
    "/app/projects",
    "/admin",
    "/admin/payouts",
    "/sign-in",
    "/sign-in/sso-callback",
    "/sign-up",
    "/sign-up/verify-email-address",
  ])("selects route-owned auth for %s", (pathname) => {
    expect(needsAuthenticatedProviders(pathname)).toBe(true);
  });

  it.each([
    "/",
    "/catalogue",
    "/catalogue/acme/weather",
    "/docs",
    "/docs/publishing",
    "/application",
    "/administrator",
  ])("keeps public Convex on %s", (pathname) => {
    expect(needsAuthenticatedProviders(pathname)).toBe(false);
  });
});
