import type { ConnectionView } from "@zevium/shared";
import type { FunctionArgs } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import { MAX_PENDING_CONNECTIONS } from "../convex/connections";
import type { Id } from "../convex/_generated/dataModel";
import { organization, projectFields } from "./fixtures";
import { harness } from "./helpers";

const { tokenTransportMock } = vi.hoisted(() => ({
  tokenTransportMock: vi.fn(),
}));
vi.mock("../convex/lib/webhookTransport", () => ({
  requestPinnedHttpsForBody: tokenTransportMock,
}));

const INTERNAL_SECRET = "test-only-gateway-internal-secret-never-production";
const CONSUMER = "org_consumer";
const REDIRECT = "https://gateway.zevium.dev/connections/callback";
const CLIENT_SECRET = "zevium-google-client-secret";
const UPLOAD = "https://www.googleapis.com/auth/youtube.upload";
const READ = "https://www.googleapis.com/auth/youtube.readonly";
const ENV = {
  UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({
    current: "k1",
    keys: { k1: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) },
  }),
  GATEWAY_INTERNAL_SECRET: INTERNAL_SECRET,
  OAUTH_GOOGLE_CLIENT_ID: "client-123",
  OAUTH_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  OAUTH_INSTAGRAM_CLIENT_ID: "ig-client",
  OAUTH_INSTAGRAM_CLIENT_SECRET: "ig-secret",
};

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
            scopes: { [UPLOAD]: "Upload", [READ]: "Read" },
          },
        },
      },
    },
  },
  paths: {
    "/health": { get: { "x-zevium-cost": 0, "x-zevium-health-check": true } },
    "/upload/youtube/v3/videos": {
      post: { "x-zevium-cost": 5, security: [{ video: [UPLOAD] }] },
    },
  },
};

const INSTAGRAM_SPEC = {
  ...SPEC,
  servers: [{ url: "https://graph.instagram.com" }],
  components: {
    securitySchemes: {
      ig: {
        type: "oauth2",
        "x-zevium-oauth-provider": "instagram",
        flows: {
          authorizationCode: {
            authorizationUrl: "https://www.instagram.com/oauth/authorize",
            tokenUrl: "https://api.instagram.com/oauth/access_token",
            scopes: {
              instagram_business_basic: "",
              instagram_business_content_publish: "",
            },
          },
        },
      },
    },
  },
  paths: {
    "/me/media": {
      post: {
        "x-zevium-cost": 5,
        security: [
          {
            ig: [
              "instagram_business_basic",
              "instagram_business_content_publish",
            ],
          },
        ],
      },
    },
  },
};

type T = ReturnType<typeof harness>;
/** Union of the internal connection routes' response fields. */
type ResponseBody = {
  error?: string;
  status?: string;
  connectionId?: string | null;
  returnUrl?: string | null;
  accessToken?: string;
  authorizationUrl: string;
  connection: ConnectionView;
  connections: ConnectionView[];
};

async function seed(t: T, spec: object = SPEC, houseOperated = true) {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert(
      "organizations",
      organization("publisher"),
    );
    await ctx.db.insert("organizations", organization("consumer"));
    const projectId = await ctx.db.insert("projects", {
      ...projectFields,
      organizationId,
      slug: "video",
      status: "published",
      visibility: "public",
      desiredVisibility: "public",
      houseOperated,
    });
    const latestVersionId = await ctx.db.insert("specVersions", {
      projectId,
      version: "1.0.0",
      spec: JSON.stringify(spec),
      contentHash: "a".repeat(64),
      publishedAt: 1,
    });
    await ctx.db.patch(projectId, { latestVersionId });
    return { projectId };
  });
}

async function post(
  t: T,
  path: string,
  body: unknown,
  secret = INTERNAL_SECRET,
) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: {
      "x-internal-secret": secret,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as ResponseBody,
  };
}

async function start(
  t: T,
  projectId: Id<"projects">,
  extra: Record<string, unknown> = {},
) {
  return await post(t, "/connections-start", {
    orgId: CONSUMER,
    keyId: "key_1",
    projectId,
    api: "publisher/video",
    redirectUri: REDIRECT,
    ...extra,
  });
}

function tokenResponse(body: Record<string, unknown>, status = 200) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

async function connect(t: T, projectId: Id<"projects">, label?: string) {
  const started = await start(t, projectId, label ? { label } : {});
  const state = new URL(started.body.authorizationUrl).searchParams.get(
    "state",
  );
  tokenTransportMock.mockResolvedValueOnce(
    tokenResponse({
      access_token: `access-${label ?? "1"}`,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: `refresh-${label ?? "1"}`,
      scope: UPLOAD,
    }),
  );
  const callback = await post(t, "/connections-callback", {
    state,
    code: "code-1",
  });
  return { started, state, callback };
}

async function token(t: T, projectId: Id<"projects">, connectionId?: string) {
  return await post(t, "/gateway-connection-token", {
    orgId: CONSUMER,
    projectId,
    scheme: "video",
    ...(connectionId ? { connectionId } : {}),
  });
}

describe("connected accounts", () => {
  const previous = Object.fromEntries(
    Object.keys(ENV).map((key) => [key, process.env[key]]),
  );

  beforeEach(() => {
    Object.assign(process.env, ENV);
    tokenTransportMock.mockReset();
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("refuses to start without the secret, an allowed publisher or a client", async () => {
    const t = harness();
    const { projectId } = await seed(t);
    expect((await post(t, "/connections-start", {}, "wrong")).status).toBe(401);
    expect(
      (await start(t, projectId, { redirectUri: "https://evil.example/cb" }))
        .status,
    ).toBe(400);
    expect((await start(t, projectId, { scheme: "other" })).body).toEqual({
      error: "scheme_not_found",
    });
    await t.run((ctx) => ctx.db.patch(projectId, { houseOperated: false }));
    expect((await start(t, projectId)).body).toEqual({
      error: "publisher_not_allowed",
    });
    await t.run((ctx) => ctx.db.patch(projectId, { houseOperated: true }));
    delete process.env.OAUTH_GOOGLE_CLIENT_SECRET;
    expect((await start(t, projectId)).body).toEqual({
      error: "provider_not_configured",
    });
  });

  it("builds a PKCE authorization link with the scopes operations need", async () => {
    const t = harness();
    const { projectId } = await seed(t);
    const { status, body } = await start(t, projectId, { label: "creator-42" });
    expect(status).toBe(200);
    expect(body.connection).toMatchObject({
      api: "publisher/video",
      scheme: "video",
      provider: "youtube",
      label: "creator-42",
      status: "pending",
      scopes: [UPLOAD],
    });
    expect(body.connection.id).toMatch(/^conn_[a-z2-7]{26}$/);
    const url = new URL(body.authorizationUrl);
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("scope")).toBe(UPLOAD);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    const raw = await t.run((ctx) => ctx.db.query("oauthConnections").first());
    expect(raw?.stateHash).not.toBe(url.searchParams.get("state"));
  });

  it("exchanges the code once, with PKCE and the client secret", async () => {
    const t = harness();
    const { projectId } = await seed(t);
    const { started, state, callback } = await connect(t, projectId);
    expect(callback.body).toEqual({
      status: "active",
      connectionId: started.body.connection.id,
      returnUrl: null,
    });
    const call = tokenTransportMock.mock.calls[0]![0];
    expect(call.method).toBe("POST");
    expect(call.url.toString()).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(call.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("code-1");
    expect(form.get("redirect_uri")).toBe(REDIRECT);
    expect(form.get("client_id")).toBe("client-123");
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(form.get("code_verifier")!),
      ),
    );
    const challenge = btoa(String.fromCharCode(...digest))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(
      new URL(started.body.authorizationUrl).searchParams.get("code_challenge"),
    ).toBe(challenge);

    const raw = await t.run((ctx) => ctx.db.query("oauthConnections").first());
    expect(JSON.stringify(raw)).not.toContain("access-1");
    expect(raw?.codeVerifier).toBeUndefined();

    const replay = await post(t, "/connections-callback", {
      state,
      code: "code-1",
    });
    expect(replay.body.status).toBe("invalid");
    expect(tokenTransportMock).toHaveBeenCalledTimes(1);
  });

  it("records a declined or expired authorization", async () => {
    const t = harness();
    const { projectId } = await seed(t);
    const denied = await start(t, projectId, {
      returnUrl: "https://app.example/done",
    });
    const deniedState = new URL(denied.body.authorizationUrl).searchParams.get(
      "state",
    );
    expect(
      (
        await post(t, "/connections-callback", {
          state: deniedState,
          error: "access_denied",
        })
      ).body,
    ).toEqual({
      status: "denied",
      connectionId: denied.body.connection.id,
      returnUrl: "https://app.example/done",
    });

    const late = await start(t, projectId);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("oauthConnections")
        .withIndex("by_public_id", (q) =>
          q.eq("publicId", late.body.connection.id),
        )
        .unique();
      await ctx.db.patch(row!._id, { pendingExpiresAt: Date.now() - 1 });
    });
    const lateState = new URL(late.body.authorizationUrl).searchParams.get(
      "state",
    );
    expect(
      (await post(t, "/connections-callback", { state: lateState, code: "c" }))
        .body.status,
    ).toBe("expired");
    expect(tokenTransportMock).not.toHaveBeenCalled();

    const list = await post(t, "/connections-list", { orgId: CONSUMER });
    expect(
      list.body.connections.map((c: { status: string }) => c.status).sort(),
    ).toEqual(["failed", "failed"]);
  });

  it("selects the connection for gateway calls", async () => {
    const t = harness();
    const { projectId } = await seed(t);
    expect((await token(t, projectId)).body).toEqual({
      status: "connection_required",
    });

    const first = await connect(t, projectId, "a");
    const id = first.started.body.connection.id;
    expect((await token(t, projectId)).body).toMatchObject({
      status: "ok",
      connectionId: id,
      accessToken: "access-a",
    });

    const second = await connect(t, projectId, "b");
    expect((await token(t, projectId)).body).toEqual({
      status: "connection_ambiguous",
    });
    expect(
      (await token(t, projectId, second.started.body.connection.id)).body,
    ).toMatchObject({
      status: "ok",
      accessToken: "access-b",
    });

    // Another org can't use the id.
    const foreign = await post(t, "/gateway-connection-token", {
      orgId: "org_other",
      projectId,
      scheme: "video",
      connectionId: id,
    });
    expect(foreign.body).toEqual({ status: "connection_not_found" });
    const foreignList = await post(t, "/connections-list", {
      orgId: "org_other",
      connectionId: id,
    });
    expect(foreignList.body).toEqual({ connection: null });
  });

  it("refreshes expired tokens and keeps a non-rotated refresh token", async () => {
    const t = harness();
    const { projectId } = await seed(t);
    const { started } = await connect(t, projectId);
    const expire = () =>
      t.run(async (ctx) => {
        const row = await ctx.db.query("oauthConnections").first();
        await ctx.db.patch(row!._id, { accessExpiresAt: Date.now() + 1000 });
      });
    await expire();
    tokenTransportMock.mockResolvedValueOnce(
      tokenResponse({ access_token: "access-2", expires_in: 3600 }),
    );
    expect((await token(t, projectId)).body).toMatchObject({
      status: "ok",
      connectionId: started.body.connection.id,
      accessToken: "access-2",
    });
    const form = new URLSearchParams(tokenTransportMock.mock.calls[1]![0].body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-1");

    await expire();
    tokenTransportMock.mockResolvedValueOnce(
      tokenResponse({ access_token: "access-3", expires_in: 3600 }),
    );
    await token(t, projectId);
    expect(
      new URLSearchParams(tokenTransportMock.mock.calls[2]![0].body).get(
        "refresh_token",
      ),
    ).toBe("refresh-1");
  });

  it("marks a rejected refresh for reauthorization; transient errors keep the grant", async () => {
    const t = harness();
    const { projectId } = await seed(t);
    const { started } = await connect(t, projectId);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("oauthConnections").first();
      await ctx.db.patch(row!._id, { accessExpiresAt: Date.now() });
    });
    tokenTransportMock.mockResolvedValueOnce(tokenResponse({}, 503));
    expect((await token(t, projectId)).status).toBe(503);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("oauthConnections").first();
      expect(row?.status).toBe("active");
      await ctx.db.patch(row!._id, { refreshLeaseUntil: undefined });
    });

    tokenTransportMock.mockResolvedValueOnce(
      tokenResponse({ error: "invalid_grant" }, 400),
    );
    expect((await token(t, projectId)).body).toEqual({
      status: "connection_reauthorize",
    });
    expect((await token(t, projectId)).body).toEqual({
      status: "connection_reauthorize",
    });
    const view = await post(t, "/connections-list", {
      orgId: CONSUMER,
      connectionId: started.body.connection.id,
    });
    expect(view.body.connection).toMatchObject({
      status: "reauthorize",
      error:
        "The provider revoked or expired this connection. Reconnect the account.",
    });
  });

  it("revokes immediately and hides revoked rows", async () => {
    const t = harness();
    const { projectId } = await seed(t);
    const { started } = await connect(t, projectId);
    const id = started.body.connection.id;
    expect(
      (
        await post(t, "/connections-revoke", {
          orgId: "org_other",
          connectionId: id,
        })
      ).body,
    ).toEqual({ connection: null });
    const revoked = await post(t, "/connections-revoke", {
      orgId: CONSUMER,
      connectionId: id,
    });
    expect(revoked.body.connection.status).toBe("revoked");
    // The provider is asked to revoke the refresh token, after commit.
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    const revokeArgs = scheduled[0]!.args[0] as FunctionArgs<
      typeof internal.connectionsNode.revokeAtProvider
    >;
    expect(revokeArgs).toMatchObject({ provider: "youtube", field: "refresh" });
    expect(JSON.stringify(revokeArgs)).not.toContain("refresh-1");
    tokenTransportMock.mockResolvedValueOnce(tokenResponse({}));
    expect(
      await t.action(internal.connectionsNode.revokeAtProvider, revokeArgs),
    ).toBe(true);
    const revokeCall = tokenTransportMock.mock.calls.at(-1)![0];
    expect(revokeCall.url.toString()).toBe(
      "https://oauth2.googleapis.com/revoke",
    );
    expect(Object.fromEntries(new URLSearchParams(revokeCall.body))).toEqual({
      token: "refresh-1",
    });
    const raw = await t.run((ctx) => ctx.db.query("oauthConnections").first());
    expect(raw?.accessToken).toBeUndefined();
    expect(raw?.refreshToken).toBeUndefined();
    expect((await token(t, projectId)).body).toEqual({
      status: "connection_required",
    });
    expect(
      (await post(t, "/connections-list", { orgId: CONSUMER })).body,
    ).toEqual({
      connections: [],
    });
  });

  it("caps open links per org; expired links free their slot", async () => {
    const t = harness();
    const { projectId } = await seed(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_PENDING_CONNECTIONS; i += 1) {
        await ctx.db.insert("oauthConnections", {
          publicId: `conn_open${i}`,
          clerkOrgId: CONSUMER,
          projectId,
          api: "publisher/video",
          scheme: "video",
          provider: "youtube",
          requestedScopes: [UPLOAD],
          createdByKeyId: "key_1",
          redirectUri: REDIRECT,
          status: "pending",
          tokenRevision: 0,
          pendingExpiresAt: now + 60_000,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    expect((await start(t, projectId)).body).toEqual({
      error: "too_many_pending",
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("oauthConnections")
        .withIndex("by_public_id", (q) => q.eq("publicId", "conn_open0"))
        .unique();
      await ctx.db.patch(row!._id, { pendingExpiresAt: now - 1 });
    });
    expect((await start(t, projectId)).status).toBe(200);
  });

  it("cleans up abandoned authorization links", async () => {
    const t = harness();
    const { projectId } = await seed(t);
    await start(t, projectId);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("oauthConnections").first();
      await ctx.db.patch(row!._id, {
        pendingExpiresAt: Date.now() - 2 * 60 * 60 * 1000,
      });
    });
    expect(await t.mutation(internal.connections.cleanup, {})).toBe(1);
    expect(
      await t.run((ctx) => ctx.db.query("oauthConnections").first()),
    ).toBeNull();
  });

  it("connects Instagram: long-lived swap, renewal cron, GET refresh", async () => {
    const t = harness();
    const { projectId } = await seed(t, INSTAGRAM_SPEC);
    const started = await start(t, projectId, { api: "publisher/ig" });
    const url = new URL(started.body.authorizationUrl);
    expect(url.origin + url.pathname).toBe(
      "https://www.instagram.com/oauth/authorize",
    );
    expect(url.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_content_publish",
    );
    expect(url.searchParams.has("code_challenge")).toBe(false);

    tokenTransportMock
      .mockResolvedValueOnce(
        tokenResponse({
          data: [
            {
              access_token: "short",
              user_id: "17",
              permissions:
                "instagram_business_basic,instagram_business_content_publish",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        tokenResponse({
          access_token: "long-1",
          token_type: "bearer",
          expires_in: 60 * 24 * 3600,
        }),
      );
    const callback = await post(t, "/connections-callback", {
      state: url.searchParams.get("state"),
      code: "ig-code",
    });
    expect(callback.body.status).toBe("active");
    const exchange = tokenTransportMock.mock.calls[0]![0];
    expect(exchange.url.toString()).toBe(
      "https://api.instagram.com/oauth/access_token",
    );
    expect(new URLSearchParams(exchange.body).has("code_verifier")).toBe(false);
    const swap = tokenTransportMock.mock.calls[1]![0];
    expect(swap.method).toBe("GET");
    expect(swap.url.origin + swap.url.pathname).toBe(
      "https://graph.instagram.com/access_token",
    );
    expect(Object.fromEntries(swap.url.searchParams)).toEqual({
      grant_type: "ig_exchange_token",
      client_secret: "ig-secret",
      access_token: "short",
    });

    const row = await t.run((ctx) => ctx.db.query("oauthConnections").first());
    expect(row?.provider).toBe("instagram");
    expect(row?.renewAt).toBe(row!.accessExpiresAt! - 7 * 24 * 3600 * 1000);
    const igToken = await post(t, "/gateway-connection-token", {
      orgId: CONSUMER,
      projectId,
      scheme: "ig",
    });
    expect(igToken.body).toMatchObject({ status: "ok", accessToken: "long-1" });

    // Nothing is due yet; then the renewal window opens.
    expect(await t.mutation(internal.connections.scheduleRenewals, {})).toBe(0);
    await t.run((ctx) => ctx.db.patch(row!._id, { renewAt: Date.now() - 1 }));
    expect(await t.mutation(internal.connections.scheduleRenewals, {})).toBe(1);

    tokenTransportMock.mockResolvedValueOnce(
      tokenResponse({
        access_token: "long-2",
        token_type: "bearer",
        expires_in: 60 * 24 * 3600,
      }),
    );
    expect(
      await t.action(internal.connectionsNode.refresh, {
        connectionId: row!.publicId,
        tokenRevision: row!.tokenRevision,
      }),
    ).toMatchObject({ status: "ok", accessToken: "long-2" });
    const renew = tokenTransportMock.mock.calls[2]![0];
    expect(renew.method).toBe("GET");
    expect(Object.fromEntries(renew.url.searchParams)).toEqual({
      grant_type: "ig_refresh_token",
      access_token: "long-1",
    });
    const renewed = await t.run((ctx) => ctx.db.get(row!._id));
    expect(renewed?.renewAt).toBeGreaterThan(Date.now());
  });
});
