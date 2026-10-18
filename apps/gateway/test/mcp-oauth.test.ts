import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import worker, { __setTestPipelineDeps, type Env } from "../src/index";
import { ClerkMcpOAuthVerifier, MCP_SCOPES } from "../src/mcp-oauth";
import { FixtureKeyVerifier } from "../src/key-verifier";
import type { CatalogueSearchSource } from "../src/catalogue-search";
import { FixtureCatalogueSource } from "../src/catalogue-source";
import { FixtureSpecSource } from "../src/spec-source";

const issuer = "https://clerk.oauth.test";
const resource = "https://gateway.test/mcp";
const keyId = "ak_oauth_managed";
const userId = "user_oauth";
let signing: CryptoKey;
let jwks: { keys: Record<string, unknown>[] };
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signing = pair.privateKey;
  jwks = {
    keys: [
      {
        ...(await exportJWK(pair.publicKey)),
        kid: "test",
        alg: "RS256",
        use: "sig",
      },
    ],
  };
});
afterEach(() => {
  __setTestPipelineDeps(null);
});

async function fixture(
  options: {
    tokenState?: Record<string, unknown>;
    userInfo?: Record<string, unknown>;
  } = {},
) {
  const orgId = `org_oauth_${crypto.randomUUID()}`;
  let now = Date.now();
  let revoked = false;
  let unavailable = false;
  let mapped = true;
  let keyless = false;
  let disabled = false;
  let provisioning = false;
  const identityRequests: unknown[] = [];
  const remote = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (unavailable) return new Response(null, { status: 503 });
    if (url.endsWith("/jwks.json")) return Response.json(jwks);
    if (url.endsWith("/access_tokens/verify"))
      return Response.json({
        id: "oat_test",
        client_id: "client_test",
        subject: userId,
        revoked,
        expired: false,
        expiration: Math.floor(now / 1000) + 3600,
        scopes: MCP_SCOPES,
        aud: [resource],
        ...options.tokenState,
      });
    if (url.endsWith("/oauth/userinfo"))
      return Response.json(options.userInfo ?? { sub: userId, org_id: orgId });
    if (url.endsWith("/mcp-identity")) {
      identityRequests.push(JSON.parse(String(init?.body)));
      return Response.json(
        mapped
          ? keyless
            ? {
                orgId,
                keyId: null,
                provisioning,
                ...(disabled && { disabled }),
              }
            : { orgId, keyId }
          : null,
      );
    }
    throw new Error("unexpected OAuth fetch");
  });
  const verifier = new ClerkMcpOAuthVerifier({
    issuer,
    resource,
    secretKey: "test-secret",
    siteUrl: "https://control.test",
    internalSecret: "internal-test",
    fetchImpl: remote,
    now: () => now,
  });
  const specs = new FixtureSpecSource();
  specs.set("publisher", "api", {
    specVersionId: "spec_oauth_v1",
    projectId: "project_oauth",
    organizationId: "convex_publisher",
    clerkOrgId: "org_publisher",
    visibility: "public",
    version: "1.0.0",
    spec: JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Demo", version: "1.0.0" },
      servers: [{ url: "https://upstream.test" }],
      paths: {
        "/paid": { get: { "x-zevium-cost": 3 } },
        "/free": { get: { "x-zevium-cost": 0 } },
      },
    }),
  });
  const upstream = vi.fn<typeof fetch>(async (input) => {
    const req = input instanceof Request ? input : new Request(String(input));
    expect(req.headers.get("authorization")).toBeNull();
    return new Response("paid result");
  });
  const search = vi.fn<CatalogueSearchSource["search"]>(async () => ({
    items: [],
    degraded: false,
  }));
  __setTestPipelineDeps({
    searchSource: { search },
    keyVerifier: new FixtureKeyVerifier({
      zev_oauth_api_key: { orgId, keyId, scopes: [] },
    }),
    oauthVerifier: verifier,
    specSource: specs,
    publicSpecSource: specs,
    catalogueSource: new FixtureCatalogueSource([]),
    fetchImpl: upstream,
  });
  async function token(overrides: JWTPayload = {}, typ = "at+jwt") {
    return new SignJWT({
      sub: userId,
      org_id: orgId,
      client_id: "client_test",
      jti: "oat_test",
      scope: MCP_SCOPES.join(" "),
      iss: issuer,
      aud: resource,
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 3600,
      ...overrides,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test", typ })
      .sign(signing);
  }
  return {
    orgId,
    token,
    verifier,
    remote,
    upstream,
    identityRequests,
    search,
    advance: (ms = 60_001) => {
      now += ms;
    },
    revoke: () => {
      revoked = true;
    },
    outage: () => {
      unavailable = true;
    },
    unmap: () => {
      mapped = false;
    },
    setKeyless: (value: boolean, creating = false, off = false) => {
      keyless = value;
      provisioning = creating;
      disabled = off;
    },
  };
}
async function request(
  path: string,
  token?: string,
  body?: unknown,
  method = "POST",
) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://gateway.test${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...env, MCP_OAUTH_ISSUER: issuer, MCP_OAUTH_RESOURCE: resource } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
function call(path = "/paid", extra = {}, name = "call_api_read") {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name,
      arguments: {
        org: "publisher",
        project: "api",
        method: "GET",
        path,
        ...extra,
      },
    },
  };
}

describe("Clerk MCP OAuth resource server", () => {
  it("challenges unauthenticated initialize and GET, exposes metadata and Clerk discovery", async () => {
    await fixture();
    for (const method of ["GET", "POST"]) {
      const res = await request("/mcp", undefined, undefined, method);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(
        'resource_metadata="https://gateway.test/.well-known/oauth-protected-resource/mcp"',
      );
      expect(res.headers.get("access-control-expose-headers")).toContain(
        "www-authenticate",
      );
    }
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await request(path, undefined, undefined, "GET");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        resource,
        authorization_servers: [issuer],
        scopes_supported: MCP_SCOPES,
      });
    }
    const discovery = await request(
      "/.well-known/oauth-authorization-server",
      undefined,
      undefined,
      "GET",
    );
    expect(discovery.status).toBe(307);
    expect(discovery.headers.get("location")).toBe(
      `${issuer}/.well-known/oauth-authorization-server`,
    );
    const preflight = await request("/mcp", undefined, undefined, "OPTIONS");
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "mcp-protocol-version",
    );
  });

  it("verifies revocable opaque tokens and caches provider verification and org lookup", async () => {
    const f = await fixture();
    for (let i = 0; i < 2; i++)
      expect((await request("/mcp", "oat_test_secret", call())).status).toBe(
        200,
      );
    expect(f.remote).toHaveBeenCalledTimes(3); // verify, userinfo, mapping
  });

  it.each([
    ["expired", { tokenState: { expiration: 1 } }, 401],
    [
      "wrong audience",
      { tokenState: { aud: ["https://other.test/mcp"] } },
      401,
    ],
    [
      "missing spending scope",
      { tokenState: { scopes: ["user:org:read"] } },
      403,
    ],
    ["missing org", { userInfo: { sub: userId } }, 401],
    [
      "different user",
      { userInfo: { sub: "user_other", org_id: "org_other" } },
      401,
    ],
  ])("rejects opaque tokens with %s", async (_label, options, status) => {
    const f = await fixture(options);
    expect((await request("/mcp", "oat_test_secret", call())).status).toBe(
      status,
    );
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("expires opaque tokens before their verification cache expires", async () => {
    const f = await fixture({
      tokenState: { expiration: Math.floor(Date.now() / 1000) + 30 },
    });
    expect((await f.verifier.verify("oat_test_secret")).status).toBe("ok");
    f.advance(31_000);
    expect((await f.verifier.verify("oat_test_secret")).status).toBe("invalid");
  });

  it("blocks stateless JWT access after its managed key is revoked", async () => {
    const f = await fixture();
    const token = await f.token();
    expect((await f.verifier.verify(token)).status).toBe("ok");
    f.unmap();
    f.advance();
    expect((await request("/mcp", token, call())).status).toBe(401);
  });

  it("requests consent for missing spending scope with HTTP 403", async () => {
    const f = await fixture();
    const res = await request(
      "/mcp",
      await f.token({ scope: "user:org:read" }),
      call(),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain(
      'error="insufficient_scope"',
    );
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("coalesces concurrent token-status and mapping cache misses", async () => {
    const f = await fixture();
    const token = "oat_test_secret";
    const results = await Promise.all(
      Array.from({ length: 8 }, () => f.verifier.verify(token)),
    );
    expect(results.every((result) => result.status === "ok")).toBe(true);
    // jose deliberately does not share pending JWKS requests in workerd.
    // The status/identity refresh still coalesces after local verification.
    for (const endpoint of ["/access_tokens/verify", "/mcp-identity"]) {
      expect(
        f.remote.mock.calls.filter(([url]) => String(url).endsWith(endpoint)),
      ).toHaveLength(1);
    }
  });

  it("rejects ID/session tokens, bad signatures and invalid API keys", async () => {
    const f = await fixture();
    expect(
      (await request("/mcp", await f.token({}, "JWT"), call())).status,
    ).toBe(401);
    const token = await f.token();
    const parts = token.split(".");
    parts[2] = `${parts[2]![0] === "a" ? "b" : "a"}${parts[2]!.slice(1)}`;
    expect((await request("/mcp", parts.join("."), call())).status).toBe(401);
    expect((await request("/mcp", "zev_invalid", call())).status).toBe(401);
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("bounds revocation to 60s and checks expiry even on a cache hit", async () => {
    const f = await fixture();
    const token = "oat_test_secret";
    expect((await f.verifier.verify(token)).status).toBe("ok");
    f.revoke();
    f.advance();
    expect((await request("/mcp", token, call())).status).toBe(401);
    const g = await fixture();
    const short = await g.token({ exp: Math.floor(Date.now() / 1000) + 30 });
    expect((await g.verifier.verify(short)).status).toBe("ok");
    g.advance(31_000);
    expect((await g.verifier.verify(short)).status).toBe("invalid");
  });

  it("fails closed on dependency outages, unmapped identities, and cross-org mapping", async () => {
    const f = await fixture();
    const token = await f.token();
    expect((await f.verifier.verify(token)).status).toBe("ok");
    f.advance();
    f.outage();
    expect((await request("/mcp", token, call())).status).toBe(503);
    const g = await fixture();
    g.unmap();
    expect((await request("/mcp", await g.token(), call())).status).toBe(401);
    const h = await fixture();
    expect(
      (await request("/mcp", await h.token({ org_id: "org_other" }), call()))
        .status,
    ).toBe(503);
  });

  it("keeps keyless sessions authenticated and explains the missing key", async () => {
    const f = await fixture();
    f.setKeyless(true);
    const token = await f.token();
    expect(await f.verifier.verify(token)).toEqual({
      status: "keyless",
      orgId: f.orgId,
      keyState: "missing",
    });
    const tools = await request("/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(tools.status).toBe(200);
    const search = await request("/mcp", token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search_apis", arguments: { query: "demo" } },
    });
    expect(search.status).toBe(200);
    expect(
      ((await search.json()) as { result: { isError?: boolean } }).result
        .isError,
    ).toBeUndefined();
    expect(f.search).toHaveBeenCalledWith("demo", undefined);
    const docs = await request("/mcp", token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "get_api_docs",
        arguments: { org: "publisher", project: "api" },
      },
    });
    expect(
      ((await docs.json()) as { result: { isError?: boolean } }).result.isError,
    ).toBeUndefined();
    for (const extra of [{}, { key: "zev_oauth_api_key" }]) {
      const res = await request("/mcp", token, call("/paid", extra));
      expect(res.status).toBe(200);
      const { result } = (await res.json()) as {
        result: { isError: boolean; content: { text: string }[] };
      };
      expect(result.isError).toBe(true);
      if ("key" in extra) {
        expect(result.content[0]!.text).toBe(
          "Tool arguments cannot carry API keys. Authenticate the MCP connection with OAuth or an Authorization header instead.",
        );
        continue;
      }
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({
        status: 402,
        cost: 0,
        reason: "oauth_missing_api_key",
        message:
          "No API key for this organization — create one at https://web.fixture.invalid/app/settings/keys",
        recovery: expect.stringContaining("no reconnect needed"),
        actions: { createKey: "https://web.fixture.invalid/app/settings/keys" },
      });
    }
    expect(f.upstream).not.toHaveBeenCalled();
    // A key created later applies after the bounded identity cache, same token.
    f.setKeyless(false);
    f.advance();
    expect(await f.verifier.verify(token)).toMatchObject({ status: "ok" });
  });

  it("tells keyless sessions to retry while their first key is auto-created", async () => {
    const f = await fixture();
    f.setKeyless(true, true);
    const token = await f.token();
    expect(await f.verifier.verify(token)).toEqual({
      status: "keyless",
      orgId: f.orgId,
      keyState: "provisioning",
    });
    const res = await request("/mcp", token, call());
    const { result } = (await res.json()) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: 402,
      cost: 0,
      reason: "oauth_key_provisioning",
      retryAfterSeconds: 15,
      recovery: expect.stringContaining("no reconnect needed"),
    });
    expect(f.upstream).not.toHaveBeenCalled();
    f.setKeyless(false);
    f.advance();
    expect(await f.verifier.verify(token)).toMatchObject({ status: "ok" });
  });

  it("points members whose key is disabled at re-enable or rotate", async () => {
    const f = await fixture();
    f.setKeyless(true, false, true);
    const token = await f.token();
    expect(await f.verifier.verify(token)).toEqual({
      status: "keyless",
      orgId: f.orgId,
      keyState: "disabled",
    });
    const res = await request("/mcp", token, call());
    const { result } = (await res.json()) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    expect(body).toMatchObject({
      status: 402,
      cost: 0,
      reason: "oauth_key_disabled",
      message:
        "Your API key for this organization is disabled — re-enable or rotate it at https://web.fixture.invalid/app/settings/keys",
      recovery: expect.stringContaining("no reconnect needed"),
      actions: { createKey: "https://web.fixture.invalid/app/settings/keys" },
    });
    expect(body).not.toHaveProperty("retryAfterSeconds");
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("refuses method-override headers on both execute tools", async () => {
    const f = await fixture();
    const token = await f.token();
    for (const name of [
      "X-HTTP-Method-Override",
      "x-http-method",
      "X-Method-Override",
    ]) {
      for (const [tool, method, message] of [
        [
          "call_api_read",
          "GET",
          `call_api_read cannot send ${name}; use call_api_write with the intended method`,
        ],
        [
          "call_api_write",
          "POST",
          `Method override headers are not supported; set method instead of ${name}`,
        ],
      ] as const) {
        const res = await request(
          "/mcp",
          token,
          call("/paid", { method, headers: { [name]: "DELETE" } }, tool),
        );
        const { result } = (await res.json()) as {
          result: { isError: boolean; content: { text: string }[] };
        };
        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toBe(message);
      }
    }
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("refuses key arguments and methods outside each execute tool", async () => {
    const f = await fixture();
    const text = async (body: unknown, token: string) => {
      const res = await request("/mcp", token, body);
      expect(res.status).toBe(200);
      const { result } = (await res.json()) as {
        result: { isError: boolean; content: { text: string }[] };
      };
      expect(result.isError).toBe(true);
      return result.content[0]!.text;
    };
    for (const token of [await f.token(), "zev_oauth_api_key"]) {
      expect(
        await text(call("/paid", { key: "zev_oauth_api_key" }), token),
      ).toContain("Tool arguments cannot carry API keys");
      expect(
        await text(
          call(
            "/paid",
            { key: "zev_oauth_api_key", method: "POST" },
            "call_api_write",
          ),
          token,
        ),
      ).toContain("Tool arguments cannot carry API keys");
      expect(await text(call("/paid", { method: "POST" }), token)).toBe(
        "call_api_read does not accept POST; use call_api_write",
      );
      expect(
        await text(call("/paid", { method: "get" }, "call_api_write"), token),
      ).toBe("call_api_write does not accept GET; use call_api_read");
      expect(
        await text(
          call("/paid", { method: "CONNECT" }, "call_api_write"),
          token,
        ),
      ).toBe("Unsupported HTTP method");
      expect(
        await text(
          call("/paid", { method: undefined }, "call_api_write"),
          token,
        ),
      ).toBe("org, project, method, and path are required");
      expect(await text(call("/paid", {}, "call_api"), token)).toBe(
        "Unknown tool",
      );
    }
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("keeps OAuth restricted to MCP and declines the optional SSE listener", async () => {
    const f = await fixture();
    const token = await f.token();
    expect((await request("/mcp", token, undefined, "GET")).status).toBe(405);
    expect(f.upstream).not.toHaveBeenCalled();
  });
});
