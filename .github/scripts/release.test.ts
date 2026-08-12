import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  probeRelease,
  resolveCurrentRelease,
  validateConvexDryRun,
  validateCurrentDevelop,
  validateProbeOptions,
  validateRelease,
} from "./release-contract.mjs";
import {
  activeVersion,
  boundedDeploymentVersion,
  recoveryPlan,
  uploadedVersion,
  validateRecoveryArtifact,
  verifyZeroTraffic,
} from "./release-state.mjs";
import {
  classifyLifecycleChange,
  lifecycleDigest,
  lifecycleProjection,
  remoteLifecycleProof,
  verifyRemoteVersionIdentity,
} from "./release-lifecycle.mjs";
import {
  createProtectedAttestation,
  findProtectedRequirements,
  verifyProtectedAttestation,
} from "./release-attestation.mjs";
import {
  main as runWithClerkKey,
  resolveClerkReleaseKey,
} from "./with-clerk-release-key.mjs";

const SHA = "a".repeat(40);
const OLD_SHA = "b".repeat(40);
const CHALLENGE = "c".repeat(64);
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const NOW = 1_900_000_000_000;
const WEB = "https://web.test";
const GATEWAY = "https://gateway.test";
const ACCOUNTING = "https://convex.test/release-probe-accounting";
const API_KEY = "ak_live_" + "k".repeat(40);
const PROBE_SECRET = "p".repeat(48);

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(
    init.status === 204
      ? null
      : typeof body === "string"
        ? body
        : JSON.stringify(body),
    init,
  );
}

function probeOptions(overrides: Record<string, unknown> = {}) {
  return {
    release: SHA,
    web: WEB,
    gateway: GATEWAY,
    mockPath: "/mock/acme/demo/echo",
    mockMethod: "POST",
    meteredPath: "/gateway/acme/demo/echo",
    meteredMethod: "POST",
    contentType: "application/json",
    requestBody: '{"probe":true}',
    apiKey: API_KEY,
    accountingUrl: ACCOUNTING,
    probeSecret: PROBE_SECRET,
    readinessAttempts: 2,
    readinessIntervalMs: 0,
    sleep: vi.fn(),
    challengeFactory: () => CHALLENGE,
    now: () => NOW,
    ...overrides,
  };
}

function releaseFetch(
  accountingBodies: Array<{ status: number; body: unknown }> = [],
) {
  let accountingIndex = 0;
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`${WEB}/?`)) {
      return response(
        `<html><head><title>Zevium</title><meta name="zevium-release" content="${SHA}"></head></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    if (url === `${GATEWAY}/health`) {
      return response(
        { ok: true, service: "zevium-gateway", release: SHA, contract: 1 },
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith(`${WEB}/catalogue?`)) {
      return response(
        "<title>Catalogue · Zevium</title>Public APIs with per-call credits /catalogue/acme/demo",
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    if (url.startsWith(`${GATEWAY}/discovery?`)) {
      return response(
        {
          apis: [
            {
              publisherHandle: "acme",
              slug: "demo",
              endpoints: [{ method: "POST", path: "/echo", credits: 3 }],
            },
          ],
        },
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (
      url === `${GATEWAY}/gateway/acme/demo/echo` &&
      init?.method === "OPTIONS"
    ) {
      return response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "POST, OPTIONS",
        },
      });
    }
    if (url === `${GATEWAY}/mock/acme/demo/echo`) {
      return response(
        { ok: true },
        {
          status: 200,
          headers: {
            "x-zevium-mock": "1",
            "x-zevium-cost": "0",
            "x-zevium-request-id": "mock-id",
          },
        },
      );
    }
    if (url === `${GATEWAY}/gateway/acme/demo/echo`) {
      return response(
        { ok: true },
        {
          status: 200,
          headers: {
            "x-zevium-cost": "3",
            "x-zevium-request-id": REQUEST_ID,
          },
        },
      );
    }
    if (url === ACCOUNTING) {
      const supplied = accountingBodies[accountingIndex++];
      if (supplied) {
        return response(supplied.body, {
          status: supplied.status,
          headers: { "content-type": "application/json" },
        });
      }
      return response(
        {
          status: "settled",
          requestId: REQUEST_ID,
          challenge: CHALLENGE,
          credits: 3,
          platformFeeCredits: 0,
          publisherNetCredits: 3,
        },
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe("challenge-bound release probe", () => {
  it("proves exact release, fresh challenge, paid request, and minimal accounting", async () => {
    const fetchMock = releaseFetch();
    const evidence = await probeRelease(probeOptions(), fetchMock);
    expect(evidence.outcome).toBe("passed");
    expect(
      evidence.checks.map((check: { name: string }) => check.name),
    ).toEqual([
      "web-release-readiness",
      "gateway-release-readiness",
      "web-catalogue-ssr",
      "control-data-contract",
      "gateway-cors-contract",
      "published-spec-mock",
      "metered-wallet-upstream",
      "authoritative-usage-accounting",
    ]);
    const meteredCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === `${GATEWAY}/gateway/acme/demo/echo` &&
        init?.method !== "OPTIONS",
    );
    const meteredHeaders = new Headers(meteredCall?.[1]?.headers);
    expect(meteredHeaders.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(meteredHeaders.get("x-zevium-release-challenge")).toBe(CHALLENGE);
    const accountingCall = fetchMock.mock.calls.find(
      ([url]) => url === ACCOUNTING,
    );
    expect(JSON.parse(String(accountingCall?.[1]?.body))).toEqual({
      requestId: REQUEST_ID,
      challenge: CHALLENGE,
      notBefore: NOW,
      expectedGatewayRelease: SHA,
    });
    expect(JSON.stringify(evidence)).not.toContain(API_KEY);
    expect(JSON.stringify(evidence)).not.toContain(PROBE_SECRET);
    expect(JSON.stringify(evidence)).not.toContain(CHALLENGE);
  });

  it("polls pending settlement but rejects challenge/accounting mismatch", async () => {
    const pending = { status: 202, body: { status: "pending" } };
    const wrong = {
      status: 200,
      body: {
        status: "settled",
        requestId: REQUEST_ID,
        challenge: "d".repeat(64),
        credits: 3,
        platformFeeCredits: 0,
        publisherNetCredits: 3,
      },
    };
    await expect(
      probeRelease(probeOptions(), releaseFetch([pending, wrong])),
    ).rejects.toThrow(/challenge or accounting mismatch/);
  });

  it("bounds secrets, content type, and request body before network access", async () => {
    expect(() =>
      validateProbeOptions(probeOptions({ probeSecret: "short" })),
    ).toThrow(/32-256/);
    expect(() =>
      validateProbeOptions(
        probeOptions({ contentType: "text/plain\r\nx-evil: yes" }),
      ),
    ).toThrow(/valid media type/);
    expect(() =>
      validateProbeOptions(
        probeOptions({ requestBody: "x".repeat(65 * 1024) }),
      ),
    ).toThrow(/64 KiB/);
    expect(validateRelease(SHA)).toBe(SHA);
    expect(() => validateRelease("develop")).toThrow(/40-character/);
    expect(validateCurrentDevelop(SHA, SHA)).toBe(SHA);
    expect(() => validateCurrentDevelop(SHA, OLD_SHA)).toThrow(
      /stopped being current/,
    );
  });

  it("resolves active identity and validates real Convex dry-run target text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          `<title>Zevium</title><meta name="zevium-release" content="${SHA}">`,
          { status: 200, headers: { "content-type": "text/html" } },
        ),
      )
      .mockResolvedValueOnce(
        response(
          { ok: true, service: "zevium-gateway", release: SHA, contract: 1 },
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    await expect(
      resolveCurrentRelease(
        {
          web: WEB,
          gateway: GATEWAY,
          readinessAttempts: 1,
          readinessIntervalMs: 0,
        },
        fetchMock,
      ),
    ).resolves.toBe(SHA);
    const dryRun = `Deploying code to deployment:\n└─ https://prod.convex.cloud\nDeploying to https://prod.convex.cloud... [dry run]`;
    expect(validateConvexDryRun("https://prod.convex.cloud", dryRun)).toBe(
      "https://prod.convex.cloud",
    );
    expect(() =>
      validateConvexDryRun("https://other.convex.cloud", dryRun),
    ).toThrow(/unexpected deployment/);
  });
});

const legacyBase = {
  name: "gateway",
  durable_objects: {
    bindings: [{ name: "WALLET", class_name: "WalletDO" }],
  },
  migrations: [{ tag: "v1", new_sqlite_classes: ["WalletDO"] }],
};

function legacyRemote(tag = "v1") {
  return {
    result: {
      id: "11111111-1111-1111-1111-111111111111",
      metadata: {
        author_email: "release@example.com",
        created_on: "2026-08-12T10:00:00.000Z",
        source: "wrangler",
      },
      resources: {
        bindings: [
          {
            type: "durable_object_namespace",
            name: "WALLET",
            class_name: "WalletDO",
            script_name: null,
            environment: null,
          },
        ],
        script: {
          named_handlers: [{ name: "WalletDO", handlers: ["alarm"] }],
        },
        script_runtime: { migration_tag: tag },
      },
    },
  };
}

describe("Durable Object lifecycle model", () => {
  it("classifies append-only legacy expansion and rejects history rewrite", () => {
    const expanded = {
      ...legacyBase,
      migrations: [
        ...legacyBase.migrations,
        { tag: "v2", new_classes: ["AuditDO"] },
      ],
    };
    expect(classifyLifecycleChange(legacyBase, expanded)).toMatchObject({
      hasChange: true,
      phase: "expand",
      invalid: false,
      baseMode: "legacy",
      mode: "legacy",
    });
    const rewritten = {
      ...legacyBase,
      migrations: [{ tag: "v1", new_classes: ["WalletDO"] }],
    };
    expect(classifyLifecycleChange(legacyBase, rewritten)).toMatchObject({
      invalid: true,
    });
    const transferred = {
      ...legacyBase,
      migrations: [
        ...legacyBase.migrations,
        {
          tag: "v2",
          transferred_classes: [
            { from: "AuditDO", from_script: "audit-worker", to: "AuditDO" },
          ],
        },
      ],
    };
    expect(classifyLifecycleChange(legacyBase, transferred)).toMatchObject({
      phase: "expand",
      invalid: false,
      manualInspectionRequired: true,
    });
    expect(
      lifecycleProjection(transferred).migrations[1].transferredClasses,
    ).toEqual([{ from: "AuditDO", fromScript: "audit-worker", to: "AuditDO" }]);
  });

  it("models supported one-way legacy-to-exports transition", () => {
    const declarative = {
      name: "gateway",
      durable_objects: legacyBase.durable_objects,
      exports: {
        WalletDO: { type: "durable-object", storage: "sqlite" },
      },
    };
    expect(classifyLifecycleChange(legacyBase, declarative)).toMatchObject({
      phase: "contract",
      invalid: false,
      baseMode: "legacy",
      mode: "declarative",
    });
    expect(classifyLifecycleChange(declarative, legacyBase).invalid).toBe(true);
  });

  it("models rename tombstones and two-phase transfer source/target", () => {
    const source = {
      name: "source",
      exports: {
        WalletDO: { type: "durable-object", storage: "sqlite" },
      },
    };
    const renamed = {
      name: "source",
      exports: {
        WalletDO: {
          type: "durable-object",
          state: "renamed",
          renamed_to: "AccountDO",
        },
        AccountDO: { type: "durable-object", storage: "sqlite" },
      },
    };
    expect(classifyLifecycleChange(source, renamed)).toMatchObject({
      phase: "contract",
      invalid: false,
      manualInspectionRequired: true,
    });
    const targetPrepare = {
      name: "target",
      exports: {
        WalletDO: {
          type: "durable-object",
          state: "expecting-transfer",
          storage: "sqlite",
          transfer_from: "source",
        },
      },
    };
    expect(
      classifyLifecycleChange({ name: "target" }, targetPrepare),
    ).toMatchObject({
      phase: "expand",
      invalid: false,
      manualInspectionRequired: true,
    });
    const transferred = {
      name: "source",
      exports: {
        WalletDO: {
          type: "durable-object",
          state: "transferred",
          transferred_to: "target",
        },
      },
    };
    expect(classifyLifecycleChange(source, transferred)).toMatchObject({
      phase: "contract",
      invalid: false,
      manualInspectionRequired: true,
    });

    const targetFinal = {
      name: "target",
      durable_objects: {
        bindings: [{ name: "WALLET", class_name: "WalletDO" }],
      },
      exports: {
        WalletDO: { type: "durable-object", storage: "sqlite" },
      },
    };
    expect(classifyLifecycleChange(targetPrepare, targetFinal)).toMatchObject({
      phase: "contract",
      invalid: false,
      manualInspectionRequired: true,
    });
  });

  it("proves legacy provider bindings, handler, and migration tag exactly", () => {
    expect(
      verifyRemoteVersionIdentity(
        legacyRemote(),
        "11111111-1111-1111-1111-111111111111",
      ),
    ).toBe(true);
    expect(() =>
      verifyRemoteVersionIdentity(
        legacyRemote(),
        "22222222-2222-2222-2222-222222222222",
      ),
    ).toThrow(/requested id/);
    expect(remoteLifecycleProof(legacyRemote(), legacyBase)).toEqual({
      provable: true,
      matches: true,
      reasons: [],
    });
    expect(remoteLifecycleProof(legacyRemote("v0"), legacyBase)).toMatchObject({
      matches: false,
      reasons: expect.arrayContaining(["legacy migration tag differs"]),
    });
    const missingHandlers = legacyRemote();
    delete missingHandlers.result.resources.script;
    expect(remoteLifecycleProof(missingHandlers, legacyBase)).toMatchObject({
      provable: false,
      matches: false,
    });
  });

  it("proves live declarative exports but fails closed on invisible tombstones", () => {
    const config = {
      name: "gateway",
      durable_objects: legacyBase.durable_objects,
      exports: {
        WalletDO: { type: "durable-object", storage: "sqlite" },
      },
    };
    const remote = {
      result: {
        id: "22222222-2222-2222-2222-222222222222",
        metadata: {
          author_email: "release@example.com",
          created_on: "2026-08-12T10:05:00.000Z",
          source: "wrangler",
        },
        resources: {
          bindings: legacyRemote().result.resources.bindings,
          script: {
            named_handlers: [{ name: "WalletDO", handlers: ["fetch"] }],
          },
          script_runtime: {
            migration_tag: null,
            exports: {
              default: { type: "worker", state: "created" },
              WalletDO: {
                type: "durable-object",
                state: "created",
                storage: "sqlite",
              },
            },
          },
        },
      },
    };
    expect(remoteLifecycleProof(remote, config)).toMatchObject({
      provable: true,
      matches: true,
    });
    const tombstone = {
      name: "gateway",
      durable_objects: { bindings: [] },
      exports: {
        WalletDO: { type: "durable-object", state: "deleted" },
      },
    };
    expect(remoteLifecycleProof(remote, tombstone)).toMatchObject({
      provable: false,
      matches: false,
      reasons: expect.arrayContaining([
        "provider version metadata cannot prove declarative tombstones",
      ]),
    });
    const stateOnlyTombstone = structuredClone(remote);
    stateOnlyTombstone.result.resources.bindings = [];
    stateOnlyTombstone.result.resources.script.named_handlers = [];
    stateOnlyTombstone.result.resources.script_runtime.exports = {};
    expect(remoteLifecycleProof(stateOnlyTombstone, tombstone)).toMatchObject({
      provable: false,
      matches: false,
      reasons: expect.arrayContaining([
        "provider version metadata cannot prove declarative tombstones",
      ]),
    });
  });

  it("fails closed on tombstone cleanup, direct live removal, and malformed export metadata", () => {
    const tombstone = {
      name: "gateway",
      exports: {
        OldDO: { type: "durable-object", state: "deleted" },
      },
    };
    expect(
      classifyLifecycleChange(tombstone, { name: "gateway" }),
    ).toMatchObject({
      phase: "contract",
      invalid: false,
      manualInspectionRequired: true,
      manualInspectionReasons: expect.arrayContaining([
        "tombstone OldDO removal requires provider removable_entries proof",
      ]),
    });
    const live = {
      name: "gateway",
      exports: { LiveDO: { type: "durable-object", storage: "sqlite" } },
    };
    expect(classifyLifecycleChange(live, { name: "gateway" })).toMatchObject({
      invalid: true,
    });
    expect(() =>
      lifecycleProjection({
        name: "gateway",
        exports: { API: { type: "worker", cache: { enabled: "yes" } } },
      }),
    ).toThrow(/Invalid worker export/);
    expect(
      classifyLifecycleChange(
        { name: "gateway" },
        {
          name: "gateway",
          exports: {
            LegacyDO: { type: "durable-object", storage: "legacy-kv" },
          },
        },
      ),
    ).toMatchObject({ invalid: true });
  });

  it("includes binding script/environment and selected Wrangler env in digest", () => {
    const config = {
      ...legacyBase,
      env: {
        staging: {
          durable_objects: {
            bindings: [
              {
                name: "WALLET",
                class_name: "WalletDO",
                script_name: "gateway-staging",
                environment: "staging",
              },
            ],
          },
        },
      },
    };
    expect(lifecycleProjection(config, "staging").bindings[0]).toEqual({
      name: "WALLET",
      className: "WalletDO",
      scriptName: "gateway-staging",
      environment: "staging",
    });
    expect(lifecycleDigest(config, "staging")).not.toBe(
      lifecycleDigest(config),
    );
    expect(lifecycleProjection(config, "staging").workerName).toBe(
      "gateway-staging",
    );

    const withoutNamedBindings = {
      ...legacyBase,
      env: { staging: {} },
    };
    expect(
      lifecycleProjection(withoutNamedBindings, "staging").bindings,
    ).toEqual([]);
  });
});

describe("Clerk runtime release-key resolver", () => {
  const organization = { id: "org_exact", slug: "consumer" };
  const membership = {
    id: "orgmem_exact",
    role: "org:member",
    permissions: [],
    organization,
    publicUserData: { userId: "user_member" },
  };
  const matchingKey = {
    id: "ak_exact",
    type: "api_key",
    name: "Protected release probe",
    subject: "user_member",
    scopes: [],
    createdBy: "user_member",
    claims: { org_id: "org_exact" },
    revoked: false,
    revocationReason: null,
    expired: false,
    expiration: null,
    description: "Dedicated release probe",
    lastUsedAt: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 30_000,
  };

  function paginatedClient(keys = [matchingKey]) {
    const organizations = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: "org_other", slug: "consumer-old" }],
        totalCount: 2,
      })
      .mockResolvedValueOnce({ data: [organization], totalCount: 2 });
    const memberships = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            ...membership,
            id: "orgmem_other",
            publicUserData: { userId: "user_other" },
          },
        ],
        totalCount: 2,
      })
      .mockResolvedValueOnce({ data: [membership], totalCount: 2 });
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: keys.slice(0, 1),
        totalCount: keys.length,
      })
      .mockResolvedValueOnce({ data: keys.slice(1), totalCount: keys.length });
    if (keys.length === 1) {
      list.mockReset().mockResolvedValueOnce({ data: keys, totalCount: 1 });
    }
    return {
      organizations: {
        getOrganizationList: organizations,
        getOrganizationMembershipList: memberships,
      },
      apiKeys: {
        list,
        getSecret: vi.fn().mockResolvedValue({ secret: API_KEY }),
        verify: vi.fn().mockResolvedValue(matchingKey),
      },
    };
  }

  it("enumerates every page and resolves exact org/member/active org claim", async () => {
    const client = paginatedClient();
    await expect(
      resolveClerkReleaseKey({
        client,
        orgSlug: "consumer",
        memberUserId: "user_member",
        now: NOW,
      }),
    ).resolves.toEqual({
      id: "ak_exact",
      secret: API_KEY,
      organizationId: "org_exact",
    });
    expect(client.organizations.getOrganizationList).toHaveBeenCalledTimes(2);
    expect(
      client.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(2);
    expect(client.apiKeys.list).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "user_member", includeInvalid: true }),
    );
  });

  it("fails ambiguity and supports one exact key-id override", async () => {
    const second = { ...matchingKey, id: "ak_second" };
    const ambiguous = paginatedClient([matchingKey, second]);
    await expect(
      resolveClerkReleaseKey({
        client: ambiguous,
        orgSlug: "consumer",
        memberUserId: "user_member",
        now: NOW,
      }),
    ).rejects.toThrow(/unambiguous.*found 2/);
    expect(ambiguous.apiKeys.getSecret).not.toHaveBeenCalled();
    await expect(
      resolveClerkReleaseKey({
        client: paginatedClient([matchingKey, second]),
        orgSlug: "consumer",
        memberUserId: "user_member",
        keyId: "ak_second",
        now: NOW,
      }),
    ).resolves.toMatchObject({ id: "ak_second" });
  });

  it("rejects revoked, expired, wrong creator, and cross-org claims", async () => {
    for (const key of [
      { ...matchingKey, revoked: true },
      { ...matchingKey, expired: true },
      { ...matchingKey, expiration: NOW },
      { ...matchingKey, createdBy: "user_other" },
      { ...matchingKey, claims: { org_id: "org_other" } },
    ]) {
      await expect(
        resolveClerkReleaseKey({
          client: paginatedClient([key]),
          orgSlug: "consumer",
          memberUserId: "user_member",
          now: NOW,
        }),
      ).rejects.toThrow(/active Clerk API key, found 0/);
    }
  });

  it("fails closed on malformed provider rows and cross-org membership drift", async () => {
    const malformed = paginatedClient();
    malformed.apiKeys.list.mockReset().mockResolvedValueOnce({
      data: [{ ...matchingKey, type: "oauth_token" }],
      totalCount: 1,
    });
    await expect(
      resolveClerkReleaseKey({
        client: malformed,
        orgSlug: "consumer",
        memberUserId: "user_member",
        now: NOW,
      }),
    ).rejects.toThrow(/invalid schema/);

    const crossOrg = paginatedClient();
    crossOrg.organizations.getOrganizationMembershipList
      .mockReset()
      .mockResolvedValueOnce({
        data: [
          {
            ...membership,
            organization: { id: "org_other", slug: "other" },
          },
        ],
        totalCount: 1,
      });
    await expect(
      resolveClerkReleaseKey({
        client: crossOrg,
        orgSlug: "consumer",
        memberUserId: "user_member",
        now: NOW,
      }),
    ).rejects.toThrow(/membership, found 0/);
  });

  it("masks before spawning and passes secret only in child env", async () => {
    const sensitiveNames = [
      "CLERK_PRODUCTION_SECRET_KEY",
      "CLERK_STAGING_SECRET_KEY",
      "CLERK_SECRET_KEY",
      "CLOUDFLARE_API_TOKEN",
      "CONVEX_DEPLOY_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
    ];
    const previous = Object.fromEntries(
      sensitiveNames.map((name) => [name, process.env[name]]),
    );
    process.env.CLERK_PRODUCTION_SECRET_KEY = "sk_live_" + "s".repeat(40);
    for (const name of sensitiveNames.slice(1))
      process.env[name] = `secret-${name}`;
    const events: string[] = [];
    let childEnv: NodeJS.ProcessEnv | undefined;
    const spawnImpl = vi.fn((_command, _args, options) => {
      events.push("spawn");
      childEnv = options.env;
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });
    try {
      await runWithClerkKey(
        [
          "--clerk-secret-env=CLERK_PRODUCTION_SECRET_KEY",
          "--org-slug=consumer",
          "--member-user-id=user_member",
          "--key-id=ak_exact",
          "--",
          "node",
          "probe.mjs",
        ],
        {
          client: paginatedClient(),
          now: () => NOW,
          mask: (secret: string) => {
            expect(secret).toBe(API_KEY);
            events.push("mask");
          },
          spawnImpl,
        },
      );
      expect(events).toEqual(["mask", "spawn"]);
      expect(childEnv?.RELEASE_PROBE_API_KEY).toBe(API_KEY);
      expect(childEnv?.CLERK_PRODUCTION_SECRET_KEY).toBeUndefined();
      for (const name of sensitiveNames)
        expect(childEnv?.[name]).toBeUndefined();
      expect(spawnImpl.mock.calls[0]?.[1]).not.toContain(API_KEY);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("provider recovery and cancellation fixtures", () => {
  function writeJson(path: string, value: unknown) {
    writeFileSync(path, `${JSON.stringify(value)}\n`);
  }
  const previous = "11111111-1111-1111-1111-111111111111";
  const candidate = "22222222-2222-2222-2222-222222222222";
  const deployment = (id: string, createdOn: string, versions: unknown[]) => ({
    id,
    source: "wrangler",
    strategy: "percentage",
    author_email: "release@example.com",
    created_on: createdOn,
    annotations: { "workers/message": "protected release" },
    versions,
  });
  const manifest = {
    schemaVersion: 2,
    release: SHA,
    activeBase: OLD_SHA,
    lifecycle: { digest: "d".repeat(64), phase: "none", rollbackAllowed: true },
    source: {
      runId: 42,
      runAttempt: 1,
      workflowPath: ".github/workflows/deploy-production.yml",
    },
    gateway: { previousVersion: previous, candidateVersion: candidate },
    web: { previousVersion: previous, candidateVersion: candidate },
    state: "artifacts_uploaded_no_traffic_mutation",
  };

  it("uses newest single-version deployment and exact zero-traffic weights", () => {
    const dir = mkdtempSync(join(tmpdir(), "zevium-state-"));
    const path = join(dir, "deployments.json");
    writeJson(path, [
      deployment("old-deployment", "2026-08-11T10:00:00.000Z", [
        { version_id: "00000000-0000-0000-0000-000000000000", percentage: 100 },
      ]),
      deployment("active-deployment", "2026-08-12T10:00:00.000Z", [
        { version_id: previous, percentage: 100 },
      ]),
    ]);
    expect(activeVersion(path)).toBe(previous);
    writeJson(path, [
      deployment("zero-traffic", "2026-08-12T10:05:00.000Z", [
        { version_id: previous, percentage: 100 },
        { version_id: candidate, percentage: 0 },
      ]),
    ]);
    expect(verifyZeroTraffic(path, previous, candidate)).toBe(true);
    expect(boundedDeploymentVersion(path, previous, candidate)).toBe(previous);
    writeJson(path, [
      deployment("drift", "2026-08-12T10:06:00.000Z", [
        { version_id: previous, percentage: 50 },
        {
          version_id: "33333333-3333-3333-3333-333333333333",
          percentage: 50,
        },
      ]),
    ]);
    expect(() => boundedDeploymentVersion(path, previous, candidate)).toThrow(
      /unrecorded/,
    );
    writeJson(path, [
      deployment("duplicate", "2026-08-12T10:07:00.000Z", [
        { version_id: candidate, percentage: 50 },
        { version_id: candidate, percentage: 50 },
      ]),
    ]);
    expect(() => boundedDeploymentVersion(path, previous, candidate)).toThrow(
      /duplicate/,
    );
    writeJson(path, [
      deployment("wrong-type", "2026-08-12T10:08:00.000Z", [
        { version_id: previous, percentage: "100" },
      ]),
    ]);
    expect(() => activeVersion(path)).toThrow(/traffic percentage/);
  });

  it("extracts exact immutable uploaded version", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "zevium-upload-")),
      "upload.ndjson",
    );
    writeFileSync(
      path,
      `${JSON.stringify({ type: "noise" })}\n${JSON.stringify({ type: "version-upload", version_id: candidate })}\n`,
    );
    expect(uploadedVersion(path)).toBe(candidate);
    writeFileSync(
      path,
      `${JSON.stringify({ type: "version-upload", version_id: previous })}\n${JSON.stringify({ type: "version-upload", version_id: candidate })}\n`,
    );
    expect(() => uploadedVersion(path)).toThrow(/one uploaded version/);
  });

  it("defaults ambiguous cancellation to roll-forward and forbids lifecycle rollback", () => {
    expect(validateRecoveryArtifact(manifest)).toBe("manifest");
    const intent = {
      ...manifest,
      gateway: { previousVersion: previous },
      web: { previousVersion: previous },
    };
    expect(validateRecoveryArtifact(intent)).toBe("intent");
    expect(() =>
      validateRecoveryArtifact({
        ...intent,
        gateway: { ...intent.gateway, candidateVersion: candidate },
      }),
    ).toThrow(/partial candidate/);
    expect(
      recoveryPlan(manifest, { gateway: previous, web: candidate }, "auto"),
    ).toMatchObject({
      action: "roll-forward",
      requiresConvexRollForward: true,
    });
    const safe = {
      ...manifest,
      lastVerifiedState: "artifacts_uploaded_no_traffic_mutation",
    };
    expect(
      recoveryPlan(safe, { gateway: previous, web: previous }, "rollback"),
    ).toMatchObject({ action: "rollback", requiresConvexRollForward: false });
    expect(() =>
      recoveryPlan(
        {
          ...safe,
          lifecycle: { ...safe.lifecycle, rollbackAllowed: false },
          source: {
            ...safe.source,
            workflowPath: ".github/workflows/gateway-do-lifecycle.yml",
          },
        },
        { gateway: previous, web: previous },
        "rollback",
      ),
    ).toThrow(/prohibits rollback/);
  });
});

describe("protected workflow provenance", () => {
  const requirement = {
    kind: "lifecycle",
    targetSha: SHA,
    activeBase: OLD_SHA,
    protectedBase: OLD_SHA,
    phase: "expand",
    digest: "e".repeat(64),
  };
  const attestation = createProtectedAttestation({
    ...requirement,
    runHeadSha: SHA,
    workflowPath: ".github/workflows/gateway-do-lifecycle.yml",
    workflowId: 77,
    runId: 88,
    runAttempt: 2,
    environment: "production-lifecycle",
  });
  const run = {
    id: 88,
    workflow_id: 77,
    path: ".github/workflows/gateway-do-lifecycle.yml",
    head_sha: SHA,
    head_branch: "develop",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    run_attempt: 2,
  };
  const deployment = {
    id: 99,
    ref: "develop",
    sha: SHA,
    environment: "production-lifecycle",
    creator: { login: "github-actions[bot]" },
  };
  const status = {
    id: 100,
    state: "success",
    environment: "production-lifecycle",
    log_url: "https://github.com/acme/zevium/actions/runs/88/job/1",
  };

  it("binds exact workflow id/path, run/head, environment deployment, base, phase, and digest", () => {
    expect(
      verifyProtectedAttestation({
        attestation,
        requirement,
        workflow: {
          id: 77,
          path: ".github/workflows/gateway-do-lifecycle.yml",
        },
        run,
        deployments: [deployment],
        statusesByDeployment: { 99: [status] },
        targetParentSha: OLD_SHA,
      }),
    ).toBe(true);
  });

  it("fails closed on wrong head, workflow, deployment, or duplicate environment proof", () => {
    for (const fixture of [
      { run: { ...run, head_sha: OLD_SHA }, deployments: [deployment] },
      {
        run: { ...run, path: ".github/workflows/fake.yml" },
        deployments: [deployment],
      },
      { run, deployments: [{ ...deployment, environment: "production" }] },
      { run, deployments: [{ ...deployment, sha: OLD_SHA }] },
      { run, deployments: [deployment, { ...deployment, id: 101 }] },
    ]) {
      const statuses = {
        99: [status],
        101: [{ ...status, id: 102 }],
      };
      expect(() =>
        verifyProtectedAttestation({
          attestation,
          requirement,
          workflow: {
            id: 77,
            path: ".github/workflows/gateway-do-lifecycle.yml",
          },
          ...fixture,
          statusesByDeployment: statuses,
          targetParentSha: OLD_SHA,
        }),
      ).toThrow();
    }
  });

  it("binds protected recovery to exact failed lifecycle run", () => {
    const recoveryHead = "f".repeat(40);
    const recovered = createProtectedAttestation({
      ...requirement,
      runHeadSha: recoveryHead,
      workflowPath: ".github/workflows/recover-production.yml",
      workflowId: 91,
      runId: 92,
      runAttempt: 1,
      environment: "production-recovery",
      sourceRunId: 88,
      sourceRunAttempt: 2,
    });
    expect(
      verifyProtectedAttestation({
        attestation: recovered,
        requirement,
        workflow: {
          id: 91,
          path: ".github/workflows/recover-production.yml",
        },
        run: {
          id: 92,
          workflow_id: 91,
          path: ".github/workflows/recover-production.yml",
          head_sha: recoveryHead,
          head_branch: "develop",
          event: "workflow_dispatch",
          status: "completed",
          conclusion: "success",
          run_attempt: 1,
        },
        sourceRun: { ...run, conclusion: "cancelled" },
        deployments: [
          {
            id: 103,
            ref: "develop",
            sha: recoveryHead,
            environment: "production-recovery",
            creator: { login: "github-actions[bot]" },
          },
        ],
        statusesByDeployment: {
          103: [
            {
              id: 104,
              state: "success",
              environment: "production-recovery",
              log_url: "https://github.com/acme/zevium/actions/runs/92/job/1",
            },
          ],
        },
        targetIsAncestor: true,
        targetParentSha: OLD_SHA,
      }),
    ).toBe(true);
    expect(() =>
      verifyProtectedAttestation({
        attestation: recovered,
        requirement,
        workflow: {
          id: 91,
          path: ".github/workflows/recover-production.yml",
        },
        run: {
          id: 92,
          workflow_id: 91,
          path: ".github/workflows/recover-production.yml",
          head_sha: recoveryHead,
          head_branch: "develop",
          event: "workflow_dispatch",
          status: "completed",
          conclusion: "success",
          run_attempt: 1,
        },
        sourceRun: { ...run, head_sha: OLD_SHA, conclusion: "cancelled" },
        deployments: [],
        statusesByDeployment: {},
        targetIsAncestor: true,
        targetParentSha: OLD_SHA,
      }),
    ).toThrow(/source run provenance/);
  });

  it("accepts a coalesced run head only with exact ancestry and protected parent", () => {
    const coalescedHead = "d".repeat(40);
    const coalesced = createProtectedAttestation({
      ...requirement,
      runHeadSha: coalescedHead,
      workflowPath: ".github/workflows/gateway-do-lifecycle.yml",
      workflowId: 77,
      runId: 89,
      runAttempt: 1,
      environment: "production-lifecycle",
    });
    const coalescedRun = {
      ...run,
      id: 89,
      head_sha: coalescedHead,
      run_attempt: 1,
    };
    const coalescedDeployment = {
      ...deployment,
      id: 105,
      sha: coalescedHead,
    };
    const coalescedStatus = {
      ...status,
      id: 106,
      log_url: "https://github.com/acme/zevium/actions/runs/89/job/1",
    };
    const input = {
      attestation: coalesced,
      requirement,
      workflow: {
        id: 77,
        path: ".github/workflows/gateway-do-lifecycle.yml",
      },
      run: coalescedRun,
      deployments: [coalescedDeployment],
      statusesByDeployment: { 105: [coalescedStatus] },
      targetParentSha: OLD_SHA,
    };
    expect(() =>
      verifyProtectedAttestation({ ...input, targetIsAncestor: false }),
    ).toThrow(/not ancestor/);
    expect(
      verifyProtectedAttestation({ ...input, targetIsAncestor: true }),
    ).toBe(true);
    expect(() =>
      verifyProtectedAttestation({
        ...input,
        targetIsAncestor: true,
        targetParentSha: "f".repeat(40),
      }),
    ).toThrow(/parent/);
  });

  it("finds exact buried lifecycle and contract commits in real git history", () => {
    const originalCwd = process.cwd();
    const repo = mkdtempSync(join(tmpdir(), "zevium-provenance-"));
    try {
      process.chdir(repo);
      execFileSync("git", ["init", "-q"]);
      execFileSync("git", ["config", "user.email", "test@example.com"]);
      execFileSync("git", ["config", "user.name", "Release Test"]);
      mkdirSync("apps/gateway", { recursive: true });
      mkdirSync("convex", { recursive: true });
      writeFileSync("apps/gateway/wrangler.jsonc", JSON.stringify(legacyBase));
      writeFileSync("convex/schema.ts", "export const schema = 1;\n");
      execFileSync("git", ["add", "."]);
      execFileSync("git", ["commit", "-qm", "feat: base"]);
      const base = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();

      const expanded = {
        ...legacyBase,
        migrations: [
          ...legacyBase.migrations,
          { tag: "v2", new_classes: ["AuditDO"] },
        ],
      };
      writeFileSync("apps/gateway/wrangler.jsonc", JSON.stringify(expanded));
      execFileSync("git", ["add", "."]);
      execFileSync("git", ["commit", "-qm", "feat(gateway): add audit DO"]);
      const lifecycleSha = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();

      writeFileSync("convex/schema.ts", "export const schema = 2;\n");
      execFileSync("git", ["add", "."]);
      execFileSync("git", [
        "commit",
        "-qm",
        "contract(convex): remove legacy field",
      ]);
      const contractSha = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const requirements = findProtectedRequirements(base, contractSha);
      expect(requirements).toEqual([
        expect.objectContaining({
          kind: "lifecycle",
          targetSha: lifecycleSha,
          activeBase: base,
          protectedBase: base,
        }),
        expect.objectContaining({
          kind: "contract",
          targetSha: contractSha,
          activeBase: base,
          protectedBase: lifecycleSha,
        }),
      ]);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

type Workflow = {
  on?: unknown;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      environment?: string;
      if?: string;
      needs?: string | string[];
      permissions?: Record<string, string>;
      steps?: Array<{
        name?: string;
        uses?: string;
        run?: string;
        if?: string;
      }>;
    }
  >;
};

const workflowFiles = [
  ".github/workflows/ci.yml",
  ".github/workflows/contract-production.yml",
  ".github/workflows/copilot-setup-steps.yml",
  ".github/workflows/deploy-production.yml",
  ".github/workflows/format-fix.yml",
  ".github/workflows/gateway-do-lifecycle.yml",
  ".github/workflows/payment-drill.yml",
  ".github/workflows/preview.yml",
  ".github/workflows/recover-production.yml",
];

function workflow(path: string): Workflow {
  return parseYaml(readFileSync(path, "utf8")) as Workflow;
}

describe("semantic workflow security contracts", () => {
  it("pins every remote action and every runtime/toolchain version", () => {
    for (const path of workflowFiles) {
      const parsed = workflow(path);
      for (const job of Object.values(parsed.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (step.uses && !step.uses.startsWith("./")) {
            expect(step.uses, `${path}: ${step.uses}`).toMatch(
              /^[^@]+@[0-9a-f]{40}$/,
            );
          }
        }
      }
      const source = readFileSync(path, "utf8");
      expect(source).not.toContain("mise");
      expect(source).not.toContain("npm install --global");
      expect(source).not.toContain("PRODUCTION_RELEASE_PROBE_API_KEY");
      expect(source).not.toContain("STAGING_RELEASE_PROBE_API_KEY");
      expect(source).not.toContain("secrets.STAGING_E2E_API_KEY");
    }
  });

  it("runs API stale guard before checkout/cache/setup in every protected release job", () => {
    for (const path of [
      ".github/workflows/deploy-production.yml",
      ".github/workflows/contract-production.yml",
      ".github/workflows/gateway-do-lifecycle.yml",
      ".github/workflows/recover-production.yml",
      ".github/workflows/payment-drill.yml",
    ]) {
      const parsed = workflow(path);
      for (const [name, job] of Object.entries(parsed.jobs ?? {})) {
        if (!job.environment || job.environment === "preview") continue;
        const first = job.steps?.[0];
        expect(first?.name, `${path}:${name}`).toMatch(/Candidate-independent/);
        expect(first?.run).toContain("gh api");
        expect(first?.run).not.toContain("git rev-parse");
      }
    }
  });

  it("classifies lifecycle before staging and gives dedicated lane exclusive ownership", () => {
    const generic = workflow(".github/workflows/deploy-production.yml");
    const preflight = generic.jobs?.preflight;
    const staging = generic.jobs?.staging;
    expect(
      preflight?.steps?.some((step) =>
        step.name?.includes("Classify lifecycle secret-free"),
      ),
    ).toBe(true);
    expect(staging?.needs).toBe("preflight");
    expect(staging?.if).toContain("eligible");
    const classifyRun = preflight?.steps?.find((step) =>
      step.name?.includes("Classify lifecycle secret-free"),
    )?.run;
    expect(classifyRun).toContain(
      "dedicated workflow owns staging and production",
    );
    expect(classifyRun).toContain("verify-remote");
  });

  it("uses signed protected provenance and never trusts raw commit statuses", () => {
    const generic = readFileSync(
      ".github/workflows/deploy-production.yml",
      "utf8",
    );
    expect(generic).toContain("release-attestation.mjs verify-remote");
    for (const path of [
      ".github/workflows/deploy-production.yml",
      ".github/workflows/contract-production.yml",
      ".github/workflows/gateway-do-lifecycle.yml",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(
        /commits\/.*\/status|statuses: write|zevium\/convex-contract|zevium\/gateway-do-lifecycle/,
      );
    }
    for (const path of [
      ".github/workflows/contract-production.yml",
      ".github/workflows/gateway-do-lifecycle.yml",
    ]) {
      const parsed = workflow(path);
      const production = parsed.jobs?.production;
      expect(production?.permissions?.attestations).toBe("write");
      expect(production?.permissions?.["id-token"]).toBe("write");
      expect(
        production?.steps?.some((step) =>
          step.uses?.startsWith("actions/attest@"),
        ),
      ).toBe(true);
    }
  });

  it("keeps identity/provider guards in each mutation run block", () => {
    const mutation =
      /(?:wrangler (?:deploy\b|versions upload\b|versions deploy\b|rollback\b)|convex deploy --yes\b)/;
    for (const path of [
      ".github/workflows/deploy-production.yml",
      ".github/workflows/contract-production.yml",
      ".github/workflows/gateway-do-lifecycle.yml",
      ".github/workflows/recover-production.yml",
    ]) {
      const parsed = workflow(path);
      for (const [jobName, job] of Object.entries(parsed.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (!step.run || !mutation.test(step.run)) continue;
          const lines = step.run.split("\n");
          let segmentStart = 0;
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? "";
            if (!mutation.test(line) || line.includes("--dry-run")) continue;
            const prefix = lines.slice(segmentStart, index).join("\n");
            expect(
              prefix,
              `${path}:${jobName}:${step.name}: identity before ${line.trim()}`,
            ).toContain("gh api");
            if (line.includes("convex deploy --yes")) {
              expect(
                prefix,
                `${path}:${jobName}:${step.name}: Convex proof before ${line.trim()}`,
              ).toContain("convex deploy --dry-run");
            } else {
              expect(
                prefix,
                `${path}:${jobName}:${step.name}: provider proof before ${line.trim()}`,
              ).toMatch(/deployments list[\s\S]*versions view/);
            }
            segmentStart = index + 1;
          }
        }
      }
    }
  });

  it("persists recovery before mutation and handles failure or cancellation without synchronous rollback", () => {
    for (const path of [
      ".github/workflows/deploy-production.yml",
      ".github/workflows/contract-production.yml",
      ".github/workflows/gateway-do-lifecycle.yml",
    ]) {
      const parsed = workflow(path);
      const production = parsed.jobs?.production;
      const steps = production?.steps ?? [];
      const persisted = steps.findIndex((step) =>
        step.name?.toLowerCase().includes("recovery manifest before"),
      );
      const firstMutation = steps.findIndex(
        (step) =>
          step.run &&
          /convex deploy --yes\b|wrangler versions upload\b/.test(step.run),
      );
      expect(persisted, path).toBeGreaterThan(-1);
      expect(firstMutation, path).toBeGreaterThan(persisted);
      expect(steps.some((step) => step.if === "failure() || cancelled()")).toBe(
        true,
      );
      expect(readFileSync(path, "utf8")).not.toContain("wrangler rollback");
    }
    const recovery = workflow(".github/workflows/recover-production.yml");
    expect(recovery.jobs?.recover?.environment).toBe("production-recovery");
    expect(
      recovery.jobs?.recover?.steps?.some((step) =>
        step.name?.includes("Prove recovered paid accounting"),
      ),
    ).toBe(true);
    const lifecycle = workflow(".github/workflows/gateway-do-lifecycle.yml");
    const lifecycleProduction = lifecycle.jobs?.production;
    const gatewayMutation = lifecycleProduction?.steps?.find((step) =>
      step.name?.includes("deploy lifecycle atomically"),
    )?.run;
    expect(gatewayMutation).toContain("wrangler deploy --strict");
    expect(gatewayMutation).not.toContain("wrangler versions upload");
  });

  it("wraps every staging/production/recovery paid probe with runtime Clerk resolution", () => {
    for (const path of [
      ".github/workflows/deploy-production.yml",
      ".github/workflows/contract-production.yml",
      ".github/workflows/gateway-do-lifecycle.yml",
      ".github/workflows/recover-production.yml",
    ]) {
      const parsed = workflow(path);
      for (const job of Object.values(parsed.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (step.run?.includes("--accounting=")) {
            expect(step.run, `${path}:${step.name}`).toContain(
              "with-clerk-release-key.mjs",
            );
          }
        }
      }
    }
    const payment = workflow(".github/workflows/payment-drill.yml");
    const e2e = payment.jobs?.["real-sandbox-checkout"]?.steps?.find((step) =>
      step.name?.includes("authenticated publish"),
    );
    expect(e2e?.run).toContain("with-clerk-release-key.mjs");
  });

  it("uses intentional coalescing plus current-tip and descendant provenance guards", () => {
    const parsed = workflow(".github/workflows/deploy-production.yml");
    expect(parsed.concurrency).toEqual({
      group: "production-release",
      "cancel-in-progress": false,
    });
    const source = readFileSync(
      ".github/workflows/deploy-production.yml",
      "utf8",
    );
    expect(source).toContain(
      "Superseded release coalesced into newer develop tip",
    );
    expect(source).toContain("git merge-base --is-ancestor");
    expect(source).toContain("release-attestation.mjs verify-remote");
  });
});
