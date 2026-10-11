import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { parseSpec } from "@zevium/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { __setTestPipelineDeps, type Env } from "../src/index";
import { FixtureCatalogueSource } from "../src/catalogue-source";
import { FixtureKeyVerifier } from "../src/key-verifier";
import {
  InternalHttpConnections,
  handleConnectionsRequest,
  resolveCallConnection,
  type ConnectionCaller,
  type ConnectionTokenInput,
  type ConnectionTokenOutcome,
  type ConnectionsBackend,
} from "../src/connections";
import { forward } from "../src/forward";
import { FixtureSpecSource, type PublishedSpec } from "../src/spec-source";

const KEY = "zev_connections_key";
const CONNECTION = "conn_abcdefghijklmnopqrstuvwxyz";
const UPLOAD = "https://www.googleapis.com/auth/youtube.upload";

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

function route(overrides: Partial<PublishedSpec> = {}): PublishedSpec {
  return {
    specVersionId: "spec_video_v1",
    projectId: "project_video",
    organizationId: "convex_publisher",
    clerkOrgId: "org_publisher",
    visibility: "public",
    version: "1.0.0",
    spec: JSON.stringify(SPEC),
    admission: { mode: "open", policyRevision: 1, allowed: true },
    ...overrides,
  };
}

function fixture(
  options: {
    visibility?: "public" | "private";
    caller?: ConnectionCaller;
    outcome?: ConnectionTokenOutcome;
    published?: Partial<PublishedSpec>;
  } = {},
) {
  const orgId = "org_consumer";
  const keyId = "key_consumer";
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
  specs.set(
    "publisher",
    "video",
    route({ visibility: options.visibility ?? "public", ...options.published }),
  );
  const authenticate = vi.fn(
    async (secret: string): Promise<ConnectionCaller> =>
      secret === KEY
        ? (options.caller ?? { status: "ok", orgId, keyId })
        : { status: "invalid" },
  );
  return {
    orgId,
    keyId,
    tokenCalls,
    controlCalls,
    connections,
    deps: { authenticate, specSource: specs, connections },
    setOutcome: (next: ConnectionTokenOutcome) => {
      outcome = next;
    },
    setControl: (next: typeof control) => {
      control = next;
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

async function send(
  f: Fixture,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    key?: string | null;
  } = {},
) {
  const key = init.key === undefined ? KEY : init.key;
  const response = await handleConnectionsRequest(
    new Request(`https://gateway.test${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(key ? { "x-api-key": key } : {}),
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    f.deps,
  );
  if (!response) throw new Error(`unrouted ${path}`);
  return response;
}

async function call(
  f: Fixture,
  path: string,
  method = "POST",
  options: { upstream?: string; header?: string } = {},
) {
  const spec = parseSpec(
    JSON.stringify(
      options.upstream
        ? { ...SPEC, servers: [{ url: options.upstream }] }
        : SPEC,
    ),
  );
  return await resolveCallConnection({
    request: new Request(
      `https://gateway.test/gateway/publisher/video${path}`,
      {
        method,
        headers: options.header
          ? { "x-zevium-connection": options.header }
          : {},
      },
    ),
    spec,
    operation: spec.paths[path]![method.toLowerCase() as "get" | "post"]!,
    upstreamUrl: new URL(
      `${options.upstream ?? "https://www.googleapis.com"}${path}`,
    ),
    backend: f.connections,
    orgId: f.orgId,
    projectId: "project_video",
    api: "publisher/video",
    requestId: "req_1",
  });
}

describe("metered calls with connected accounts", () => {
  it("resolves the caller's connection for the project and scheme", async () => {
    const f = fixture();
    expect(await call(f, "/videos")).toEqual({
      id: CONNECTION,
      accessToken: "consumer-access-token",
    });
    expect(f.tokenCalls).toEqual([
      { orgId: f.orgId, projectId: "project_video", scheme: "video" },
    ]);
    expect(await call(f, "/plain", "GET")).toBeUndefined();
  });

  it("sends the consumer's token instead of the publisher's Authorization", async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response("ok"));
    await forward(
      new Request("https://gateway.test/gateway/publisher/video/videos", {
        method: "POST",
        headers: {
          "x-api-key": KEY,
          "x-zevium-connection": CONNECTION,
        },
        body: "{}",
      }),
      {
        published: route({
          upstreamHeaders: {
            authorization: "Bearer publisher-key",
            "x-publisher": "p",
          },
        }),
        verified: { orgId: "org_consumer", keyId: "key", scopes: [] },
        upstreamUrl: new URL("https://www.googleapis.com/videos"),
        connection: { id: CONNECTION, accessToken: "consumer-access-token" },
      },
      upstream,
    );
    const headers = new Headers(upstream.mock.calls[0]![1]!.headers);
    expect(headers.get("authorization")).toBe("Bearer consumer-access-token");
    expect(headers.get("x-publisher")).toBe("p");
    expect(headers.get("x-api-key")).toBeNull();
    // The selector header is Zevium's; it never reaches the upstream.
    expect(headers.get("x-zevium-connection")).toBeNull();
  });

  it("never sends a connected token to a host outside the provider's API", async () => {
    const f = fixture();
    const response = await call(f, "/videos", "POST", {
      upstream: "https://collector.example",
    });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(422);
    expect(await (response as Response).json()).toMatchObject({
      error: "connection_upstream_not_allowed",
      cost: 0,
    });
    expect(f.tokenCalls).toEqual([]);
  });

  it("blocks with a connect hint and no charge when no account is connected", async () => {
    const f = fixture({ outcome: { status: "connection_required" } });
    const response = (await call(f, "/videos")) as Response;
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
  });

  it("asks the caller to choose between several connections", async () => {
    const f = fixture({ outcome: { status: "connection_ambiguous" } });
    expect(((await call(f, "/videos")) as Response).status).toBe(409);
    f.setOutcome({
      status: "ok",
      connectionId: CONNECTION,
      accessToken: "chosen",
    });
    expect(
      await call(f, "/videos", "POST", { header: CONNECTION }),
    ).toMatchObject({ accessToken: "chosen" });
    expect(f.tokenCalls.at(-1)).toMatchObject({ connectionId: CONNECTION });
    expect(
      ((await call(f, "/videos", "POST", { header: "nope" })) as Response)
        .status,
    ).toBe(400);
  });

  it("uses a connection on optional operations only when one exists", async () => {
    const f = fixture({ outcome: { status: "connection_required" } });
    expect(await call(f, "/feed", "GET")).toBeUndefined();
    f.setOutcome({ status: "unavailable" });
    expect(await call(f, "/feed", "GET")).toBeUndefined();
    expect(((await call(f, "/videos")) as Response).status).toBe(503);
  });

  it("fails closed without a backend", async () => {
    const f = fixture();
    const spec = parseSpec(JSON.stringify(SPEC));
    const response = await resolveCallConnection({
      request: new Request("https://gateway.test/x", { method: "POST" }),
      spec,
      operation: spec.paths["/videos"]!.post!,
      upstreamUrl: new URL("https://www.googleapis.com/videos"),
      backend: undefined,
      orgId: f.orgId,
      projectId: "project_video",
      api: "publisher/video",
      requestId: "req",
    });
    expect((response as Response).status).toBe(503);
  });
});

describe("/connections management", () => {
  it("requires a Zevium API key", async () => {
    const f = fixture();
    expect((await send(f, "/connections", { key: null })).status).toBe(401);
    expect((await send(f, "/connections", { key: "zev_unknown" })).status).toBe(
      401,
    );
    expect(f.controlCalls).toEqual([]);
  });

  it("blocks disabled keys and reports verification outages", async () => {
    const disabled = fixture({ caller: { status: "disabled" } });
    expect((await send(disabled, "/connections")).status).toBe(403);
    const down = fixture({ caller: { status: "unavailable" } });
    expect((await send(down, "/connections")).status).toBe(503);
  });

  it("starts a connection with the gateway's fixed callback", async () => {
    const f = fixture();
    f.setControl(() => ({
      connection: { id: CONNECTION, status: "pending" },
      authorizationUrl: "https://auth.video.test/authorize?state=s",
      expiresAt: 123,
    }));
    const response = await send(f, "/connections", {
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
    const f = fixture();
    expect(
      (
        await send(f, "/connections", {
          method: "POST",
          body: { api: "publisher" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send(f, "/connections", {
          method: "POST",
          body: { api: "publisher/video", returnUrl: "http://app.test/done" },
        })
      ).status,
    ).toBe(400);
    f.setControl(() => ({ error: "provider_not_configured" }));
    const response = await send(f, "/connections", {
      method: "POST",
      body: { api: "publisher/video" },
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe(
      "provider_not_configured",
    );
    f.setControl(() => ({ error: "publisher_not_allowed" }));
    expect(
      (
        await send(f, "/connections", {
          method: "POST",
          body: { api: "publisher/video" },
        })
      ).status,
    ).toBe(403);
  });

  it("hides private APIs from other orgs", async () => {
    const f = fixture({ visibility: "private" });
    expect(
      (
        await send(f, "/connections", {
          method: "POST",
          body: { api: "publisher/video" },
        })
      ).status,
    ).toBe(404);
    expect(f.controlCalls).toEqual([]);
  });

  it("lists, reads and revokes the caller org's connections", async () => {
    const f = fixture();
    f.setControl((path, body) =>
      path === "/connections-list" && body.connectionId === undefined
        ? { connections: [{ id: CONNECTION }] }
        : path === "/connections-revoke"
          ? { connection: { id: CONNECTION, status: "revoked" } }
          : { connection: null },
    );
    expect(await (await send(f, "/connections")).json()).toEqual({
      connections: [{ id: CONNECTION }],
    });
    expect((await send(f, `/connections/${CONNECTION}`)).status).toBe(404);
    const revoked = await send(f, `/connections/${CONNECTION}`, {
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
    expect((await send(f, "/connections/not-an-id")).status).toBe(404);
    expect((await send(f, "/connections", { method: "DELETE" })).status).toBe(
      405,
    );
  });
});

describe("/connections/callback", () => {
  it("returns to the app with the outcome", async () => {
    const f = fixture();
    f.setControl(() => ({
      status: "active",
      connectionId: CONNECTION,
      returnUrl: "https://app.test/done?x=1",
    }));
    const response = await send(f, "/connections/callback?state=s1&code=c1", {
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
    const f = fixture();
    f.setControl(() => ({
      status: "denied",
      connectionId: CONNECTION,
      returnUrl: null,
    }));
    const denied = await send(
      f,
      "/connections/callback?state=s1&error=access_denied",
      { key: null },
    );
    expect(denied.status).toBe(200);
    expect(denied.headers.get("content-type")).toContain("text/html");
    expect(await denied.text()).toContain("Connection declined");
    expect((await send(f, "/connections/callback", { key: null })).status).toBe(
      400,
    );
    f.setControl(() => null);
    expect(
      (await send(f, "/connections/callback?state=s2&code=c", { key: null }))
        .status,
    ).toBe(503);
  });
});

describe("worker routing", () => {
  afterEach(() => __setTestPipelineDeps(null));

  it("serves /connections before other routes", async () => {
    const f = fixture();
    f.setControl(() => ({ connections: [] }));
    const specs = new FixtureSpecSource();
    __setTestPipelineDeps({
      keyVerifier: new FixtureKeyVerifier({}),
      specSource: specs,
      publicSpecSource: specs,
      catalogueSource: new FixtureCatalogueSource([]),
      connectionsDeps: f.deps,
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://gateway.test/connections", {
        headers: { "x-api-key": KEY },
      }),
      env as unknown as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connections: [] });
    expect(f.controlCalls).toEqual([
      { path: "/connections-list", body: { orgId: f.orgId } },
    ]);
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
