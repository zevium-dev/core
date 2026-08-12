import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_RECEIPT_SCHEMA,
  parseDeploymentReceipt,
} from "../../src/receipt";

const receipt = {
  artifactDigests: {
    modules: [{ name: "index.js", sha256: "a".repeat(64) }],
    staticAssets: [{ path: "/index.html", sha256: "b".repeat(64) }],
  },
  createdAt: "2026-08-12T09:00:00.000Z",
  deploymentId: "11111111-1111-4111-8111-111111111111",
  gitSha: "c".repeat(40),
  manifestDigest: "d".repeat(64),
  phase: "activated",
  priorDeploymentId: "22222222-2222-4222-8222-222222222222",
  priorVersionId: "33333333-3333-4333-8333-333333333333",
  profile: "staging-web",
  recovery: null,
  schema: DEPLOYMENT_RECEIPT_SCHEMA,
  target: "zevium-web-staging",
  versionId: "44444444-4444-4444-8444-444444444444",
};

describe("deployment receipt boundary", () => {
  it("accepts exact provider-linked receipt shape", () => {
    expect(parseDeploymentReceipt(structuredClone(receipt))).toEqual(receipt);
  });

  it.each([
    ["unknown field", { ...receipt, attacker: true }],
    ["noncanonical timestamp", { ...receipt, createdAt: "2026-08-12" }],
    ["bad provider ID", { ...receipt, priorVersionId: "configured-version" }],
    [
      "duplicate artifact",
      {
        ...receipt,
        artifactDigests: {
          ...receipt.artifactDigests,
          modules: [
            ...receipt.artifactDigests.modules,
            ...receipt.artifactDigests.modules,
          ],
        },
      },
    ],
    ["unknown target", { ...receipt, target: "zevium-attacker-staging" }],
    [
      "cross-wired profile and target",
      { ...receipt, profile: "staging-gateway" },
    ],
    [
      "activated phase without activation selectors",
      { ...receipt, deploymentId: null, versionId: null },
    ],
    [
      "version-uploaded phase with deployment selector",
      { ...receipt, phase: "version_uploaded" },
    ],
    [
      "partial prior selector pair",
      { ...receipt, priorDeploymentId: null },
    ],
    [
      "recovery payload on ordinary activation",
      {
        ...receipt,
        recovery: {
          failedDeploymentId: "55555555-5555-4555-8555-555555555555",
          failedGitSha: "e".repeat(40),
          failedVersionId: "66666666-6666-4666-8666-666666666666",
          mode: "redeployed_prior",
          sourceReceiptDigest: "f".repeat(64),
        },
      },
    ],
  ])("rejects %s", (_label, value) => {
    expect(() => parseDeploymentReceipt(value)).toThrow();
  });

  it.each([
    ["preview-gateway", "zevium-gateway-pr-42"],
    ["preview-web", "zevium-web-pr-42"],
    ["staging-gateway", "zevium-gateway-staging"],
    ["staging-web", "zevium-web-staging"],
    ["production-gateway", "zevium-gateway"],
    ["production-web", "zevium-dev"],
  ])("accepts exact %s target tuple", (profile, target) => {
    expect(
      parseDeploymentReceipt({ ...receipt, profile, target }),
    ).toMatchObject({ profile, target });
  });

  it("accepts only coherent recovery phase transitions", () => {
    const recovery = {
      failedDeploymentId: "55555555-5555-4555-8555-555555555555",
      failedGitSha: "e".repeat(40),
      failedVersionId: "66666666-6666-4666-8666-666666666666",
      mode: null,
      sourceReceiptDigest: "f".repeat(64),
    };
    const prepared = {
      ...receipt,
      deploymentId: null,
      phase: "recovery_prepared",
      recovery,
      versionId: receipt.priorVersionId,
    };
    expect(parseDeploymentReceipt(prepared)).toMatchObject(prepared);
    expect(() =>
      parseDeploymentReceipt({
        ...prepared,
        versionId: "77777777-7777-4777-8777-777777777777",
      }),
    ).toThrow("phase state");
    expect(() =>
      parseDeploymentReceipt({
        ...prepared,
        phase: "recovered",
        recovery: { ...recovery, mode: null },
      }),
    ).toThrow("phase state");
    expect(
      parseDeploymentReceipt({
        ...prepared,
        deploymentId: "77777777-7777-4777-8777-777777777777",
        phase: "recovered",
        recovery: { ...recovery, mode: "redeployed_prior" },
      }),
    ).toMatchObject({ phase: "recovered" });
  });
});
