import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
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
  beginRecoveryAttempt,
  boundedDeploymentLineageVersion,
  boundedDeploymentVersion,
  createRecoveryLineagePredicate,
  createRecoveryIntent,
  extractRecoveryLineageAttestation,
  finalizeRecoveryAttempt,
  finalizeRecoveryHandoff,
  recoveryAdmission,
  recoveryPlan,
  uploadedVersion,
  validateRecoveryArtifact,
  verifyRecoveryAdmission,
  verifyRecoveryVersionLineage,
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
  policyTreeDigest,
  verifyProtectedAttestation,
} from "./release-attestation.mjs";
import {
  classifyConvexContract,
  convexContractAt,
} from "./release-convex-contract.mjs";
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
    expiration: NOW + 10 * 60_000,
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
        keyId: "ak_exact",
        now: NOW,
      }),
    ).resolves.toEqual({
      id: "ak_exact",
      secret: API_KEY,
      organizationId: "org_exact",
      expiration: NOW + 10 * 60_000,
    });
    expect(client.organizations.getOrganizationList).toHaveBeenCalledTimes(2);
    expect(
      client.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(2);
    expect(client.apiKeys.list).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "user_member", includeInvalid: true }),
    );
  });

  it("requires one exact short-lived key id", async () => {
    const second = { ...matchingKey, id: "ak_second" };
    const ambiguous = paginatedClient([matchingKey, second]);
    await expect(
      resolveClerkReleaseKey({
        client: ambiguous,
        orgSlug: "consumer",
        memberUserId: "user_member",
        now: NOW,
      }),
    ).rejects.toThrow(/release probe API key id is required/);
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
          keyId: "ak_exact",
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
        keyId: "ak_exact",
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
        keyId: "ak_exact",
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
      "GITHUB_ENV",
      "GITHUB_OUTPUT",
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_URL",
    ];
    const previous = Object.fromEntries(
      sensitiveNames.map((name) => [name, process.env[name]]),
    );
    process.env.CLERK_PRODUCTION_SECRET_KEY = "sk_live_" + "s".repeat(40);
    for (const name of sensitiveNames.slice(1))
      process.env[name] = `secret-${name}`;
    const events: string[] = [];
    let childEnv: NodeJS.ProcessEnv | undefined;
    const client = paginatedClient();
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
          client,
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
      expect(client.apiKeys.verify).toHaveBeenCalledTimes(2);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("rechecks key rotation and revocation after a failed child", async () => {
    const previous = process.env.CLERK_PRODUCTION_SECRET_KEY;
    process.env.CLERK_PRODUCTION_SECRET_KEY = "sk_live_" + "s".repeat(40);
    const client = paginatedClient();
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 9, null));
      return child;
    });
    try {
      await expect(
        runWithClerkKey(
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
            client,
            now: () => NOW,
            mask: vi.fn(),
            spawnImpl,
          },
        ),
      ).rejects.toThrow(/exited 9/);
      expect(client.apiKeys.verify).toHaveBeenCalledTimes(2);
    } finally {
      if (previous === undefined)
        delete process.env.CLERK_PRODUCTION_SECRET_KEY;
      else process.env.CLERK_PRODUCTION_SECRET_KEY = previous;
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
  const rootSource = {
    runId: 42,
    runAttempt: 1,
    workflowPath: ".github/workflows/deploy-production.yml",
  };
  const intent = createRecoveryIntent({
    schemaVersion: 3,
    release: SHA,
    activeBase: OLD_SHA,
    lifecycle: { digest: "d".repeat(64), phase: "none", rollbackAllowed: true },
    root: rootSource,
    source: rootSource,
    gateway: { previousVersion: previous },
    web: { previousVersion: previous },
    state: "rollback_pointers_captured_no_traffic_mutation",
  });
  const manifest = finalizeRecoveryAttempt(
    intent,
    candidate,
    candidate,
    "artifacts_uploaded_no_traffic_mutation",
  );

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
    expect(() =>
      createRecoveryIntent({
        schemaVersion: 3,
        release: SHA,
        activeBase: OLD_SHA,
        lifecycle: {
          digest: "d".repeat(64),
          phase: "none",
          rollbackAllowed: true,
        },
        root: rootSource,
        source: { ...rootSource, runId: rootSource.runId + 1 },
        gateway: { previousVersion: previous },
        web: { previousVersion: previous },
      }),
    ).toThrow(/equal root/);
    expect(validateRecoveryArtifact(manifest)).toBe("manifest");
    expect(validateRecoveryArtifact(intent)).toBe("intent");
    expect(() =>
      validateRecoveryArtifact({
        ...intent,
        gateway: { ...intent.gateway, candidateVersion: candidate },
      }),
    ).toThrow(/partial candidate/);
    expect(
      recoveryPlan(manifest, { gateway: candidate, web: previous }, "auto"),
    ).toMatchObject({
      action: "roll-forward",
      requiresConvexRollForward: false,
    });
    const safe = {
      ...manifest,
      lastVerifiedState: "rollback_pointers_captured_no_traffic_mutation",
    };
    expect(
      recoveryPlan(safe, { gateway: previous, web: previous }, "rollback"),
    ).toMatchObject({ action: "rollback", requiresConvexRollForward: false });
    expect(
      recoveryPlan(
        {
          ...manifest,
          lastVerifiedState: "artifacts_uploaded_no_traffic_mutation",
        },
        { gateway: previous, web: previous },
        "auto",
      ),
    ).toMatchObject({
      action: "rollback",
      requiresConvexRollForward: false,
    });
    const lifecycleSource = {
      runId: 43,
      runAttempt: 1,
      workflowPath: ".github/workflows/gateway-do-lifecycle.yml",
    };
    const lifecycleIntent = createRecoveryIntent({
      schemaVersion: 3,
      release: SHA,
      activeBase: OLD_SHA,
      protectedTarget: SHA,
      protectedBase: OLD_SHA,
      lifecycle: {
        digest: "e".repeat(64),
        phase: "expand",
        rollbackAllowed: false,
      },
      root: lifecycleSource,
      source: lifecycleSource,
      gateway: { previousVersion: previous },
      web: { previousVersion: previous },
      state: "rollback_pointers_captured_no_traffic_mutation",
    });
    const lifecycleManifest = finalizeRecoveryAttempt(
      lifecycleIntent,
      candidate,
      candidate,
    );
    expect(() =>
      recoveryPlan(
        lifecycleManifest,
        { gateway: previous, web: previous },
        "rollback",
      ),
    ).toThrow(/prohibits rollback/);
  });

  it("recovers recursively and rejects versions outside the hash-bound lineage", () => {
    const recoverySource = {
      runId: 84,
      runAttempt: 3,
      workflowPath: ".github/workflows/recover-production.yml",
    };
    const pending = beginRecoveryAttempt(manifest, recoverySource);
    expect(validateRecoveryArtifact(pending)).toBe("manifest");
    const token = pending.lineage.attempts.at(-1)?.token;
    const recoveryGateway = "33333333-3333-3333-3333-333333333333";
    const recoveryWeb = "44444444-4444-4444-4444-444444444444";
    expect(
      verifyRecoveryVersionLineage(pending, {
        result: {
          id: recoveryGateway,
          annotations: { "workers/tag": token },
        },
      }),
    ).toMatchObject({ id: recoveryGateway, token });
    expect(() =>
      verifyRecoveryVersionLineage(pending, {
        result: {
          id: recoveryGateway,
          annotations: { "workers/tag": "f".repeat(64) },
        },
      }),
    ).toThrow(/cryptographic lineage/);

    const recursive = finalizeRecoveryAttempt(
      pending,
      recoveryGateway,
      recoveryWeb,
    );
    expect(
      recoveryPlan(
        recursive,
        { gateway: candidate, web: candidate },
        "roll-forward",
      ),
    ).toMatchObject({
      gatewayVersion: recoveryGateway,
      webVersion: recoveryWeb,
    });
    expect(() =>
      recoveryPlan(
        recursive,
        {
          gateway: "55555555-5555-5555-5555-555555555555",
          web: recoveryWeb,
        },
        "roll-forward",
      ),
    ).toThrow(/cryptographic recovery lineage/);

    const deploymentPath = join(
      mkdtempSync(join(tmpdir(), "zevium-lineage-")),
      "deployments.json",
    );
    writeJson(deploymentPath, [
      deployment("recovered", "2026-08-12T11:00:00.000Z", [
        { version_id: candidate, percentage: 100 },
      ]),
    ]);
    expect(
      boundedDeploymentLineageVersion(deploymentPath, recursive, "gateway"),
    ).toBe(candidate);
    writeJson(deploymentPath, [
      deployment("forged", "2026-08-12T11:01:00.000Z", [
        {
          version_id: "55555555-5555-5555-5555-555555555555",
          percentage: 100,
        },
      ]),
    ]);
    expect(() =>
      boundedDeploymentLineageVersion(deploymentPath, recursive, "gateway"),
    ).toThrow(/cryptographic recovery lineage/);

    const tampered = structuredClone(recursive);
    tampered.lineage.attempts.at(-1)!.gatewayVersion =
      "66666666-6666-6666-6666-666666666666";
    expect(() => validateRecoveryArtifact(tampered)).toThrow(/lineage/);
  });

  it("keeps every finalized candidate recoverable across repeated cancellation handoffs", () => {
    let recursive = manifest;
    const gatewayVersions = [candidate];
    const webVersions = [candidate];
    for (let attempt = 3; attempt <= 7; attempt += 1) {
      const source = {
        runId: 100 + attempt,
        runAttempt: attempt,
        workflowPath: ".github/workflows/recover-production.yml",
      };
      const pending = beginRecoveryAttempt(recursive, source);
      const byte = String(attempt).repeat(8);
      const gateway = `${byte}-${byte.slice(0, 4)}-${byte.slice(0, 4)}-${byte.slice(0, 4)}-${byte}${byte.slice(0, 4)}`;
      const webByte = String(attempt + 1).repeat(8);
      const web = `${webByte}-${webByte.slice(0, 4)}-${webByte.slice(0, 4)}-${webByte.slice(0, 4)}-${webByte}${webByte.slice(0, 4)}`;
      recursive = finalizeRecoveryAttempt(pending, gateway, web);
      gatewayVersions.push(gateway);
      webVersions.push(web);
      for (let index = 0; index < gatewayVersions.length; index += 1) {
        expect(() =>
          recoveryPlan(
            recursive,
            {
              gateway: gatewayVersions[index],
              web: webVersions[index],
            },
            "roll-forward",
          ),
        ).not.toThrow();
      }
    }
  });

  it("hash-binds recursive handoffs without duplicating provider version IDs", () => {
    const source = {
      runId: 287,
      runAttempt: 2,
      workflowPath: ".github/workflows/recover-production.yml",
    };
    const pending = beginRecoveryAttempt(manifest, source);
    const handoff = finalizeRecoveryHandoff(pending);
    expect(validateRecoveryArtifact(handoff)).toBe("manifest");
    expect(handoff.gateway.candidateVersion).toBe(candidate);
    expect(handoff.web.candidateVersion).toBe(candidate);
    expect(handoff.lineage.attempts.at(-1)).toMatchObject({
      reusedCandidateDigest: manifest.lineage.attempts.at(-1)?.digest,
      source,
    });
    expect(
      recoveryPlan(
        handoff,
        { gateway: candidate, web: candidate },
        "roll-forward",
      ),
    ).toMatchObject({ gatewayVersion: candidate, webVersion: candidate });

    const tampered = structuredClone(handoff);
    tampered.lineage.attempts.at(-1)!.reusedCandidateDigest = "f".repeat(64);
    expect(() => validateRecoveryArtifact(tampered)).toThrow(/handoff/);
    expect(() =>
      finalizeRecoveryAttempt(pending, candidate, candidate),
    ).toThrow(/repeats a provider version/);
  });

  it("treats lifecycle irreversible checkpoint as mandatory Convex roll-forward", () => {
    const lifecycleSource = {
      runId: 991,
      runAttempt: 1,
      workflowPath: ".github/workflows/gateway-do-lifecycle.yml",
    };
    const lifecycle = createRecoveryIntent({
      schemaVersion: 3,
      release: SHA,
      activeBase: OLD_SHA,
      protectedTarget: SHA,
      protectedBase: OLD_SHA,
      lifecycle: {
        digest: "e".repeat(64),
        phase: "expand",
        rollbackAllowed: false,
      },
      root: lifecycleSource,
      source: lifecycleSource,
      gateway: { previousVersion: previous },
      web: { previousVersion: previous },
      state: "convex_mutation_started",
    });
    expect(
      recoveryAdmission(
        lifecycle,
        { gateway: previous, web: previous },
        "auto",
        {
          runId: 992,
          runAttempt: 1,
          workflowPath: ".github/workflows/recover-production.yml",
        },
      ),
    ).toMatchObject({
      action: "roll-forward",
      controlPlaneMayHaveChanged: true,
      requiresConvexRollForward: true,
    });
  });

  it("hash-chains every cancelled pending attempt before another recovery starts", () => {
    let cancelled = manifest;
    for (let attempt = 2; attempt <= 8; attempt += 1) {
      cancelled = beginRecoveryAttempt(cancelled, {
        runId: 300 + attempt,
        runAttempt: attempt,
        workflowPath: ".github/workflows/recover-production.yml",
      });
      expect(validateRecoveryArtifact(cancelled)).toBe("manifest");
      expect(
        recoveryPlan(
          cancelled,
          { gateway: candidate, web: candidate },
          "roll-forward",
        ),
      ).toMatchObject({
        gatewayVersion: candidate,
        webVersion: candidate,
      });
    }
    const tampered = structuredClone(cancelled);
    tampered.lineage.attempts.splice(2, 1);
    expect(() => validateRecoveryArtifact(tampered)).toThrow(/hash chain/);
  });

  it("binds durable lineage predicates and rejects stale or ambiguous attempts", () => {
    const initialPredicate = createRecoveryLineagePredicate(intent);
    const finalPredicate = createRecoveryLineagePredicate(manifest);
    expect(initialPredicate.subjectDigest).not.toBe(
      finalPredicate.subjectDigest,
    );
    expect(finalPredicate.subject.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [
        {
          name: "recovery-lineage-subject.json",
          digest: { sha256: finalPredicate.subjectDigest },
        },
      ],
      predicateType: "https://zevium.dev/attestations/recovery-lineage/v1",
      predicate: finalPredicate,
    };
    const rawBundle = {
      attestations: [
        {
          bundle: {
            dsseEnvelope: {
              payload: Buffer.from(JSON.stringify(statement)).toString(
                "base64",
              ),
            },
          },
        },
      ],
    };
    expect(extractRecoveryLineageAttestation(rawBundle)).toEqual(manifest);
    expect(
      extractRecoveryLineageAttestation([
        { verificationResult: { statement } },
      ]),
    ).toEqual(manifest);
    const forged = structuredClone(rawBundle);
    const forgedStatement = structuredClone(statement);
    forgedStatement.subject[0]!.digest.sha256 = "f".repeat(64);
    forged.attestations[0]!.bundle.dsseEnvelope.payload = Buffer.from(
      JSON.stringify(forgedStatement),
    ).toString("base64");
    expect(() => extractRecoveryLineageAttestation(forged)).toThrow(
      /absent or ambiguous/,
    );

    const recoverySource = {
      runId: 901,
      runAttempt: 1,
      workflowPath: ".github/workflows/recover-production.yml",
    };
    const admission = recoveryAdmission(
      manifest,
      { gateway: previous, web: previous },
      "rollback",
      recoverySource,
    );
    const pending = beginRecoveryAttempt(manifest, recoverySource);
    expect(verifyRecoveryAdmission(admission, pending)).toBe(true);
    expect(
      recoveryPlan(
        pending,
        { gateway: previous, web: previous },
        "rollback",
        admission,
      ),
    ).toMatchObject({ action: "rollback" });
    expect(() =>
      recoveryAdmission(
        pending,
        { gateway: previous, web: previous },
        "rollback",
        recoverySource,
      ),
    ).toThrow(/replays/);
    const stale = structuredClone(pending);
    stale.lineage.head = "f".repeat(64);
    expect(() => verifyRecoveryAdmission(admission, stale)).toThrow();
  });

  it("property-checks ordered provider cuts across recursive recovery", () => {
    let recursive = manifest;
    const pairs = [{ gateway: previous, web: previous }];
    for (let attempt = 2; attempt <= 32; attempt += 1) {
      const pending = beginRecoveryAttempt(recursive, {
        runId: 1_000 + attempt,
        runAttempt: attempt,
        workflowPath: ".github/workflows/recover-production.yml",
      });
      const gateway = attempt.toString(16).padStart(32, "0");
      const web = (attempt + 100).toString(16).padStart(32, "0");
      recursive = finalizeRecoveryAttempt(pending, gateway, web);
      pairs.push({ gateway, web });
    }
    for (let gatewayIndex = 0; gatewayIndex < pairs.length; gatewayIndex += 1) {
      for (let webIndex = 0; webIndex < pairs.length; webIndex += 1) {
        const observed = {
          gateway: pairs[gatewayIndex]!.gateway,
          web: pairs[webIndex]!.web,
        };
        if (webIndex <= gatewayIndex) {
          expect(
            recoveryPlan(recursive, observed, "roll-forward"),
          ).toMatchObject({
            action: "roll-forward",
            gatewayVersion: pairs.at(-1)!.gateway,
            webVersion: pairs.at(-1)!.web,
          });
        } else {
          expect(() =>
            recoveryPlan(recursive, observed, "roll-forward"),
          ).toThrow(/deployment order/);
        }
      }
    }
    const duplicate = beginRecoveryAttempt(recursive, {
      runId: 2_000,
      runAttempt: 1,
      workflowPath: ".github/workflows/recover-production.yml",
    });
    expect(() =>
      finalizeRecoveryAttempt(
        duplicate,
        pairs.at(-1)!.gateway,
        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      ),
    ).toThrow(/repeats a provider version/);
  });
});

describe("exact Convex semantic contract inventory", () => {
  it("tracks all public/internal kinds, typed literals, full indexes, returns, and HTTP routes", () => {
    const originalCwd = process.cwd();
    const repo = mkdtempSync(join(tmpdir(), "zevium-convex-contract-"));
    try {
      process.chdir(repo);
      execFileSync("git", ["init", "-q"]);
      execFileSync("git", ["config", "user.email", "test@example.com"]);
      execFileSync("git", ["config", "user.name", "Release Test"]);
      mkdirSync("convex", { recursive: true });
      mkdirSync("convex/_generated", { recursive: true });
      writeFileSync(
        "convex/_generated/server.ts",
        "export const query = {}; export const mutation = {}; export const action = {}; export const internalQuery = {}; export const internalMutation = {}; export const internalAction = {}; export const httpAction = {};\n",
      );
      writeFileSync(
        "convex/schema.ts",
        `import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({
  items: defineTable({
    mode: v.union(v.literal(1), v.literal("1")),
    body: v.string(),
    group: v.string(),
    embedding: v.array(v.float64()),
  })
    .index("by_mode", ["mode"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["group"] })
    .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 3, filterFields: ["group"] }),
});
`,
      );
      writeFileSync(
        "convex/api.ts",
        `import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query, mutation, action, internalQuery, internalMutation, internalAction as registerInternalAction } from "./_generated/server";
const result = v.object({ ok: v.literal(1) });
export const publicQ = query({ args: { value: v.union(v.literal(1), v.literal("1"), v.literal(-1n)), paginationOpts: paginationOptsValidator }, returns: result, handler: async () => ({ ok: 1 }) });
export const publicM = mutation({ args: {}, returns: v.null(), handler: async () => null });
export const publicA = action({ args: {}, handler: async () => null });
export const internalQ = internalQuery({ args: { value: v.union(v.literal(1), v.literal("1"), v.literal(-1n)) }, returns: result, handler: async () => ({ ok: 1 }) });
export const internalM = internalMutation({ args: {}, returns: v.null(), handler: async () => null });
const internalActionImpl = registerInternalAction({ args: {}, handler: async () => null });
export { internalActionImpl as internalA };
`,
      );
      writeFileSync(
        "convex/http.ts",
        `import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
const http = httpRouter();
http.route({ path: "/direct", method: "POST", handler: httpAction(async () => new Response()) });
http.routePrefix({ pathPrefix: "/prefix/", method: "GET", handler: httpAction(async () => new Response()) });
function webhook(path: string) {
  http.route({ path, method: "POST", handler: httpAction(async () => new Response()) });
}
webhook("/factory");
export default http;
`,
      );
      writeFileSync(
        "convex/defaultApi.ts",
        `import { v } from "convex/values";
import { action as registerAction } from "./_generated/server";
export default registerAction({ args: {}, returns: v.null(), handler: async () => null });
`,
      );
      execFileSync("git", ["add", "."]);
      execFileSync("git", ["commit", "-qm", "anything: semantic base"]);
      const base = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const inventory = convexContractAt(base);
      expect(
        Object.values(inventory.functions).map((entry) => entry.kind),
      ).toEqual(
        expect.arrayContaining([
          "query",
          "mutation",
          "action",
          "internalQuery",
          "internalMutation",
          "internalAction",
        ]),
      );
      expect(inventory.tables.items.indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: "index", fields: ["mode"] }),
          expect.objectContaining({
            method: "searchIndex",
            config: expect.objectContaining({
              fields: expect.objectContaining({
                searchField: { kind: "string", value: "body" },
                filterFields: expect.objectContaining({
                  values: [{ kind: "string", value: "group" }],
                }),
              }),
            }),
          }),
          expect.objectContaining({
            method: "vectorIndex",
            config: expect.objectContaining({
              fields: expect.objectContaining({
                dimensions: { kind: "number", value: 3 },
              }),
            }),
          }),
        ]),
      );
      expect(Object.keys(inventory.routes)).toEqual([
        "GET:/prefix/",
        "POST:/direct",
        "POST:/factory",
      ]);
      expect(
        inventory.functions["api:publicQ"].args.fields.paginationOpts,
      ).toMatchObject({
        type: "object",
        source: "convex/server:paginationOptsValidator",
        fields: {
          numItems: { type: "number" },
          cursor: { type: "union" },
        },
      });
      expect(inventory.functions["api:publicA"].returns).toBeNull();
      expect(inventory.functions["api:internalA"].kind).toBe("internalAction");
      expect(inventory.functions["defaultApi:default"].kind).toBe("action");
      expect(JSON.stringify(inventory)).not.toContain('"type":"reference"');
      const literalValues = inventory.functions[
        "api:internalQ"
      ].args.fields.value.values.map((entry) => entry.value);
      expect(literalValues).toEqual(
        expect.arrayContaining([
          { kind: "number", value: 1 },
          { kind: "string", value: "1" },
          { kind: "bigint", value: "-1" },
        ]),
      );

      writeFileSync(
        "convex/schema.ts",
        `import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({
  items: defineTable({
    mode: v.union(v.literal(1), v.literal("1")),
    body: v.string(),
    group: v.string(),
    embedding: v.array(v.float64()),
  })
    .index("by_mode", ["group"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["mode"] })
    .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 4, filterFields: ["mode"] }),
});
`,
      );
      writeFileSync(
        "convex/api.ts",
        `import { v } from "convex/values";
import { query, mutation, action, internalQuery, internalMutation } from "./_generated/server";
const result = v.object({ ok: v.literal(1) });
export const publicQ = query({ args: { value: v.union(v.literal(1), v.literal("1")) }, returns: v.object({ ok: v.string() }), handler: async () => ({ ok: "1" }) });
export const publicM = mutation({ args: {}, returns: v.null(), handler: async () => null });
export const publicA = action({ args: {}, handler: async () => null });
export const internalQ = internalQuery({ args: { value: v.literal("1") }, returns: result, handler: async () => ({ ok: 1 }) });
export const internalM = internalMutation({ args: {}, returns: v.null(), handler: async () => null });
`,
      );
      writeFileSync(
        "convex/http.ts",
        `import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
const http = httpRouter();
http.route({ path: "/direct", method: "POST", handler: httpAction(async () => new Response()) });
http.routePrefix({ pathPrefix: "/prefix/", method: "GET", handler: httpAction(async () => new Response()) });
export default http;
`,
      );
      execFileSync("git", ["add", "."]);
      execFileSync("git", ["commit", "-qm", "no protected subject anywhere"]);
      const target = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const classification = classifyConvexContract(base, target);
      expect(classification).toMatchObject({
        baseSha: base,
        candidateSha: target,
        hasChange: true,
        hasContraction: true,
        reasons: expect.arrayContaining([
          "function args narrowed: api:internalQ",
          "function removed: api:internalA",
          "function return validator changed: api:publicQ",
          "HTTP route removed: POST:/factory",
          "index definition changed: items.by_mode",
          "index definition changed: items.search_body",
          "index definition changed: items.by_embedding",
        ]),
      });
      expect(classification.baseDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(classification.candidateDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(classification.baseDigest).not.toBe(
        classification.candidateDigest,
      );

      writeFileSync(
        "convex/api.ts",
        `import { v } from "convex/values";
import { query } from "./_generated/server";
const hidden = { args: { value: v.string() }, returns: v.null() };
export const bypass = query({ ...hidden, handler: async () => null });
`,
      );
      execFileSync("git", ["add", "."]);
      execFileSync("git", ["commit", "-qm", "try validator spread bypass"]);
      const bypass = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      expect(() => convexContractAt(bypass)).toThrow(/unsupported member/);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("fails closed on mutable graphs while inventorying aliases, reexports, JavaScript, handlers, and generated registrars", () => {
    const originalCwd = process.cwd();
    const repo = mkdtempSync(join(tmpdir(), "zevium-convex-hostile-"));
    const commit = (subject: string) => {
      execFileSync("git", ["add", "."]);
      execFileSync("git", ["commit", "-qm", subject]);
      return execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
    };
    const schema = `import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({ items: defineTable({ value: v.optional(v.string()) }).index("by_value", ["value"]) });
`;
    const validHttp = `import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server.js";
const router = httpRouter();
const app = router;
const boundHandler = httpAction(async () => new Response("first"));
app.route({ path: "/hook", method: "POST", handler: boundHandler });
export default app;
`;
    try {
      process.chdir(repo);
      execFileSync("git", ["init", "-q"]);
      execFileSync("git", ["config", "user.email", "test@example.com"]);
      execFileSync("git", ["config", "user.name", "Release Test"]);
      mkdirSync("convex/_generated", { recursive: true });
      writeFileSync(
        "convex/_generated/server.js",
        "export const query = () => {}; export const httpAction = (value) => value;\n",
      );
      writeFileSync("convex/schema.js", schema);
      writeFileSync(
        "convex/impl.js",
        `import { query } from "./_generated/server.js";
import { v } from "convex/values";
const impl = query({ args: { value: v.optional(v.string()) }, handler: async () => null });
export { impl as removedAlias, impl as survivingAlias };
`,
      );
      writeFileSync(
        "convex/barrel.js",
        'export { removedAlias as publicAlias } from "./impl.js";\n',
      );
      writeFileSync("convex/http.js", validHttp);
      const base = commit("feat: hostile baseline");
      const baseInventory = convexContractAt(base);
      expect(Object.keys(baseInventory.functions)).toEqual(
        expect.arrayContaining([
          "impl:removedAlias",
          "impl:survivingAlias",
          "barrel:publicAlias",
        ]),
      );
      expect(baseInventory.routes["POST:/hook"]?.handlerDigest).toMatch(
        /^[0-9a-f]{64}$/,
      );

      writeFileSync(
        "convex/impl.js",
        `import { query } from "./_generated/server.js";
import { v } from "convex/values";
const impl = query({ args: { value: v.optional(v.string()) }, handler: async () => null });
export { impl as survivingAlias };
`,
      );
      writeFileSync(
        "convex/barrel.js",
        'export { survivingAlias as publicAlias } from "./impl.js";\n',
      );
      const aliasRemoval = commit("chore: arbitrary alias removal subject");
      expect(classifyConvexContract(base, aliasRemoval)).toMatchObject({
        hasContraction: true,
        reasons: expect.arrayContaining([
          "function removed: impl:removedAlias",
        ]),
      });

      writeFileSync(
        "convex/http.js",
        validHttp.replace('new Response("first")', 'new Response("second")'),
      );
      const handlerSwap = commit("feat: swap bound handler");
      expect(classifyConvexContract(aliasRemoval, handlerSwap)).toMatchObject({
        hasContraction: true,
        reasons: expect.arrayContaining(["HTTP route changed: POST:/hook"]),
      });

      writeFileSync(
        "convex/mutable.ts",
        `import { query } from "./_generated/server.js";
import { v } from "convex/values";
const args = { value: v.optional(v.string()) };
Object.assign(args, { required: v.string() });
export const bypass = query({ args, handler: async () => null });
`,
      );
      const objectMutation = commit("feat: mutable args bypass");
      expect(() => convexContractAt(objectMutation)).toThrow(
        /runtime object mutation/,
      );

      writeFileSync(
        "convex/mutable.ts",
        `import { query } from "./_generated/server.js";
export const safe = query({ args: {}, handler: async () => null });
`,
      );
      writeFileSync(
        "convex/schema.js",
        `import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
const fields = ["value"];
fields.reverse();
export default defineSchema({ items: defineTable({ value: v.optional(v.string()) }).index("by_value", fields) });
`,
      );
      const indexMutation = commit("feat: mutable index bypass");
      expect(() => convexContractAt(indexMutation)).toThrow(
        /top-level constant is mutated/,
      );

      writeFileSync("convex/schema.js", schema);
      writeFileSync(
        "convex/mutable.ts",
        `import * as server from "./_generated/server.js";
import { v } from "convex/values";
export const bypass = server["query"]({ args: { value: v.string() }, handler: async () => null });
`,
      );
      const computedRegistrar = commit("feat: computed registrar bypass");
      expect(() => convexContractAt(computedRegistrar)).toThrow(
        /computed Convex function registration/,
      );

      writeFileSync(
        "convex/mutable.ts",
        `import { query } from "./_generated/server.js";
export const safe = query({ args: {}, handler: async () => null });
`,
      );
      writeFileSync(
        "convex/http.js",
        validHttp.replace("app.route(", 'app["route"]('),
      );
      const computedHttp = commit("feat: computed HTTP bypass");
      expect(() => convexContractAt(computedHttp)).toThrow(
        /side effect|Computed Convex HTTP router registration/,
      );

      writeFileSync("convex/http.js", validHttp);
      const clean = commit("fix: restore static graph");
      writeFileSync(
        "convex/_generated/server.js",
        "export const query = () => {}; export const httpAction = (value) => value; // tampered\n",
      );
      const generatedTamper = commit("feat: tamper generated registrar");
      expect(classifyConvexContract(clean, generatedTamper)).toMatchObject({
        hasContraction: true,
        reasons: expect.arrayContaining(["generated server registrar changed"]),
      });

      mkdirSync("convex/nested/_generated", { recursive: true });
      writeFileSync(
        "convex/nested/_generated/server.js",
        "export const query = () => {};\n",
      );
      const nestedGenerated = commit("feat: nested generated bypass");
      expect(() => convexContractAt(nestedGenerated)).toThrow(
        /Nested Convex _generated directory/,
      );
    } finally {
      process.chdir(originalCwd);
    }
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
      mkdirSync("convex/_generated", { recursive: true });
      writeFileSync(
        "convex/_generated/server.ts",
        "export const query = {}; export const mutation = {}; export const action = {}; export const internalQuery = {}; export const internalMutation = {}; export const internalAction = {}; export const httpAction = {};\n",
      );
      writeFileSync("apps/gateway/wrangler.jsonc", JSON.stringify(legacyBase));
      writeFileSync(
        "convex/schema.ts",
        'import { defineSchema, defineTable } from "convex/server";\nimport { v } from "convex/values";\nexport default defineSchema({ items: defineTable({ value: v.optional(v.string()) }).index("by_value", ["value"]) });\n',
      );
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

      writeFileSync(
        "convex/schema.ts",
        'import { defineSchema, defineTable } from "convex/server";\nimport { v } from "convex/values";\nexport default defineSchema({ items: defineTable({ value: v.string() }) });\n',
      );
      execFileSync("git", ["add", "."]);
      execFileSync("git", [
        "commit",
        "-qm",
        "fix: remove legacy field without protected prefix",
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
      expect(classifyConvexContract(lifecycleSha, contractSha)).toMatchObject({
        hasContraction: true,
        reasons: expect.arrayContaining([
          "table validator narrowed: items",
          "index removed: items.by_value",
        ]),
      });

      writeFileSync(
        "convex/schema.ts",
        'import { defineSchema, defineTable } from "convex/server";\nimport { v } from "convex/values";\nexport default defineSchema({ items: defineTable({ value: v.literal("fixed") }) });\n',
      );
      execFileSync("git", ["add", "."]);
      execFileSync("git", [
        "commit",
        "-qm",
        "chore: second contraction with arbitrary subject",
      ]);
      const secondContractSha = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const stacked = findProtectedRequirements(base, secondContractSha);
      expect(stacked).toHaveLength(3);
      expect(stacked.at(-1)).toMatchObject({
        kind: "contract",
        targetSha: secondContractSha,
        activeBase: base,
        protectedBase: contractSha,
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("candidate-independent immutable release referee", () => {
  it("forces same-commit policy/workflow tamper through org-pinned evaluation", () => {
    const originalCwd = process.cwd();
    const previousEnvironment = {
      ref: process.env.RELEASE_REFEREE_REF,
      evaluator: process.env.RELEASE_REFEREE_SHA256,
      tree: process.env.RELEASE_POLICY_TREE_SHA256,
    };
    const repo = mkdtempSync(join(tmpdir(), "zevium-policy-hostile-"));
    const commit = (subject: string) => {
      execFileSync("git", ["add", "."]);
      execFileSync("git", ["commit", "-qm", subject]);
      return execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
    };
    try {
      process.chdir(repo);
      execFileSync("git", ["init", "-q"]);
      execFileSync("git", ["config", "user.email", "test@example.com"]);
      execFileSync("git", ["config", "user.name", "Release Test"]);
      mkdirSync(".github/scripts", { recursive: true });
      mkdirSync(".github/workflows", { recursive: true });
      mkdirSync("convex/_generated", { recursive: true });
      writeFileSync(
        ".github/scripts/release-attestation.mjs",
        "export const immutableEvaluator = true;\n",
      );
      writeFileSync(
        ".github/release-policy.json",
        `${JSON.stringify({ schemaVersion: 1 })}\n`,
      );
      writeFileSync(
        ".github/workflows/deploy-production.yml",
        "name: trusted deploy\n",
      );
      writeFileSync(
        "convex/_generated/server.js",
        "export const query = () => {};\n",
      );
      writeFileSync(
        "convex/schema.ts",
        `import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({ items: defineTable({ value: v.optional(v.string()) }) });
`,
      );
      const base = commit("feat: immutable referee base");
      const evaluatorSource = execFileSync(
        "git",
        ["show", `${base}:.github/scripts/release-attestation.mjs`],
        { encoding: "utf8" },
      ).trim();
      process.env.RELEASE_REFEREE_REF = base;
      process.env.RELEASE_REFEREE_SHA256 = createHash("sha256")
        .update(evaluatorSource)
        .digest("hex");
      process.env.RELEASE_POLICY_TREE_SHA256 = policyTreeDigest(base);

      writeFileSync(
        ".github/scripts/release-attestation.mjs",
        "export const candidateSaysNoAttestationNeeded = true;\n",
      );
      writeFileSync(
        ".github/workflows/deploy-production.yml",
        "name: candidate-owned bypass\n",
      );
      const tamper = commit("feat: weaken referee and workflow together");
      const requirements = findProtectedRequirements(base, tamper);
      expect(requirements).toEqual([
        expect.objectContaining({
          kind: "policy",
          targetSha: tamper,
          activeBase: base,
          protectedBase: base,
          evaluatorRef: base,
          evaluatorDigest: process.env.RELEASE_REFEREE_SHA256,
          policyTreeDigest: process.env.RELEASE_POLICY_TREE_SHA256,
        }),
      ]);
      const requirement = requirements[0]!;
      const attestation = createProtectedAttestation({
        ...requirement,
        runHeadSha: base,
        workflowPath: ".github/workflows/release-policy.yml",
        workflowId: 501,
        runId: 502,
        runAttempt: 1,
        environment: "production-policy",
      });
      const run = {
        id: 502,
        workflow_id: 501,
        path: ".github/workflows/release-policy.yml",
        head_sha: base,
        head_branch: "develop",
        event: "pull_request_target",
        status: "completed",
        conclusion: "success",
        run_attempt: 1,
      };
      expect(
        verifyProtectedAttestation({
          attestation,
          requirement,
          workflow: {
            id: 501,
            path: ".github/workflows/release-policy.yml",
          },
          run,
          deployments: [
            {
              id: 503,
              sha: base,
              environment: "production-policy",
              creator: { login: "github-actions[bot]" },
            },
          ],
          statusesByDeployment: {
            503: [
              {
                id: 504,
                state: "success",
                environment: "production-policy",
                log_url:
                  "https://github.com/zevium-dev/core/actions/runs/502/job/1",
              },
            ],
          },
          baseIsAncestorOfTarget: true,
          evaluatorIsAncestorOfBase: true,
          linearPolicyRange: true,
        }),
      ).toBe(true);
      expect(() =>
        verifyProtectedAttestation({
          attestation: { ...attestation, evaluatorRef: tamper },
          requirement,
          workflow: {
            id: 501,
            path: ".github/workflows/release-policy.yml",
          },
          run,
          deployments: [],
          statusesByDeployment: {},
          baseIsAncestorOfTarget: true,
          evaluatorIsAncestorOfBase: true,
          linearPolicyRange: true,
        }),
      ).toThrow();

      writeFileSync(
        ".github/workflows/recover-production.yml",
        "name: second stacked policy change\n",
      );
      const stacked = commit("feat: stacked workflow change");
      const stackedRequirements = findProtectedRequirements(base, stacked);
      expect(stackedRequirements).toHaveLength(2);
      expect(stackedRequirements.map((row) => row.targetSha)).toEqual([
        tamper,
        stacked,
      ]);
      expect(
        stackedRequirements.every((row) => row.evaluatorRef === base),
      ).toBe(true);

      execFileSync("git", ["checkout", "-qb", "side", tamper]);
      writeFileSync("side.txt", "side\n");
      const side = commit("feat: side");
      execFileSync("git", ["checkout", "-qb", "mainline", tamper]);
      writeFileSync("mainline.txt", "mainline\n");
      const mainline = commit("feat: mainline");
      expect(() => findProtectedRequirements(side, mainline)).toThrow(
        /not an ancestor/,
      );
      execFileSync("git", ["merge", "--no-ff", "side", "-qm", "merge"]);
      const merge = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      expect(() => findProtectedRequirements(tamper, merge)).toThrow(
        /linear single-parent/,
      );
    } finally {
      process.chdir(originalCwd);
      for (const [name, value] of [
        ["RELEASE_REFEREE_REF", previousEnvironment.ref],
        ["RELEASE_REFEREE_SHA256", previousEnvironment.evaluator],
        ["RELEASE_POLICY_TREE_SHA256", previousEnvironment.tree],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
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
  ".github/workflows/release-policy.yml",
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
      expect(source).not.toMatch(/(^|\s)npm\s+install\b/m);
      expect(source).not.toContain("PRODUCTION_RELEASE_PROBE_API_KEY");
      expect(source).not.toContain("STAGING_RELEASE_PROBE_API_KEY");
      expect(source).not.toContain("secrets.STAGING_E2E_API_KEY");
    }
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    expect(packageJson.devDependencies["agent-browser"]).toBe("0.27.1");
    const lockfile = readFileSync("pnpm-lock.yaml", "utf8");
    expect(lockfile).toContain("agent-browser@0.27.1:");
    expect(lockfile).toContain(
      "sha512-lLzpWDV7nlVsA5km7yMCH1wppvnLLNx160hLwLdDUkCst9x38UhhxoiTmmJ2qreOnCa/Hp4/Gm6Adkahhtb6Hg==",
    );
    for (const path of [
      ".github/workflows/deploy-production.yml",
      ".github/workflows/payment-drill.yml",
      ".github/workflows/preview.yml",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).toContain("verify-agent-browser.mjs");
      expect(source).toContain("AGENT_BROWSER_EXECUTABLE_PATH");
      expect(source).not.toContain("agent-browser install");
    }
    const runAll = readFileSync("e2e/run-all.sh", "utf8");
    const consumer = readFileSync("e2e/03-consumer.sh", "utf8");
    const helpers = readFileSync("e2e/lib.sh", "utf8");
    expect(runAll).toContain("unset E2E_API_KEY");
    expect(consumer).toContain("unset E2E_API_KEY");
    expect(consumer).not.toContain('"$E2E_API_KEY"');
    expect(helpers).toContain("env -u E2E_API_KEY");
    expect(helpers).toContain('E2E_API_KEY="$E2E_RELEASE_KEY"');
  });

  it("derives contract protection from exact semantic diff, never commit subject", () => {
    const source = readFileSync(
      ".github/workflows/contract-production.yml",
      "utf8",
    );
    expect(source).toMatch(/release-convex-contract\.mjs" classify/);
    expect(source).toContain("classification.hasContraction");
    expect(source).toContain("exact.length !== 1");
    expect(source).toContain('--base="$ACTIVE_RELEASE" --target="$target"');
    expect(source).toContain(
      '--exclude-kind=contract --exclude-target="$target"',
    );
    expect(source).toContain("ref: ${{ needs.resolve.outputs.deploy_sha }}");
    expect(source).toContain("pnpm --dir .release-contract-candidate install");
    expect(source).toContain(
      "cd .release-contract-candidate && pnpm exec convex deploy",
    );
    expect(source).not.toContain("git show -s --format=%s");
    expect(source).not.toContain("contract\\(convex\\):");
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
    expect(generic).toMatch(/release-attestation\.mjs" verify-remote/);
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

  it("forces immutable referee and semantic admission before every provider mutation", () => {
    for (const path of [
      ".github/workflows/deploy-production.yml",
      ".github/workflows/contract-production.yml",
      ".github/workflows/gateway-do-lifecycle.yml",
      ".github/workflows/recover-production.yml",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source, path).toContain("RELEASE_REFEREE_REF");
      expect(source, path).toContain("RELEASE_REFEREE_SHA256");
      expect(source, path).toContain("RELEASE_POLICY_TREE_SHA256");
      expect(source, path).toContain("verify-referee");
      expect(source, path).toContain('git archive "$RELEASE_REFEREE_REF"');
      expect(source, path).toContain(
        'pnpm --dir "$referee_root" install --frozen-lockfile --ignore-scripts',
      );
      for (const install of source.matchAll(
        /pnpm(?: --dir \S+)? install[^\n]*/g,
      )) {
        expect(install[0], `${path}: ${install[0]}`).toContain(
          "--ignore-scripts",
        );
      }
      expect(source, path).toMatch(/release-convex-contract\.mjs" classify/);
      expect(source, path).not.toContain("--exclude-kind=policy");
      const parsed = workflow(path);
      for (const [jobName, job] of Object.entries(parsed.jobs ?? {})) {
        const steps = job.steps ?? [];
        const firstMutation = steps.findIndex((step) =>
          /(?:convex deploy --yes\b|wrangler (?:deploy\b|versions upload\b|versions deploy\b))/.test(
            step.run ?? "",
          ),
        );
        if (firstMutation < 0) continue;
        const prefix = steps
          .slice(0, firstMutation)
          .map((step) => step.run ?? "")
          .join("\n");
        expect(prefix, `${path}:${jobName}`).toContain("verify-referee");
        expect(prefix, `${path}:${jobName}`).toMatch(
          /release-convex-contract\.mjs" classify/,
        );
        const mutationStep = steps[firstMutation]?.run ?? "";
        const localFirstMutation = mutationStep.search(
          /(?:convex deploy --yes\b|wrangler (?:deploy\b|versions upload\b|versions deploy\b))/,
        );
        const localPrefix = mutationStep.slice(0, localFirstMutation);
        if (path.endsWith("recover-production.yml")) {
          expect(localPrefix, `${path}:${jobName}`).toContain(
            "failed run drift",
          );
          expect(localPrefix, `${path}:${jobName}`).toMatch(
            /(?:verify-remote|check-dedicated|verify-lineage-version)/,
          );
        }
      }
    }
    const recovery = workflow(".github/workflows/recover-production.yml");
    const recoverySteps = recovery.jobs?.recover?.steps ?? [];
    const admission = recoverySteps.findIndex((step) =>
      step.run?.includes("admit-recovery"),
    );
    const firstMutation = recoverySteps.findIndex((step) =>
      /(?:convex deploy --yes\b|wrangler (?:deploy\b|versions upload\b|versions deploy\b))/.test(
        step.run ?? "",
      ),
    );
    expect(admission).toBeGreaterThan(-1);
    expect(firstMutation).toBeGreaterThan(admission);

    const policy = workflow(".github/workflows/release-policy.yml");
    expect(policy.on).toHaveProperty("pull_request_target");
    expect(policy.jobs?.evaluate?.environment).toBe("production-policy");
    const policySource = readFileSync(
      ".github/workflows/release-policy.yml",
      "utf8",
    );
    expect(policySource).toContain("ref: ${{ vars.RELEASE_REFEREE_REF }}");
    expect(policySource).toContain('--evaluator-ref="$RELEASE_REFEREE_REF"');
    expect(policySource).not.toContain('--evaluator-ref="$BASE_SHA"');
    expect(policySource).toContain(
      "policy change must be one isolated linear commit under immutable referee",
    );
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
    const recoverySource = readFileSync(
      ".github/workflows/recover-production.yml",
      "utf8",
    );
    expect(recoverySource).toContain(
      '".github/workflows/recover-production.yml"',
    );
    expect(recoverySource).toContain(
      "recovery-manifest-initial-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(recoverySource).toContain(
      "recovery-manifest-final-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(recoverySource).toContain(
      "lifecycle-recovery-initial-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(recoverySource).toContain(
      "lifecycle-recovery-final-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(recoverySource).toContain("verify-lineage-version");
    expect(recoverySource).toContain("get-bounded-lineage-version");
    expect(recoverySource).toContain(
      "production-recovery-${{ needs.resolve.outputs.run_id }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    const recoverySteps = recovery.jobs?.recover?.steps ?? [];
    const firstRecoveryMutation = recoverySteps.findIndex(
      (step) =>
        step.run &&
        /convex deploy --yes\b|wrangler (?:versions upload|deploy|versions deploy)\b/.test(
          step.run,
        ),
    );
    const initialRecoveryManifest = recoverySteps.findIndex((step) =>
      step.name?.includes("recursive recovery intent before mutation"),
    );
    expect(initialRecoveryManifest).toBeGreaterThan(-1);
    expect(firstRecoveryMutation).toBeGreaterThan(initialRecoveryManifest);
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
    expect(source).toMatch(/release-attestation\.mjs" verify-remote/);
  });
});
