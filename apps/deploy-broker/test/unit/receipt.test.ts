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
  ])("rejects %s", (_label, value) => {
    expect(() => parseDeploymentReceipt(value)).toThrow();
  });
});
