import { describe, expect, it } from "vitest";
import { signAdmissionProof, verifyAdmissionProof } from "./admission-proof";

const claims = {
  reservationId: "request-1",
  consumerClerkOrgId: "consumer-1",
  projectId: "project-1",
  routeRevision: "immutable-spec-1",
  policyRevision: 1,
  mode: "open" as const,
  admittedAt: 10,
};
describe("admission proof", () => {
  it("survives delayed settlement and binds every admission fact", async () => {
    const proof = await signAdmissionProof("secret", claims);
    expect(await verifyAdmissionProof("secret", proof, claims)).toEqual(claims);
    for (const field of [
      "reservationId",
      "consumerClerkOrgId",
      "projectId",
      "routeRevision",
    ] as const) {
      expect(
        await verifyAdmissionProof("secret", proof, {
          ...claims,
          [field]: "changed",
        }),
      ).toBeNull();
    }
    for (const patch of [
      { policyRevision: 2 },
      { mode: "entitled_only" },
      { admittedAt: 11 },
    ]) {
      const changed = JSON.parse(proof);
      Object.assign(changed.claims, patch);
      expect(
        await verifyAdmissionProof("secret", JSON.stringify(changed), claims),
      ).toBeNull();
    }
    expect(
      await verifyAdmissionProof("different secret", proof, claims),
    ).toBeNull();
    expect(
      await verifyAdmissionProof("secret", "malformed", claims),
    ).toBeNull();
  });
});
