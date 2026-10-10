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
    ["http://127.0.0.1:3210", "ws://127.0.0.1:3210"],
    ["http://localhost:4321/path", "ws://localhost:4321"],
    ["http://[::1]:3210", "ws://[::1]:3210"],
  ])(
    "allows only the configured local Convex socket in dev (%s)",
    (convex, socket) => {
      vi.stubEnv("DEV", true);
      vi.stubEnv("VITE_CONVEX_URL", convex);
      const policy = buildWebContentSecurityPolicy("test");
      expect(
        policy
          .split("; ")
          .find((value) => value.startsWith("connect-src "))
          ?.split(" "),
      ).toContain(socket);
      expect(policy).not.toContain("ws://*");
      expect(policy).not.toContain("ws: ");
    },
  );

  it.each([false, true])("preserves secure Convex sockets (dev=%s)", (dev) => {
    vi.stubEnv("DEV", dev);
    vi.stubEnv("VITE_CONVEX_URL", "https://example.convex.cloud/path");
    const policy = buildWebContentSecurityPolicy("test");
    expect(policy).toContain(
      "https://example.convex.cloud wss://example.convex.cloud",
    );
    expect(policy).not.toContain(" ws:");
  });

  it.each([
    [false, "http://127.0.0.1:3210"],
    [false, "http://localhost:3210"],
    [false, "http://[::1]:3210"],
    [true, "http://remote.example.com:3210"],
    [true, "invalid-url"],
    [true, "data:text/plain,invalid"],
    [true, "file:///invalid"],
    [true, undefined],
  ])("does not broaden WebSocket policy (dev=%s, convex=%s)", (dev, convex) => {
    vi.stubEnv("DEV", dev);
    vi.stubEnv("VITE_CONVEX_URL", convex);
    const policy = buildWebContentSecurityPolicy("test");
    expect(policy).not.toContain(" ws:");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).toContain("'strict-dynamic'");
  });

  it.each([undefined, "", "  "])(
    "allows playground requests to the default local gateway (%s)",
    (gateway) => {
      vi.stubEnv("VITE_GATEWAY_URL", gateway);
      const sources = buildWebContentSecurityPolicy("nonce-test-value")
        .split("; ")
        .find((directive) => directive.startsWith("connect-src "))
        ?.split(" ");
      expect(sources).toContain("http://localhost:8787");
    },
  );

  it("allows the configured gateway instead of the local fallback", () => {
    vi.stubEnv("VITE_GATEWAY_URL", " https://gateway.example.com/gateway/ ");
    const sources = buildWebContentSecurityPolicy("nonce-test-value")
      .split("; ")
      .find((directive) => directive.startsWith("connect-src "))
      ?.split(" ");
    expect(sources).toContain("https://gateway.example.com");
    expect(sources).not.toContain("http://localhost:8787");
  });

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
