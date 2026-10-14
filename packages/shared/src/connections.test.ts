import { describe, expect, it } from "vitest";
import {
  buildAuthorizationUrl,
  collectConnectionUpstreamIssues,
  collectOAuthSchemes,
  isConnectionId,
  isSafeReturnUrl,
  normalizeConnectionLabel,
  operationConnection,
  parseTokenResponse,
  requestedScopes,
} from "./connections.js";
import { OAUTH_PROVIDERS } from "./oauth-providers.js";
import { parseSpec } from "./openapi.js";
import { collectOpenApiSpecIssues } from "./validate.js";

const READ = "https://www.googleapis.com/auth/youtube.readonly";
const UPLOAD = "https://www.googleapis.com/auth/youtube.upload";

const youtube = {
  type: "oauth2",
  "x-zevium-oauth-provider": "youtube",
  flows: {
    authorizationCode: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: { [UPLOAD]: "Upload videos", [READ]: "Read videos" },
    },
  },
};

function spec(overrides: Record<string, unknown> = {}) {
  return {
    openapi: "3.1.0",
    info: { title: "Video", version: "1.0.0" },
    servers: [{ url: "https://www.googleapis.com" }],
    components: {
      securitySchemes: {
        youtube,
        publisherKey: { type: "apiKey", in: "header", name: "x-key" },
      },
    },
    security: [{ youtube: [READ] }],
    paths: {
      "/health": {
        get: {
          "x-zevium-cost": 0,
          "x-zevium-health-check": true,
          security: [],
        },
      },
      "/videos": {
        get: { "x-zevium-cost": 1 },
        post: { "x-zevium-cost": 5, security: [{ youtube: [UPLOAD] }] },
      },
      "/public": {
        get: {
          "x-zevium-cost": 1,
          security: [{ youtube: [READ] }, {}],
        },
      },
      "/keyed": {
        get: { "x-zevium-cost": 1, security: [{ publisherKey: [] }] },
      },
    },
    ...overrides,
  };
}

describe("collectOAuthSchemes", () => {
  it("binds provider schemes to the registry", () => {
    const { schemes, issues } = collectOAuthSchemes(
      parseSpec(JSON.stringify(spec())),
    );
    expect(issues).toEqual([]);
    expect(schemes).toEqual([
      { name: "youtube", provider: "youtube", scopes: [UPLOAD, READ] },
    ]);
  });

  it("rejects unknown providers, foreign endpoints and scopes", () => {
    const foreign = {
      ...youtube,
      flows: {
        authorizationCode: {
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://evil.example/token",
          scopes: { "video.delete": "" },
        },
      },
    };
    const unknown = { ...youtube, "x-zevium-oauth-provider": "myspace" };
    const { schemes, issues } = collectOAuthSchemes({
      components: { securitySchemes: { foreign, unknown } },
    });
    expect(schemes).toEqual([]);
    expect(issues.map((i) => i.path)).toEqual([
      '$.components.securitySchemes["foreign"].flows.authorizationCode.tokenUrl',
      '$.components.securitySchemes["foreign"].flows.authorizationCode.scopes',
      '$.components.securitySchemes["unknown"].x-zevium-oauth-provider',
    ]);
  });

  it("ignores OAuth schemes without a provider and other flows", () => {
    const plain = {
      type: "oauth2",
      flows: {
        authorizationCode: {
          authorizationUrl: "https://auth.example/authorize",
          tokenUrl: "https://auth.example/token",
          scopes: {},
        },
      },
    };
    const clientCredentials = {
      type: "oauth2",
      "x-zevium-oauth-provider": "youtube",
      flows: {
        clientCredentials: { tokenUrl: "https://x.example/token", scopes: {} },
      },
    };
    expect(
      collectOAuthSchemes({
        components: { securitySchemes: { plain, clientCredentials } },
      }),
    ).toMatchObject({ schemes: [], issues: [] });
  });
});

describe("collectConnectionUpstreamIssues", () => {
  it("allows only the provider's API hosts as upstream", () => {
    expect(collectConnectionUpstreamIssues(spec())).toEqual([]);
    expect(
      collectConnectionUpstreamIssues(
        spec({ servers: [{ url: "https://api.publisher.example" }] }),
      ),
    ).toEqual([
      {
        path: "$.servers[0].url",
        message:
          "Connected YouTube accounts can only call www.googleapis.com or youtube.googleapis.com",
      },
    ]);
    expect(collectConnectionUpstreamIssues(spec({ servers: [] }))).toHaveLength(
      1,
    );
  });
});

describe("operationConnection", () => {
  const parsed = parseSpec(JSON.stringify(spec()));

  it("inherits root security and lets operations override it", () => {
    expect(operationConnection(parsed, parsed.paths["/videos"]!.get!)).toEqual({
      scheme: "youtube",
      provider: "youtube",
      scopes: [READ],
      required: true,
    });
    expect(operationConnection(parsed, parsed.paths["/videos"]!.post!)).toEqual(
      {
        scheme: "youtube",
        provider: "youtube",
        scopes: [UPLOAD],
        required: true,
      },
    );
    expect(
      operationConnection(parsed, parsed.paths["/health"]!.get!),
    ).toBeNull();
    expect(
      operationConnection(parsed, parsed.paths["/keyed"]!.get!),
    ).toBeNull();
  });

  it("is optional when another alternative needs no connection", () => {
    expect(operationConnection(parsed, parsed.paths["/public"]!.get!)).toEqual({
      scheme: "youtube",
      provider: "youtube",
      scopes: [READ],
      required: false,
    });
  });

  it("requests every scope an operation needs, sorted", () => {
    const scheme = collectOAuthSchemes(parsed).schemes[0]!;
    expect(requestedScopes(parsed, scheme)).toEqual([READ, UPLOAD]);
  });
});

describe("spec validation", () => {
  it("accepts a valid connected-account spec", () => {
    expect(
      collectOpenApiSpecIssues(JSON.stringify(spec())).filter(
        (i) => i.level === "error",
      ),
    ).toEqual([]);
  });

  it("rejects a connected-account spec pointed at another host", () => {
    expect(
      collectOpenApiSpecIssues(
        JSON.stringify(spec({ servers: [{ url: "https://evil.example" }] })),
      ),
    ).toContainEqual(
      expect.objectContaining({ level: "error", path: "$.servers[0].url" }),
    );
  });

  it("rejects operations that mix OAuth schemes", () => {
    const second = structuredClone(youtube);
    const issues = collectOpenApiSpecIssues(
      JSON.stringify(
        spec({
          components: { securitySchemes: { youtube, other: second } },
          security: [{ youtube: [] }, { other: [] }],
        }),
      ),
    );
    expect(issues).toContainEqual({
      level: "error",
      path: '$.paths["/videos"].get.security',
      message: "An operation can use at most one connected-account scheme",
    });
  });
});

describe("buildAuthorizationUrl", () => {
  const base = {
    clientId: "client-1",
    redirectUri: "https://gateway.zevium.dev/connections/callback",
    state: "state-1",
  };

  it("uses registry endpoints, extra params and PKCE", () => {
    const url = new URL(
      buildAuthorizationUrl({
        ...base,
        provider: OAUTH_PROVIDERS.youtube,
        codeChallenge: "challenge-1",
        scopes: [READ, UPLOAD],
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      access_type: "offline",
      prompt: "consent",
      response_type: "code",
      client_id: "client-1",
      redirect_uri: "https://gateway.zevium.dev/connections/callback",
      state: "state-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
      scope: `${READ} ${UPLOAD}`,
    });
  });

  it("handles client_key, comma scopes and no PKCE", () => {
    const url = new URL(
      buildAuthorizationUrl({
        ...base,
        provider: OAUTH_PROVIDERS.tiktok,
        codeChallenge: null,
        scopes: ["user.info.basic", "video.publish"],
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_key: "client-1",
      redirect_uri: "https://gateway.zevium.dev/connections/callback",
      state: "state-1",
      scope: "user.info.basic,video.publish",
    });
  });
});

describe("parseTokenResponse", () => {
  const now = 1_000_000;

  it("parses JSON bearer tokens", () => {
    expect(
      parseTokenResponse(
        200,
        "application/json",
        JSON.stringify({
          access_token: "at",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "rt",
          scope: "a b",
        }),
        now,
      ),
    ).toEqual({
      ok: true,
      tokens: {
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: now + 3_600_000,
        scopes: ["a", "b"],
      },
    });
  });

  it("parses form-encoded responses without a token type", () => {
    expect(
      parseTokenResponse(
        200,
        "application/x-www-form-urlencoded",
        "access_token=at&scope=a,b",
        now,
      ),
    ).toEqual({
      ok: true,
      tokens: {
        accessToken: "at",
        refreshToken: null,
        expiresAt: null,
        scopes: ["a", "b"],
      },
    });
  });

  it("unwraps Instagram's data array and permissions", () => {
    expect(
      parseTokenResponse(
        200,
        "application/json",
        JSON.stringify({
          data: [
            {
              access_token: "short",
              user_id: "17",
              permissions:
                "instagram_business_basic,instagram_business_content_publish",
            },
          ],
        }),
        now,
      ),
    ).toEqual({
      ok: true,
      tokens: {
        accessToken: "short",
        refreshToken: null,
        expiresAt: null,
        scopes: [
          "instagram_business_basic",
          "instagram_business_content_publish",
        ],
      },
    });
  });

  it("treats Graph error 190 as a dead grant", () => {
    expect(
      parseTokenResponse(
        400,
        "application/json",
        '{"error":{"message":"expired","type":"OAuthException","code":190}}',
        now,
      ),
    ).toEqual({ ok: false, grantRejected: true });
  });

  it("flags dead grants and rejects non-bearer tokens", () => {
    expect(
      parseTokenResponse(
        400,
        "application/json",
        '{"error":"invalid_grant"}',
        now,
      ),
    ).toEqual({ ok: false, grantRejected: true });
    expect(
      parseTokenResponse(
        200,
        "application/json",
        '{"access_token":"at","token_type":"mac"}',
        now,
      ),
    ).toEqual({ ok: false, grantRejected: false });
    expect(parseTokenResponse(503, "text/html", "<html>", now)).toEqual({
      ok: false,
      grantRejected: false,
    });
  });
});

describe("input helpers", () => {
  it("validates ids, labels and return URLs", () => {
    expect(isConnectionId("conn_abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(isConnectionId("conn_ABC")).toBe(false);
    expect(normalizeConnectionLabel("  user-42 ")).toBe("user-42");
    expect(normalizeConnectionLabel("")).toBeNull();
    expect(normalizeConnectionLabel("x".repeat(65))).toBe(false);
    expect(normalizeConnectionLabel("bad\nlabel")).toBe(false);
    expect(isSafeReturnUrl("https://app.example.com/done")).toBe(true);
    expect(isSafeReturnUrl("http://localhost:3000/done")).toBe(true);
    expect(isSafeReturnUrl("http://app.example.com/done")).toBe(false);
    expect(isSafeReturnUrl("javascript:alert(1)")).toBe(false);
  });
});
