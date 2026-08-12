import { describe, expect, it } from "vitest";
import { buildManifest } from "../../src/manifest";
import { validateIdentityClaims, verifyProvenance } from "../../src/provenance";
import {
  HEAD_SHA,
  MERGE_SHA,
  PREVIEW_SECRET_DIGESTS,
  PRODUCTION_SHA,
  previewClaims,
  productionClaims,
  pullRequestFixture,
} from "../fixtures";

const AUDIENCE = `urn:zevium:cloudflare-deploy:v1:${"d".repeat(64)}`;

function previewManifest() {
  return buildManifest({
    convexSiteUrl: "https://preview-123.convex.site",
    convexUrl: "https://preview-123.convex.cloud",
    eventName: "pull_request",
    headSha: HEAD_SHA,
    oidcSha: MERGE_SHA,
    prNumber: 123,
    profile: "preview-gateway",
    ref: "refs/pull/123/merge",
    runAttempt: 1,
    runId: "9001",
    secretDigests: PREVIEW_SECRET_DIGESTS,
  });
}

describe("GitHub immutable provenance", () => {
  it("accepts internal PR with exact caller and reusable workflow", async () => {
    await expect(
      verifyProvenance(previewManifest(), previewClaims(AUDIENCE), {
        fetcher: async () => Response.json(pullRequestFixture()),
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["repository id", { repository_id: "1" }],
    ["owner id", { repository_owner_id: "1" }],
    ["actor", { actor_id: "1" }],
    ["environment", { environment: "production" }],
    [
      "caller",
      {
        workflow_ref:
          "zevium-dev/core/.github/workflows/evil.yml@refs/pull/123/merge",
      },
    ],
    [
      "reusable",
      {
        job_workflow_ref:
          "zevium-dev/core/.github/workflows/evil.yml@refs/pull/123/merge",
      },
    ],
    ["revision", { job_workflow_sha: HEAD_SHA }],
    ["event", { event_name: "push" }],
  ])("rejects ambiguous %s claim", (_label, override) => {
    expect(() =>
      validateIdentityClaims(
        previewManifest(),
        previewClaims(AUDIENCE, override),
      ),
    ).toThrow();
  });

  it("rejects fork, head SHA drift, and redirects", async () => {
    const fork = pullRequestFixture();
    fork.head.repo = { full_name: "attacker/core", id: 1 };
    await expect(
      verifyProvenance(previewManifest(), previewClaims(AUDIENCE), {
        fetcher: async () => Response.json(fork),
      }),
    ).rejects.toMatchObject({ code: "fork_rejected" });

    const drift = pullRequestFixture();
    drift.head.sha = "f".repeat(40);
    await expect(
      verifyProvenance(previewManifest(), previewClaims(AUDIENCE), {
        fetcher: async () => Response.json(drift),
      }),
    ).rejects.toMatchObject({ code: "fork_rejected" });

    await expect(
      verifyProvenance(previewManifest(), previewClaims(AUDIENCE), {
        fetcher: async () =>
          new Response(null, {
            headers: { location: "https://evil.invalid" },
            status: 302,
          }),
      }),
    ).rejects.toMatchObject({ code: "github_redirect_rejected" });
  });

  it("rejects manual dispatch carrying ambiguous PR branch claims", async () => {
    const manifest = buildManifest({
      convexSiteUrl: "https://preview-123.convex.site",
      convexUrl: "https://preview-123.convex.cloud",
      eventName: "workflow_dispatch",
      headSha: HEAD_SHA,
      oidcSha: PRODUCTION_SHA,
      prNumber: 123,
      profile: "preview-gateway",
      ref: "refs/heads/develop",
      runAttempt: 1,
      runId: "9001",
      secretDigests: PREVIEW_SECRET_DIGESTS,
    });
    const claims = previewClaims(AUDIENCE, {
      event_name: "workflow_dispatch",
      job_workflow_ref:
        "zevium-dev/core/.github/workflows/cloudflare-preview.yml@refs/heads/develop",
      job_workflow_sha: PRODUCTION_SHA,
      ref: "refs/heads/develop",
      sha: PRODUCTION_SHA,
      workflow_ref:
        "zevium-dev/core/.github/workflows/preview.yml@refs/heads/develop",
      workflow_sha: PRODUCTION_SHA,
    });
    await expect(
      verifyProvenance(manifest, claims, {
        fetcher: async () => Response.json(pullRequestFixture()),
      }),
    ).rejects.toMatchObject({ code: "dispatch_ref_rejected" });
  });

  it("binds production to successful develop CI source run", async () => {
    const manifest = buildManifest({
      eventName: "workflow_run",
      headSha: HEAD_SHA,
      oidcSha: PRODUCTION_SHA,
      profile: "production-web",
      ref: "refs/heads/develop",
      runAttempt: 1,
      runId: "9002",
      sourceRunId: "8999",
    });
    const source = {
      conclusion: "success",
      event: "push",
      head_branch: "develop",
      head_repository: { id: 1044451612 },
      head_sha: HEAD_SHA,
      id: 8999,
      name: "Continuous Integration",
      path: ".github/workflows/ci.yml",
      repository: { id: 1044451612 },
      status: "completed",
    };
    await expect(
      verifyProvenance(manifest, productionClaims(AUDIENCE), {
        fetcher: async () => Response.json(source),
      }),
    ).resolves.toBeUndefined();
    await expect(
      verifyProvenance(manifest, productionClaims(AUDIENCE), {
        fetcher: async () =>
          Response.json({ ...source, conclusion: "failure" }),
      }),
    ).rejects.toMatchObject({ code: "source_run_rejected" });
  });
});
