import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker, { type Env } from "../src/index";
import {
  applyGatewaySecurityHeaders,
  GATEWAY_CSP,
} from "../src/security-headers";

const REQUIRED_HEADERS = [
  "content-security-policy",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
] as const;

async function invoke(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://gateway.zevium.dev${path}`, init),
    { ...env, GATEWAY_TEST_MODE: "1" } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("gateway outer security header boundary", () => {
  it("covers health, preflight, internal, discovery, MCP, mock, proxy, and 404", async () => {
    const cases: Array<[string, string, RequestInit | undefined]> = [
      ["health", "/health", undefined],
      ["preflight", "/gateway/pub/api/ping", { method: "OPTIONS" }],
      ["internal", "/internal/grant", undefined],
      ["discovery", "/discovery", undefined],
      ["mcp", "/mcp", undefined],
      ["mock", "/mock/pub/api/ping", undefined],
      ["proxy", "/gateway/pub/api/ping", undefined],
      ["not-found", "/does-not-exist", undefined],
    ];
    for (const [, path, init] of cases) {
      const response = await invoke(path, init);
      for (const name of REQUIRED_HEADERS) {
        expect(response.headers.get(name)).toBeTruthy();
      }
      expect(response.headers.get("content-security-policy")).toBe(GATEWAY_CSP);
      expect(response.headers.get("strict-transport-security")).toBe(
        "max-age=31536000",
      );
      expect(response.headers.get("x-clerk-auth-reason")).toBeNull();
      expect(response.headers.get("x-clerk-auth-status")).toBeNull();
      if (response.status >= 400) {
        expect(response.headers.get("cache-control")).toBe("private, no-store");
      }
      await response.body?.cancel();
    }
  });

  it("no-stores 402/auth failures, strips diagnostics, and preserves streaming body", async () => {
    const source = new Response("payment challenge", {
      status: 402,
      headers: {
        "x-clerk-auth-reason": "private tenant detail",
        "x-clerk-auth-status": "signed-out",
      },
    });
    const response = applyGatewaySecurityHeaders(
      new Request("https://gateway.zevium.dev/gateway/pub/api/ping"),
      source,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-clerk-auth-reason")).toBeNull();
    expect(response.headers.get("x-clerk-auth-status")).toBeNull();
    expect(await response.text()).toBe("payment challenge");
  });

  it("does not emit HSTS on local HTTP", () => {
    const response = applyGatewaySecurityHeaders(
      new Request("http://localhost:8787/health"),
      Response.json({ ok: true }),
    );
    expect(response.headers.get("strict-transport-security")).toBeNull();
  });
});
