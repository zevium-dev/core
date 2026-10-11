import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, {
  __setTestGrantsFetcher,
  __setTestPipelineDeps,
  __setTestUsageMutation,
  type Env,
} from "../src/index";
import {
  InternalHttpConnections,
  type ConnectionTokenInput,
  type ConnectionTokenOutcome,
  type ConnectionsBackend,
} from "../src/connections";
import { FixtureKeyVerifier } from "../src/key-verifier";
import { FixtureCatalogueSource } from "../src/catalogue-source";
import { FixtureSpecSource } from "../src/spec-source";

const KEY = "zev_connections_key";
const CONNECTION = "conn_abcdefghijklmnopqrstuvwxyz";
const UPLOAD = "https://www.googleapis.com/auth/youtube.upload";

afterEach(() => {
  __setTestPipelineDeps(null);
  __setTestGrantsFetcher(null);
  __setTestUsageMutation(null);
});

const SPEC = {
  openapi: "3.1.0",
  info: { title: "Video", version: "1.0.0" },
  servers: [{ url: "https://www.googleapis.com" }],
  components: {
    securitySchemes: {
      video: {
        type: "oauth2",
        "x-zevium-oauth-provider": "youtube",
        flows: {
          authorizationCode: {
            authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
            tokenUrl: "https://oauth2.googleapis.com/token",
            scopes: { [UPLOAD]: "Upload" },
          },
        },
      },
    },
  },
  paths: {
    "/videos": {
      post: { "x-zevium-cost": 5, security: [{ video: [UPLOAD] }] },
    },
    "/feed": { get: { "x-zevium-cost": 1, security: [{ video: [] }, {}] } },
    "/plain": { get: { "x-zevium-cost": 1 } },
  },
};

async function fixture(
  options: {
    visibility?: "public" | "private";
    outcome?: ConnectionTokenOutcome;
    /** Upstream override; specs are not validated on this path. */
    upstream?: string;
  } = {},
) {
  const orgId = `org_conn_${crypto.randomUUID()}`;
  const keyId = `key_${crypto.randomUUID()}`;
  const tokenCalls: ConnectionTokenInput[] = [];
  const controlCalls: { path: string; body: Record<string, unknown> }[] = [];
  let outcome: ConnectionTokenOutcome = options.outcome ?? {
    status: "ok",
    connectionId: CONNECTION,
    accessToken: "consumer-access-token",
  };
  let control: (path: string, body: Record<string, unknown>) => unknown = () =>
    null;
  const connections: ConnectionsBackend = {
    token: async (input) => {
      tokenCalls.push(input);
      return outcome;
    },
    control: async (path, body) => {
      controlCalls.push({ path, body });
      return control(path, body);
    },
  };
  const specs = new FixtureSpecSource();
  specs.set("publisher", "video", {
    specVersionId: "spec_video_v1",
    projectId: "project_video",
    organizationId: "convex_publisher",
    clerkOrgId: "org_publisher",
    visibility: options.visibility ?? "public",
    version: "1.0.0",
    spec: JSON.stringify(
      options.upstream
        ? { ...SPEC, servers: [{ url: options.upstream }] }
        : SPEC,
    ),
    upstreamHeaders: {
      authorization: "Bearer publisher-key",
      "x-publisher": "p",
    },
  });
  const upstream = vi.fn<typeof fetch>(async () => new Response("ok"));
  __setTestPipelineDeps({
    keyVerifier: new FixtureKeyVerifier({
      [KEY]: { orgId, keyId, scopes: [] },
    }),
    specSource: specs,
    publicSpecSource: specs,
    catalogueSource: new FixtureCatalogueSource([]),
    fetchImpl: upstream,
    connections,
  });
  __setTestGrantsFetcher(async (requestedOrg) => ({
    wallet: {
      clerkOrgId: requestedOrg,
      balance: requestedOrg === orgId ? 100 : 0,
      sequence: 0,
    },
    keySettings: [{ keyId, familyId: keyId, disabled: false }],
  }));
  __setTestUsageMutation(async () => {});
  await env.WALLET.get(env.WALLET.idFromName(orgId)).grant(
    `grant_${orgId}`,
    100,
  );
  return {
    orgId,
    keyId,
    upstream,
    tokenCalls,
    controlCalls,
    setOutcome: (next: ConnectionTokenOutcome) => {
      outcome = next;
    },
    setControl: (next: typeof control) => {
      control = next;
    },
  };
}

async function send(
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    key?: string | null;
  } = {},
) {
  const ctx = createExecutionContext();
  const key = init.key === undefined ? KEY : init.key;
  const response = await worker.fetch(
    new Request(`https://gateway.test${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(key ? { "x-api-key": key } : {}),
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    env as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

function upstreamHeaders(
  upstream: ReturnType<typeof vi.fn<typeof fetch>>,
  call = 0,
) {
  return new Headers(upstream.mock.calls[call]![1]!.headers);
}

describe("metered calls with connected accounts", () => {
  it("sends the consumer's token instead of the publisher's Authorization", async () => {
    const f = await fixture();
    const response = await send("/gateway/publisher/video/videos", {
      method: "POST",
      body: {},
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-zevium-connection")).toBe(CONNECTION);
    expect(f.tokenCalls).toEqual([
      { orgId: f.orgId, projectId: "project_video", scheme: "video" },
    ]);
    const headers = upstreamHeaders(f.upstream);
    expect(headers.get("authorization")).toBe("Bearer consumer-access-token");
    expect(headers.get("x-publisher")).toBe("p");
    expect(headers.get("x-api-key")).toBeNull();
  });

  it("never sends a connected token to a host outside the provider's API", async () => {
    const f = await fixture({ upstream: "https://collector.example" });
    const response = await send("/gateway/publisher/video/videos", {
      method: "POST",
      body: {},
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "connection_upstream_not_allowed",
      cost: 0,
    });
    expect(f.tokenCalls).toEqual([]);
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("blocks with a connect hint and no charge when no account is connected", async () => {
    const f = await fixture({ outcome: { status: "connection_required" } });
    const response = await send("/gateway/publisher/video/videos", {
      method: "POST",
      body: {},
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "connection_required",
      cost: 0,
      connect: {
        method: "POST",
        url: "https://gateway.test/connections",
        body: { api: "publisher/video", scheme: "video" },
      },
    });
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("asks the caller to choose between several connections", async () => {
    const f = await fixture({ outcome: { status: "connection_ambiguous" } });
    expect(
      (
        await send("/gateway/publisher/video/videos", {
          method: "POST",
          body: {},
        })
      ).status,
    ).toBe(409);
    f.setOutcome({
      status: "ok",
      connectionId: CONNECTION,
      accessToken: "chosen",
    });
    const chosen = await send("/gateway/publisher/video/videos", {
      method: "POST",
      body: {},
      headers: { "x-zevium-connection": CONNECTION },
    });
    expect(chosen.status).toBe(200);
    expect(f.tokenCalls.at(-1)).toMatchObject({ connectionId: CONNECTION });
    // The selector header is Zevium's; it never reaches the upstream.
    expect(upstreamHeaders(f.upstream).get("x-zevium-connection")).toBeNull();
    expect(
      (
        await send("/gateway/publisher/video/videos", {
          method: "POST",
          body: {},
          headers: { "x-zevium-connection": "nope" },
        })
      ).status,
    ).toBe(400);
  });

  it("keeps optional and unsecured operations working without a connection", async () => {
    const f = await fixture({ outcome: { status: "connection_required" } });
    expect((await send("/gateway/publisher/video/feed")).status).toBe(200);
    expect(upstreamHeaders(f.upstream).get("authorization")).toBe(
      "Bearer publisher-key",
    );
    expect((await send("/gateway/publisher/video/plain")).status).toBe(200);
    expect(f.tokenCalls).toHaveLength(1);
  });

  it("fails closed when the connection store is unavailable", async () => {
    const f = await fixture({ outcome: { status: "unavailable" } });
    const response = await send("/gateway/publisher/video/videos", {
      method: "POST",
      body: {},
    });
    expect(response.status).toBe(503);
    expect(f.upstream).not.toHaveBeenCalled();
  });
});

describe("/connections management", () => {
  it("requires a Zevium API key", async () => {
    await fixture();
    expect((await send("/connections", { key: null })).status).toBe(401);
    expect((await send("/connections", { key: "zev_unknown" })).status).toBe(
      401,
    );
  });

  it("starts a connection with the gateway's fixed callback", async () => {
    const f = await fixture();
    f.setControl(() => ({
      connection: { id: CONNECTION, status: "pending" },
      authorizationUrl: "https://auth.video.test/authorize?state=s",
      expiresAt: 123,
    }));
    const response = await send("/connections", {
      method: "POST",
      body: {
        api: "publisher/video",
        label: "creator-1",
        returnUrl: "https://app.test/done",
      },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      connection: { id: CONNECTION, status: "pending" },
      authorizationUrl: "https://auth.video.test/authorize?state=s",
    });
    expect(f.controlCalls).toEqual([
      {
        path: "/connections-start",
        body: {
          orgId: f.orgId,
          keyId: f.keyId,
          projectId: "project_video",
          api: "publisher/video",
          label: "creator-1",
          returnUrl: "https://app.test/done",
          redirectUri: "https://gateway.test/connections/callback",
        },
      },
    ]);
  });

  it("validates the request and maps control-plane errors", async () => {
    const f = await fixture();
    expect(
      (
        await send("/connections", {
          method: "POST",
          body: { api: "publisher" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send("/connections", {
          method: "POST",
          body: { api: "publisher/video", returnUrl: "http://app.test/done" },
        })
      ).status,
    ).toBe(400);
    f.setControl(() => ({ error: "provider_not_configured" }));
    const response = await send("/connections", {
      method: "POST",
      body: { api: "publisher/video" },
    });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("provider_not_configured");
    f.setControl(() => ({ error: "publisher_not_allowed" }));
    expect(
      (
        await send("/connections", {
          method: "POST",
          body: { api: "publisher/video" },
        })
      ).status,
    ).toBe(403);
  });

  it("hides private APIs from other orgs", async () => {
    const f = await fixture({ visibility: "private" });
    expect(
      (
        await send("/connections", {
          method: "POST",
          body: { api: "publisher/video" },
        })
      ).status,
    ).toBe(404);
    expect(f.controlCalls).toEqual([]);
  });

  it("lists, reads and revokes the caller org's connections", async () => {
    const f = await fixture();
    f.setControl((path, body) =>
      path === "/connections-list" && body.connectionId === undefined
        ? { connections: [{ id: CONNECTION }] }
        : path === "/connections-revoke"
          ? { connection: { id: CONNECTION, status: "revoked" } }
          : { connection: null },
    );
    expect(await (await send("/connections")).json()).toEqual({
      connections: [{ id: CONNECTION }],
    });
    expect((await send(`/connections/${CONNECTION}`)).status).toBe(404);
    const revoked = await send(`/connections/${CONNECTION}`, {
      method: "DELETE",
    });
    expect(await revoked.json()).toEqual({
      connection: { id: CONNECTION, status: "revoked" },
    });
    expect(f.controlCalls.map((c) => c.body.orgId)).toEqual([
      f.orgId,
      f.orgId,
      f.orgId,
    ]);
    expect((await send("/connections/not-an-id")).status).toBe(404);
    expect((await send("/connections", { method: "DELETE" })).status).toBe(405);
  });
});

describe("/connections/callback", () => {
  it("returns to the app with the outcome", async () => {
    const f = await fixture();
    f.setControl(() => ({
      status: "active",
      connectionId: CONNECTION,
      returnUrl: "https://app.test/done?x=1",
    }));
    const response = await send("/connections/callback?state=s1&code=c1", {
      key: null,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `https://app.test/done?x=1&zevium_connection=${CONNECTION}&zevium_status=active`,
    );
    expect(f.controlCalls).toEqual([
      { path: "/connections-callback", body: { state: "s1", code: "c1" } },
    ]);
  });

  it("shows a plain page without a return URL", async () => {
    const f = await fixture();
    f.setControl(() => ({
      status: "denied",
      connectionId: CONNECTION,
      returnUrl: null,
    }));
    const denied = await send(
      "/connections/callback?state=s1&error=access_denied",
      { key: null },
    );
    expect(denied.status).toBe(200);
    expect(denied.headers.get("content-type")).toContain("text/html");
    expect(await denied.text()).toContain("Connection declined");
    expect((await send("/connections/callback", { key: null })).status).toBe(
      400,
    );
    f.setControl(() => null);
    expect(
      (await send("/connections/callback?state=s2&code=c", { key: null }))
        .status,
    ).toBe(503);
  });
});

describe("InternalHttpConnections", () => {
  function backend(responses: unknown[]) {
    let now = 1_000_000;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json(responses.shift()),
    );
    const client = new InternalHttpConnections({
      siteUrl: "https://control.test",
      internalSecret: "secret",
      fetchImpl,
      now: () => now,
    });
    return { client, fetchImpl, advance: (ms: number) => (now += ms) };
  }
  const input = { orgId: "org", projectId: "p", scheme: "video" };

  it("caches tokens up to 60 s and never past expiry", async () => {
    const { client, fetchImpl, advance } = backend([
      {
        status: "ok",
        connectionId: CONNECTION,
        accessToken: "a1",
        accessExpiresAt: null,
      },
      {
        status: "ok",
        connectionId: CONNECTION,
        accessToken: "a2",
        accessExpiresAt: 1_000_000 + 61_000 + 90_000,
      },
      {
        status: "ok",
        connectionId: CONNECTION,
        accessToken: "a3",
        accessExpiresAt: null,
      },
    ]);
    expect(await client.token(input)).toMatchObject({ accessToken: "a1" });
    expect(await client.token(input)).toMatchObject({ accessToken: "a1" });
    advance(61_000);
    expect(await client.token(input)).toMatchObject({ accessToken: "a2" });
    advance(31_000);
    expect(await client.token(input)).toMatchObject({ accessToken: "a3" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const sent = fetchImpl.mock.calls[0]!;
    expect(sent[0]).toBe("https://control.test/gateway-connection-token");
    expect(new Headers(sent[1]!.headers).get("x-internal-secret")).toBe(
      "secret",
    );
  });

  it("does not cache failures and treats bad payloads as unavailable", async () => {
    const { client, fetchImpl } = backend([
      { status: "connection_required" },
      {
        status: "ok",
        connectionId: CONNECTION,
        accessToken: "a1",
        accessExpiresAt: null,
      },
      { status: "ok", connectionId: "bad", accessToken: "a" },
    ]);
    expect(await client.token(input)).toEqual({
      status: "connection_required",
    });
    expect(await client.token(input)).toMatchObject({ status: "ok" });
    expect(await client.token({ ...input, connectionId: CONNECTION })).toEqual({
      status: "unavailable",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
