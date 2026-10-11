import { describe, expect, it } from "vitest";
import {
  admittedRequest,
  admissionFingerprint,
  verifyAdmission,
  settlement,
  ingestUsage,
  fundingSlices,
  lotMove,
  lotCompatibility,
  compatibleLots,
  feeFacts,
  refundFacts,
  signupGrant,
  snapshot,
  drainAck,
  fingerprint,
  sign,
  verifySnapshot,
  validInternalSecret,
  readBoundedJson,
  canonical,
} from "../contracts";
import { admitted, NOW, SECRET, unsignedSnapshot } from "./fixtures";

const final = async () => ({
  ...admitted,
  admissionFingerprint: await admissionFingerprint(admitted, SECRET),
  credits: 100,
  status: 200,
  latencyMs: 25,
  at: NOW + 25,
  billingOutcome: "settled" as const,
  qualityOutcome: "success" as const,
  ambiguous: false,
});
describe("scalar v2 admission and replay", () => {
  it("binds original source, environment, price and reservation", async () => {
    const value = settlement.parse(await final());
    expect(await verifyAdmission(value, SECRET)).toBe(true);
    for (const patch of [
      { deploymentId: "other" },
      { heldCredits: 101 },
      { epoch: 3 },
      { ownerUserId: "other" },
      { fundingSlices: [{ ...value.fundingSlices[0], originLotId: "wrong" }] },
    ])
      expect(
        await verifyAdmission({ ...value, ...patch }, SECRET).catch(
          () => false,
        ),
      ).toBe(false);
    expect(await fingerprint(value)).toBe(await fingerprint({ ...value }));
    expect(await fingerprint({ ...value, status: 201 })).not.toBe(
      await fingerprint(value),
    );
  });
  it("rejects unsupported execution models and unsafe money", () => {
    for (const patch of [
      { protocolVersion: 1 },
      { pricingDecision: "token_usage" },
      { tokenUsage: { inputTokens: 1 } },
      { routingAttempt: 1 },
      { owner: { kind: "anonymous" } },
      { heldCredits: -1 },
      { heldCredits: 0.5 },
      { edgeSequence: 0 },
      { heldCredits: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(admittedRequest.safeParse({ ...admitted, ...patch }).success).toBe(
        false,
      );
    expect(admittedRequest.parse(admitted)).toEqual(admitted);
  });
  it("counts original sources inside merged containers at 32/33", () => {
    const slices = Array.from({ length: 32 }, (_, i) => ({
      ...admitted.fundingSlices[0],
      originLotId: `origin_${i}`,
      sourceRef: `source_${i}`,
      credits: 1,
    }));
    expect(
      admittedRequest.safeParse({
        ...admitted,
        heldCredits: 32,
        listedCostCredits: 32,
        fundingSlices: slices,
      }).success,
    ).toBe(true);
    expect(
      fundingSlices.safeParse([
        ...slices,
        { ...slices[0], originLotId: "origin_33" },
      ]).success,
    ).toBe(false);
    expect(fundingSlices.safeParse([slices[0], slices[0]]).success).toBe(false);
  });
  it("keeps refund/free finals explicit and rejects mixed or duplicate batches", async () => {
    const event = await final();
    expect(ingestUsage.parse({ events: [event] }).events).toHaveLength(1);
    expect(ingestUsage.safeParse({ events: [event, event] }).success).toBe(
      false,
    );
    expect(ingestUsage.safeParse({ events: [] }).success).toBe(false);
    expect(
      ingestUsage.safeParse({ events: Array(101).fill(event) }).success,
    ).toBe(false);
    expect(
      ingestUsage.safeParse({
        events: [
          event,
          {
            ...event,
            walletId: "other",
            reservationId: "r2",
            settleRefId: "settle:r2",
            edgeSequence: 2,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      settlement.safeParse({
        ...event,
        billingOutcome: "refunded",
        credits: 0,
        status: 502,
        qualityOutcome: "network_error",
      }).success,
    ).toBe(true);
    expect(
      settlement.safeParse({ ...event, billingOutcome: "refunded" }).success,
    ).toBe(false);
    expect(
      admittedRequest.safeParse({
        ...admitted,
        pricingDecision: "zero_price",
        listedCostCredits: 0,
        heldCredits: 0,
        fundingSlices: [],
      }).success,
    ).toBe(true);
    expect(
      admittedRequest.safeParse({ ...admitted, monthlyCapCredits: 99 }).success,
    ).toBe(false);
  });
});
describe("owner decisions", () => {
  it("requires zero-delta source-traceable moves and identical deadlines", () => {
    const move = {
      walletId: "w",
      refId: "m",
      kind: "lot_move",
      amount: 0,
      balanceAfter: 100,
      sequence: 2,
      fromLotId: "old",
      toLotId: "new",
      originLotId: "original",
      sourceRef: "payment:original",
      movedCredits: 99,
      reason: "dust_merge",
      mergeId: "merge",
    };
    expect(lotMove.safeParse(move).success).toBe(true);
    expect(lotMove.safeParse({ ...move, amount: 99 }).success).toBe(false);
    expect(lotMove.safeParse({ ...move, originLotId: undefined }).success).toBe(
      false,
    );
    const a = {
      walletId: "w",
      expiryClass: "never",
      sourceKind: "payment" as const,
      refundable: true,
      priority: 1,
    };
    expect(compatibleLots(a, { ...a })).toBe(true);
    const storedLot = { ...a, remainingCredits: 10, _id: "lot" };
    expect(compatibleLots(storedLot, storedLot)).toBe(true);
    for (const patch of [
      { expiresAt: NOW },
      { sourceKind: "promo" as const },
      { walletId: "other" },
      { refundable: false },
      { priority: 2 },
    ])
      expect(compatibleLots(a, { ...a, ...patch })).toBe(false);
    expect(
      compatibleLots(
        { ...a, expiryClass: `at:${NOW}`, expiresAt: NOW },
        { ...a, expiryClass: `at:${NOW}`, expiresAt: NOW + 1 },
      ),
    ).toBe(false);
  });
  it("enforces canonical expiry classes before indexed merge lookup", () => {
    const lot = {
      walletId: "w",
      expiryClass: "never",
      sourceKind: "payment",
      refundable: true,
      priority: 1,
    };
    expect(lotCompatibility.safeParse(lot).success).toBe(true);
    expect(
      lotCompatibility.safeParse({
        ...lot,
        expiryClass: `at:${NOW}`,
        expiresAt: NOW,
      }).success,
    ).toBe(true);
    expect(
      lotCompatibility.safeParse({ ...lot, expiryClass: "at:0", expiresAt: 0 })
        .success,
    ).toBe(true);
    for (const patch of [
      { expiresAt: NOW },
      { expiryClass: `at:${NOW}` },
      { expiryClass: `at:${NOW}`, expiresAt: NOW + 1 },
      { expiryClass: `at:0${NOW}`, expiresAt: NOW },
      { expiryClass: "annual", expiresAt: NOW },
      { expiryClass: "at:1.5", expiresAt: 1.5 },
      {
        expiryClass: "at:9007199254740992",
        expiresAt: Number.MAX_SAFE_INTEGER + 1,
      },
    ])
      expect(lotCompatibility.safeParse({ ...lot, ...patch }).success).toBe(
        false,
      );
  });
  it("binds signup ref to user and personal org and never mints credits for fees", () => {
    const grant = {
      clerkUserId: "u",
      personalOrganizationId: "o",
      personalForClerkUserId: "u",
      refId: "signup:u",
      credits: 10000,
    };
    expect(signupGrant.safeParse(grant).success).toBe(true);
    expect(
      signupGrant.safeParse({ ...grant, personalForClerkUserId: "other" })
        .success,
    ).toBe(false);
    const fee = {
      creditFaceValueCents: 1000,
      processingFeeChargedCents: 50,
      processingFeeActualCents: 60,
      processingFeeVarianceCents: 10,
      amountPaidCents: 1050,
      credits: 100000,
      feePolicyVersion: "legal-gated-v1",
      refundFeePolicy: "full_paid_amount",
    };
    expect(feeFacts.safeParse(fee).success).toBe(true);
    expect(feeFacts.safeParse({ ...fee, credits: 105000 }).success).toBe(false);
    expect(
      feeFacts.safeParse({ ...fee, processingFeeVarianceCents: -10 }).success,
    ).toBe(false);
    const refund = {
      amountPaidCents: 1050,
      creditFaceValueCents: 1000,
      processingFeeChargedCents: 50,
      priorPrincipalCents: 400,
      priorFeeCents: 10,
      principalCents: 600,
      feeCents: 40,
      full: true,
    };
    expect(refundFacts.safeParse(refund).success).toBe(true);
    expect(refundFacts.safeParse({ ...refund, feeCents: 0 }).success).toBe(
      false,
    );
  });
});
describe("authority and transport", () => {
  it("preserves catalogue and route lifecycle fields in signed payloads", () => {
    const listing = {
      projectId: "project_echo",
      publisherHandle: "publisher",
      slug: "echo",
      name: "Echo",
      tags: ["echo"],
      orgName: "Publisher",
      publishedAt: NOW,
      houseOperated: false,
      specDigest: "a".repeat(64),
      routeRevision: 1,
      pricing: { minCost: 1, maxCost: 1, endpointCount: 1, hasFreeTier: false },
    };
    expect(
      snapshot.safeParse({
        ...unsignedSnapshot,
        kind: "catalogue",
        payload: { items: [listing] },
      }).success,
    ).toBe(true);
    expect(
      snapshot.safeParse({
        ...unsignedSnapshot,
        kind: "catalogue",
        payload: {
          items: [
            {
              ...listing,
              pricing: { ...listing.pricing, token: { input: 1 } },
            },
          ],
        },
      }).success,
    ).toBe(false);
    const payload = {
      organizationId: "org_id",
      clerkOrgId: "org_publisher",
      projectId: "project_echo",
      specVersionId: "version_echo",
      version: "1.0.0",
      specDigest: "a".repeat(64),
      publisherHandle: "publisher",
      projectSlug: "echo",
      publicationGeneration: 1,
      credentialRevision: 1,
      visibility: "public",
      retired: false,
      admission: {
        mode: "entitled_only",
        policyRevision: 1,
        allowed: true,
        consumerClerkOrgId: "org_consumer",
      },
      deprecatedAt: Math.floor(NOW / 1000),
      sunsetAt: Math.floor(NOW / 1000) + 604800,
      deprecationMessage: "Retiring",
      spec: "{}",
    };
    expect(
      snapshot.safeParse({ ...unsignedSnapshot, kind: "route", payload })
        .success,
    ).toBe(true);
    expect(
      snapshot.safeParse({
        ...unsignedSnapshot,
        kind: "route",
        payload: {
          ...payload,
          admission: {
            mode: "entitled_only",
            policyRevision: 1,
            allowed: true,
          },
        },
      }).success,
    ).toBe(false);
  });
  it("requires exact drain and limits executable authority to 30 seconds", () => {
    expect(snapshot.safeParse(unsignedSnapshot).success).toBe(true);
    expect(
      snapshot.safeParse({ ...unsignedSnapshot, expiresAt: NOW + 30001 })
        .success,
    ).toBe(false);
    const ack = {
      protocolVersion: 2,
      deploymentId: "d",
      walletId: "w",
      ownerKey: "org:o",
      epoch: 1,
      gateRevision: 2,
      closeId: "close",
      requestedAt: NOW,
      reason: "refund",
      edgeFinalSequence: 2,
      settledThroughEdgeSequence: 2,
      sealedAt: NOW + 1,
    };
    expect(drainAck.safeParse(ack).success).toBe(true);
    expect(
      drainAck.safeParse({ ...ack, settledThroughEdgeSequence: 1 }).success,
    ).toBe(false);
  });
  it("verifies signed snapshots against nonce, scope, revision, expiry and deployment", async () => {
    const { signature: _, ...facts } = {
      ...unsignedSnapshot,
      payloadDigest: await fingerprint(unsignedSnapshot.payload),
    };
    const signed = { ...facts, signature: await sign(facts, SECRET) };
    const expected = {
      deploymentId: signed.deploymentId,
      kind: signed.kind,
      scope: signed.scope,
      nonce: signed.nonce,
      minimumRevision: 2,
      now: NOW,
      keys: { test: SECRET },
    };
    expect(await verifySnapshot(signed, expected)).toEqual(signed);
    expect(
      await verifySnapshot(signed, { ...expected, now: NOW - 1000 }),
    ).toEqual(signed);
    for (const patch of [
      { deploymentId: "wrong" },
      { nonce: "old" },
      { scope: "other" },
      { minimumRevision: 3 },
      { now: NOW + 30000 },
      { now: NOW - 1001 },
      { keys: { test: "x".repeat(32) } },
    ])
      await expect(
        verifySnapshot(signed, { ...expected, ...patch }),
      ).rejects.toThrow(Error);
    const inherited = { ...facts, keyId: "constructor" };
    await expect(
      verifySnapshot(
        { ...inherited, signature: await sign(inherited, String(Object)) },
        expected,
      ),
    ).rejects.toThrow("Snapshot signature rejected");
    await expect(
      verifySnapshot(
        { ...signed, payload: { ...signed.payload, archived: true } },
        expected,
      ),
    ).rejects.toThrow(Error);
  });
  it("uses HMAC verification for secrets and bounds bytes even without Content-Length", async () => {
    expect(await validInternalSecret(SECRET, SECRET)).toBe(true);
    expect(await validInternalSecret(SECRET + "x", SECRET)).toBe(false);
    expect(await validInternalSecret(null, SECRET)).toBe(false);
    expect(await validInternalSecret("", SECRET)).toBe(false);
    await expect(
      readBoundedJson(
        new Request("https://fixture.invalid", {
          method: "POST",
          body: JSON.stringify(admitted),
        }),
        admittedRequest,
      ),
    ).resolves.toEqual(admitted);
    await expect(
      readBoundedJson(
        new Request("https://fixture.invalid", {
          method: "POST",
          body: "x".repeat(100),
        }),
        admittedRequest,
        99,
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      readBoundedJson(
        new Request("https://fixture.invalid", { method: "POST", body: "{}" }),
        admittedRequest,
      ),
    ).rejects.toMatchObject({ status: 400, message: "Invalid request" });
    expect(() => canonical({ n: Infinity })).toThrow(Error);
    expect(() => canonical({ n: undefined })).toThrow(Error);
  });
});
