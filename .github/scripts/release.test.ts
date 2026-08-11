import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  probeRelease,
  resolveCurrentRelease,
  validateConvexDryRun,
  validateConvexTarget,
  validateProbeOptions,
  validateRelease,
} from "./release-contract.mjs";
import {
  activeVersion,
  run as runReleaseState,
  uploadedVersion,
} from "./release-state.mjs";

const SHA = "a".repeat(40);
const OLD_SHA = "b".repeat(40);
const WEB = "https://web.test";
const GATEWAY = "https://gateway.test";

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

function landing(release = SHA) {
  return response(
    `<html><head><title>Zevium</title><meta name="zevium-release" content="${release}"></head></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function health(release = SHA, status = 200) {
  return response(
    { ok: status === 200, service: "zevium-gateway", release, contract: 1 },
    { status, headers: { "content-type": "application/json" } },
  );
}

function fullOptions(overrides: Record<string, unknown> = {}) {
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
    apiKey: "secret-key",
    readinessAttempts: 1,
    readinessIntervalMs: 0,
    sleep: vi.fn(),
    ...overrides,
  };
}

function successfulFetch(meteredCost = "3") {
  return vi
    .fn()
    .mockResolvedValueOnce(landing())
    .mockResolvedValueOnce(health())
    .mockResolvedValueOnce(
      response(
        "<title>Catalogue · Zevium</title>Public APIs with per-call credits /catalogue/acme/demo",
        {
          status: 200,
          headers: { "content-type": "text/html" },
        },
      ),
    )
    .mockResolvedValueOnce(
      response(
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
      ),
    )
    .mockResolvedValueOnce(
      response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "GET, POST, OPTIONS",
        },
      }),
    )
    .mockResolvedValueOnce(
      response(
        { ok: true },
        {
          status: 200,
          headers: {
            "x-zevium-mock": "1",
            "x-zevium-cost": "0",
            "x-zevium-request-id": "mock-request",
          },
        },
      ),
    )
    .mockResolvedValueOnce(
      response(
        { ok: true },
        {
          status: 200,
          headers: {
            "x-zevium-cost": meteredCost,
            "x-zevium-request-id": "paid-request",
          },
        },
      ),
    );
}

function successfulGatewayFetch() {
  return vi
    .fn()
    .mockResolvedValueOnce(health())
    .mockResolvedValueOnce(
      response(
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
      ),
    )
    .mockResolvedValueOnce(
      response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "GET, POST, OPTIONS",
        },
      }),
    )
    .mockResolvedValueOnce(
      response(
        { ok: true },
        {
          status: 200,
          headers: {
            "x-zevium-mock": "1",
            "x-zevium-cost": "0",
            "x-zevium-request-id": "mock-request",
          },
        },
      ),
    )
    .mockResolvedValueOnce(
      response(
        { ok: true },
        {
          status: 200,
          headers: {
            "x-zevium-cost": "3",
            "x-zevium-request-id": "paid-request",
          },
        },
      ),
    );
}

describe("release identity", () => {
  it("only accepts immutable full git SHAs", () => {
    expect(validateRelease(SHA)).toBe(SHA);
    expect(() => validateRelease("develop")).toThrow(/40-character git SHA/);
    expect(() => validateRelease(SHA.toUpperCase())).toThrow(
      /40-character git SHA/,
    );
  });

  it("binds Convex deploy keys to reviewed deployment origin", () => {
    expect(
      validateConvexTarget(
        "https://staging.convex.cloud",
        "https://staging.convex.cloud",
      ),
    ).toBe("https://staging.convex.cloud");
    expect(() =>
      validateConvexTarget(
        "https://staging.convex.cloud",
        "https://production.convex.cloud",
      ),
    ).toThrow(/unexpected deployment/);

    const dryRun = `
▌ Deploying code to deployment:
▌ └─ https://staging.convex.cloud
- Deploying to https://staging.convex.cloud... [dry run]
✔ Would have deployed Convex functions
`;
    expect(validateConvexDryRun("https://staging.convex.cloud", dryRun)).toBe(
      "https://staging.convex.cloud",
    );
    expect(() =>
      validateConvexDryRun("https://production.convex.cloud", dryRun),
    ).toThrow(/unexpected deployment/);
    expect(() =>
      validateConvexDryRun(
        "https://staging.convex.cloud",
        "Would have run target validator [dry run]",
      ),
    ).toThrow(/did not identify target/);
  });

  it("proves SSR, exact release identities, discovery, CORS, mock, and paid metering", async () => {
    const fetchMock = successfulFetch();
    const evidence = await probeRelease(fullOptions(), fetchMock);

    expect(evidence.outcome).toBe("passed");
    expect(evidence.checks.map((check) => check.name)).toEqual([
      "web-release-readiness",
      "gateway-release-readiness",
      "web-catalogue-ssr",
      "control-data-contract",
      "gateway-cors-contract",
      "published-spec-mock",
      "metered-wallet-upstream",
    ]);
    expect(evidence.checks.at(-1)).toMatchObject({ cost: 3, status: 200 });
    expect(JSON.stringify(evidence)).not.toContain("secret-key");
    expect(JSON.stringify(evidence)).not.toContain("probe");

    const mockRequest = fetchMock.mock.calls[5];
    expect(mockRequest[0]).toBe(`${GATEWAY}/mock/acme/demo/echo`);
    expect(mockRequest[1]).toMatchObject({
      method: "POST",
      body: '{"probe":true}',
    });
    expect(new Headers(mockRequest[1]?.headers).get("content-type")).toBe(
      "application/json",
    );
    const paidHeaders = new Headers(fetchMock.mock.calls[6][1]?.headers);
    expect(paidHeaders.get("authorization")).toBe("Bearer secret-key");
  });

  it("resolves matching active identities and the one-time legacy bootstrap", async () => {
    const exactFetch = vi
      .fn()
      .mockResolvedValueOnce(landing())
      .mockResolvedValueOnce(health());
    await expect(
      resolveCurrentRelease(
        {
          web: WEB,
          gateway: GATEWAY,
          readinessAttempts: 1,
          readinessIntervalMs: 0,
        },
        exactFetch,
      ),
    ).resolves.toBe(SHA);

    const legacyFetch = vi
      .fn()
      .mockResolvedValueOnce(
        response("<title>Zevium</title>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(
        response(
          { ok: true, service: "zevium-gateway" },
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
        legacyFetch,
      ),
    ).resolves.toBe("legacy");
  });

  it("rejects split web and gateway release identities", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(landing())
      .mockResolvedValueOnce(health(OLD_SHA));
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
    ).rejects.toThrow(/release identities disagree/);
  });

  it("validates paths and JSON bodies before provider mutation", () => {
    expect(() =>
      validateProbeOptions(fullOptions({ mockPath: "/mock/acme//echo" })),
    ).toThrow(/absolute \/mock/);
    expect(() =>
      validateProbeOptions(fullOptions({ requestBody: "not-json" })),
    ).toThrow(/valid JSON/);
    expect(
      validateProbeOptions(
        fullOptions({
          contentType: "text/plain; charset=utf-8",
          requestBody: "# Real production probe",
        }),
      ).requestContentType,
    ).toBe("text/plain; charset=utf-8");
    expect(() =>
      validateProbeOptions(
        fullOptions({ contentType: "text/plain\r\nx-evil: injected" }),
      ),
    ).toThrow(/valid media type/);
    expect(() =>
      validateProbeOptions(
        fullOptions({
          gatewayOnly: true,
          web: undefined,
          gatewayOverrideName: "zevium-gateway",
        }),
      ),
    ).toThrow(/name and version must be provided together/);
  });

  it("deep-probes exact zero-traffic gateway candidate through version override", async () => {
    const fetchMock = successfulGatewayFetch();
    const evidence = await probeRelease(
      fullOptions({
        gatewayOnly: true,
        web: undefined,
        gatewayOverrideName: "zevium-gateway",
        gatewayOverrideVersion: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
      fetchMock,
    );

    expect(evidence.checks.map((check) => check.name)).toEqual([
      "gateway-release-readiness",
      "control-data-contract",
      "gateway-cors-contract",
      "published-spec-mock",
      "metered-wallet-upstream",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("Cloudflare-Workers-Version-Overrides")).toBe(
        'zevium-gateway="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"',
      );
    }
  });

  it("fails closed before any request when deep-probe config is absent", async () => {
    const fetchMock = vi.fn();
    await expect(
      probeRelease(
        {
          release: SHA,
          web: WEB,
          gateway: GATEWAY,
          readinessAttempts: 1,
          readinessIntervalMs: 0,
        },
        fetchMock,
      ),
    ).rejects.toThrow(/mockPath must be an absolute/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits through stale Worker propagation using exact release identity", async () => {
    const sleep = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(landing(OLD_SHA))
      .mockResolvedValueOnce(response("not found", { status: 404 }))
      .mockResolvedValueOnce(landing())
      .mockResolvedValueOnce(health(OLD_SHA))
      .mockResolvedValueOnce(health());

    const evidence = await probeRelease(
      {
        release: SHA,
        web: WEB,
        gateway: GATEWAY,
        identityOnly: true,
        readinessAttempts: 3,
        readinessIntervalMs: 1,
        sleep,
      },
      fetchMock,
    );

    expect(evidence.outcome).toBe("passed");
    expect(evidence.checks).toEqual([
      expect.objectContaining({ name: "web-release-readiness", attempts: 3 }),
      expect.objectContaining({
        name: "gateway-release-readiness",
        attempts: 2,
      }),
    ]);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("rejects a zero-cost fake metered success and retains sanitized failure evidence", async () => {
    const fetchMock = successfulFetch("0");

    let caught: (Error & { evidence?: unknown }) | undefined;
    try {
      await probeRelease(fullOptions(), fetchMock);
    } catch (error) {
      caught = error as Error & { evidence?: unknown };
    }
    expect(caught?.message).toMatch(/positive integer/);
    expect(caught?.evidence).toMatchObject({
      outcome: "failed",
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: "metered-wallet-upstream",
          outcome: "failed",
        }),
      ]),
    });
    expect(JSON.stringify(caught?.evidence)).not.toContain("secret-key");
  });

  it("rejects charged cost that disagrees with published discovery", async () => {
    await expect(
      probeRelease(fullOptions(), successfulFetch("2")),
    ).rejects.toThrow(/differs from published discovery price/);
  });
});

describe("production workflow invariants", () => {
  const workflow = readFileSync(
    ".github/workflows/deploy-production.yml",
    "utf8",
  );
  const previewWorkflow = readFileSync(".github/workflows/preview.yml", "utf8");
  const contractWorkflow = readFileSync(
    ".github/workflows/contract-production.yml",
    "utf8",
  );

  it("serializes releases and separates staging from production approval", () => {
    expect(workflow).toContain("group: production-release");
    expect(workflow).toContain("environment: staging");
    expect(workflow).toContain("environment: production");
    expect(workflow.indexOf("environment: staging")).toBeLessThan(
      workflow.indexOf("environment: production"),
    );
  });

  it("fails closed, verifies zero-traffic candidates, and verifies rollback", () => {
    expect(workflow).toContain(
      "Reject incomplete staging release configuration",
    );
    expect(workflow).toContain(
      "Reject incomplete production release configuration",
    );
    expect(workflow).toContain("versions upload --strict");
    expect(workflow).toContain("--validate-convex-dry-run=true");
    expect(workflow).toContain("convex deploy --dry-run");
    expect(workflow).toContain("$gateway_previous@100%");
    expect(workflow).toContain("$gateway_candidate@0%");
    expect(workflow).toContain("Cloudflare-Workers-Version-Overrides");
    expect(workflow).toContain("--gateway-only=true");
    expect(workflow).toContain("gateway-candidate-contract.json");
    expect(workflow).toContain("verify_web_override");
    expect(workflow).toContain("$PRODUCTION_WEB_URL/catalogue?q=&sort=newest");
    expect(workflow).toContain("release-state.mjs recover");
    expect(workflow).toContain("metered-method");
    expect(workflow).not.toMatch(/smoke/i);
  });

  it("bounds preview propagation and checks response contracts", () => {
    expect(previewWorkflow).toContain("for attempt in $(seq 1 30)");
    expect(previewWorkflow).toContain("<title>Catalogue · Zevium</title>");
    expect(previewWorkflow).toContain("health.contract !== 1");
    expect(previewWorkflow).toContain("access-control-allow-origin");
  });

  it("isolates one contract-only commit behind two approval phases", () => {
    expect(contractWorkflow).toContain("environment: staging");
    expect(contractWorkflow).toContain("environment: production-contract");
    expect(contractWorkflow).toContain("git rev-list --count");
    expect(contractWorkflow).toContain("awk '$0 !~ /^convex\\// { print }'");
    expect(contractWorkflow).toContain("e2e/run-all.sh");
    expect(contractWorkflow).toContain("recovery_of");
    expect(contractWorkflow).toContain("fix\\(convex\\):*");
    expect(contractWorkflow).toContain("pre-recovery-identity.json");
    expect(contractWorkflow).toContain("zevium/convex-contract");
    expect(contractWorkflow).toContain("state=success");
    expect(workflow).toContain("contract\\(convex\\):*");
    expect(workflow).toContain(
      "contract commits have no successful production marker",
    );
    expect(workflow).toContain("production-baseline.json");
  });

  it("rejects untrusted manual preview targets before checkout", () => {
    expect(previewWorkflow).toContain(
      "Validate trusted preview target with gh CLI",
    );
    expect(previewWorkflow).toContain(
      "pr.head.repo.full_name !== process.env.GITHUB_REPOSITORY",
    );
    expect(previewWorkflow).toContain('pr.user.login !== "tnfssc"');
    expect(
      previewWorkflow.indexOf("Validate trusted preview target with gh CLI"),
    ).toBeLessThan(previewWorkflow.indexOf("actions/checkout@v6"));
  });
});

describe("Cloudflare rollback evidence", () => {
  function deployment(version: string) {
    return JSON.stringify([
      { versions: [{ version_id: version, percentage: 100 }] },
    ]);
  }

  it("accepts only one 100% active version", () => {
    const directory = mkdtempSync(join(tmpdir(), "zevium-release-"));
    const activePath = join(directory, "active.json");
    const splitPath = join(directory, "split.json");
    writeFileSync(activePath, deployment("active"));
    writeFileSync(
      splitPath,
      JSON.stringify([
        {
          versions: [
            { version_id: "old", percentage: 90 },
            { version_id: "candidate", percentage: 10 },
          ],
        },
      ]),
    );
    expect(activeVersion(activePath)).toBe("active");
    expect(() => activeVersion(splitPath)).toThrow(/single-version release/);
  });

  it("selects newest deployment from Wrangler's oldest-first history", () => {
    const directory = mkdtempSync(join(tmpdir(), "zevium-history-"));
    const path = join(directory, "history.json");
    writeFileSync(
      path,
      JSON.stringify([
        { versions: [{ version_id: "historical", percentage: 100 }] },
        { versions: [{ version_id: "current", percentage: 100 }] },
      ]),
    );
    expect(activeVersion(path)).toBe("current");
  });

  it("extracts exact immutable version id from Wrangler output", () => {
    const directory = mkdtempSync(join(tmpdir(), "zevium-upload-"));
    const path = join(directory, "upload.ndjson");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "wrangler-session", version: 1 }),
        JSON.stringify({ type: "version-upload", version_id: "candidate" }),
      ].join("\n"),
    );
    expect(uploadedVersion(path)).toBe("candidate");
  });

  it("deletes raw provider responses even when capture fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "zevium-capture-"));
    const gateway = join(directory, "gateway-before.json");
    const web = join(directory, "web-before.json");
    writeFileSync(gateway, deployment("gateway-old"));
    writeFileSync(web, "not-json");
    expect(() => runReleaseState(["capture", directory])).toThrow();
    expect(existsSync(gateway)).toBe(false);
    expect(existsSync(web)).toBe(false);
  });

  it("enforces ordered state transitions and records verified rollback", () => {
    const directory = mkdtempSync(join(tmpdir(), "zevium-state-"));
    writeFileSync(
      join(directory, "gateway-before.json"),
      deployment("gateway-old"),
    );
    writeFileSync(join(directory, "web-before.json"), deployment("web-old"));

    runReleaseState(["capture", directory]);
    expect(() =>
      runReleaseState(["mark", directory, "gateway_active"]),
    ).toThrow(/Invalid release transition/);
    writeFileSync(
      join(directory, "gateway-upload.ndjson"),
      `${JSON.stringify({ type: "version-upload", version_id: "gateway-new" })}\n`,
    );
    writeFileSync(
      join(directory, "web-upload.ndjson"),
      `${JSON.stringify({ type: "version-upload", version_id: "web-new" })}\n`,
    );
    runReleaseState(["uploaded", directory]);
    runReleaseState(["mark", directory, "convex_mutation_started"]);
    runReleaseState(["mark", directory, "convex_expanded"]);
    writeFileSync(
      join(directory, "gateway-after-rollback.json"),
      deployment("gateway-old"),
    );
    writeFileSync(
      join(directory, "web-after-rollback.json"),
      deployment("web-old"),
    );
    runReleaseState([
      "recover",
      directory,
      "success",
      "success",
      "true",
      "true",
    ]);
    process.env.RELEASE_JOB_STATUS = "failure";
    runReleaseState(["final", directory, SHA, WEB, GATEWAY]);
    delete process.env.RELEASE_JOB_STATUS;

    const state = JSON.parse(
      readFileSync(join(directory, "state.json"), "utf8"),
    );
    expect(state).toMatchObject({
      state: "workers_rolled_back_control_plane_expansion_retained",
      lastVerifiedState: "convex_expanded",
      recovery: {
        gatewayRestored: true,
        webRestored: true,
        verified: true,
      },
    });
    expect(existsSync(join(directory, "gateway-after-rollback.json"))).toBe(
      false,
    );
  });

  it("marks pre-mutation failure without false recovery alarm", () => {
    const directory = mkdtempSync(join(tmpdir(), "zevium-abort-"));
    process.env.RELEASE_JOB_STATUS = "failure";
    runReleaseState(["final", directory, SHA, WEB, GATEWAY]);
    delete process.env.RELEASE_JOB_STATUS;
    const state = JSON.parse(
      readFileSync(join(directory, "state.json"), "utf8"),
    );
    expect(state.state).toBe("aborted_without_traffic_change");
  });

  it("does not claim no mutation when Convex deploy outcome is ambiguous", () => {
    const directory = mkdtempSync(join(tmpdir(), "zevium-ambiguous-"));
    writeFileSync(
      join(directory, "gateway-before.json"),
      deployment("gateway-old"),
    );
    writeFileSync(join(directory, "web-before.json"), deployment("web-old"));
    runReleaseState(["capture", directory]);
    writeFileSync(
      join(directory, "gateway-upload.ndjson"),
      `${JSON.stringify({ type: "version-upload", version_id: "gateway-new" })}\n`,
    );
    writeFileSync(
      join(directory, "web-upload.ndjson"),
      `${JSON.stringify({ type: "version-upload", version_id: "web-new" })}\n`,
    );
    runReleaseState(["uploaded", directory]);
    runReleaseState(["mark", directory, "convex_mutation_started"]);
    writeFileSync(
      join(directory, "gateway-after-rollback.json"),
      deployment("gateway-old"),
    );
    writeFileSync(
      join(directory, "web-after-rollback.json"),
      deployment("web-old"),
    );
    runReleaseState([
      "recover",
      directory,
      "success",
      "success",
      "true",
      "true",
    ]);
    process.env.RELEASE_JOB_STATUS = "failure";
    runReleaseState(["final", directory, SHA, WEB, GATEWAY]);
    delete process.env.RELEASE_JOB_STATUS;

    const state = JSON.parse(
      readFileSync(join(directory, "state.json"), "utf8"),
    );
    expect(state.state).toBe(
      "workers_rolled_back_control_plane_change_possible",
    );
  });
});
