import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => vi.unstubAllEnvs());

describe("outer web security headers", () => {
  it.each([
    ["live", "clerk.zevium.dev"],
    ["test", "example-instance-42.clerk.accounts.dev"],
  ])(
    "allows the configured %s Clerk instance, including its environment fetch",
    (mode, hostname) => {
      vi.stubEnv(
        "VITE_CLERK_PUBLISHABLE_KEY",
        `pk_${mode}_${btoa(`${hostname}$`).replace(/=+$/, "")}`,
      );
      const policy = buildWebContentSecurityPolicy("nonce-test-value");
      for (const directive of [
        "connect-src",
        "script-src",
        "frame-src",
        "form-action",
      ]) {
        const sources = policy
          .split("; ")
          .find((value) => value.startsWith(`${directive} `));
        expect(sources?.split(" ")).toContain(`https://${hostname}`);
      }
      expect(policy).not.toContain("https://*.zevium.dev");
    },
  );

  it.each([
    undefined,
    "pk_live_invalid",
    `pk_live_${btoa("clerk.zevium.dev")}`,
    `pk_live_${btoa("clerk.zevium.dev; connect-src *$")}`,
    `pk_live_${btoa("clerk.zevium.dev/path$")}`,
    `pk_live_${btoa("clerk.zevium.dev:443$")}`,
  ])("does not turn malformed instance keys into CSP sources (%s)", (key) => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", key);
    const policy = buildWebContentSecurityPolicy("nonce-test-value");
    expect(policy).not.toContain("https://clerk.zevium.dev");
    expect(policy).not.toMatch(/(?:^|\s)\*(?:\s|;|$)/);
  });

  it("allows Clerk's bot protection scripts, frames, and nonstandard connection ports", () => {
    const directives =
      buildWebContentSecurityPolicy("nonce-test-value").split("; ");
    expect(
      directives.find((value) => value.startsWith("connect-src ")),
    ).toContain("https://*.protect.clerk.com:*");
    for (const name of ["script-src", "frame-src"]) {
      expect(
        directives.find((value) => value.startsWith(`${name} `)),
      ).toContain("https://*.protect.clerk.com");
    }
  });

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
