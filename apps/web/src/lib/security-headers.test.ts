import { describe, expect, it } from "vitest";

import {
  applyWebSecurityHeaders,
  buildWebContentSecurityPolicy,
  createCspNonce,
} from "./security-headers";

const REQUIRED_HEADERS = [
  "content-security-policy",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
] as const;

describe("outer web security headers", () => {
  it("builds nonce-bound executable policy without unsafe eval or broad wildcard", () => {
    const policy = buildWebContentSecurityPolicy("nonce-test-value");
    expect(policy).toContain("script-src 'self' 'nonce-nonce-test-value'");
    expect(policy).toContain("'strict-dynamic'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toMatch(/(?:^|\s)\*(?:\s|;|$)/);
  });

  it("covers streamed HTML and strips Clerk diagnostics at deployed HTTPS", async () => {
    const source = new Response("<html>streamed</html>", {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "x-clerk-auth-reason": "private-reason",
        "x-clerk-auth-status": "signed-out",
      },
    });
    const response = applyWebSecurityHeaders(
      new Request("https://www.zevium.dev/"),
      source,
      "document-nonce",
    );
    for (const name of REQUIRED_HEADERS) {
      expect(response.headers.get(name)).toBeTruthy();
    }
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-clerk-auth-reason")).toBeNull();
    expect(response.headers.get("x-clerk-auth-status")).toBeNull();
    expect(await response.text()).toBe("<html>streamed</html>");
  });

  it("keeps local HTTP usable and no-stores redirect, auth, API, and error state", () => {
    for (const [url, status] of [
      ["http://localhost:3000/", 200],
      ["http://localhost:3000/redirect", 302],
      ["http://localhost:3000/sign-in/sso-callback", 200],
      ["http://localhost:3000/_serverFn/test", 200],
      ["http://localhost:3000/missing", 404],
    ] as const) {
      const response = applyWebSecurityHeaders(
        new Request(url),
        new Response(null, { status }),
        "local-nonce",
      );
      expect(response.headers.get("strict-transport-security")).toBeNull();
      expect(response.headers.get("content-security-policy")).not.toContain(
        "upgrade-insecure-requests",
      );
      if (status >= 300 || !url.endsWith("/")) {
        expect(response.headers.get("cache-control")).toBe("private, no-store");
      }
    }
  });

  it("generates independent CSP-safe nonces", () => {
    const values = new Set(Array.from({ length: 128 }, () => createCspNonce()));
    expect(values.size).toBe(128);
    for (const value of values) expect(value).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
});
