import { z } from "zod";
import {
  CATALOGUE_AUTHORITY_MS,
  EXECUTABLE_AUTHORITY_MS,
  digest,
  identity,
  integer,
  lotCompatibility,
  owner,
} from "./money";

export const envelope = z.strictObject({
  ciphertext: identity,
  iv: identity,
  keyVersion: identity,
  format: z.literal("aes-gcm-aad-v1"),
});
const gate = z.enum(["open", "closing", "closed"]);
export const keyPolicy = z.strictObject({
  keyId: identity,
  secretSha256: digest,
  ownerUserId: identity,
  subjectUserId: identity,
  keyFamilyId: identity,
  budgetId: identity,
  budgetRevision: integer,
  scopes: z.array(identity).max(64),
  lifecycle: z.enum(["active", "grace", "disabled"]),
  monthlyCapCredits: integer.optional(),
  expiresAt: integer.optional(),
  graceUntil: integer.optional(),
  edgeRevision: integer,
});
export const checkpoint = z
  .strictObject({
    protocolVersion: z.literal(2),
    deploymentId: identity,
    walletId: identity,
    ownerKey: identity,
    owner,
    balance: integer,
    promoCredits: integer,
    sequence: integer,
    epoch: integer,
    gateRevision: integer,
    gateState: gate,
    settledThroughEdgeSequence: integer,
    generatedAt: integer,
    validUntil: integer,
    generationId: identity,
    page: integer,
    nextCursor: identity.optional(),
    closeId: identity.optional(),
    lots: z
      .array(
        lotCompatibility.extend({
          lotId: identity,
          sourceRef: identity,
          createdAt: integer,
          remainingCredits: integer,
        }),
      )
      .max(100),
    sources: z
      .array(
        z.strictObject({
          lotId: identity,
          originLotId: identity,
          sourceRef: identity,
          paymentId: identity.optional(),
          sourceCreatedAt: integer,
          remainingCredits: integer,
        }),
      )
      .max(100),
    keyPolicies: z.array(keyPolicy).max(100),
  })
  .refine(
    (c) =>
      c.ownerKey === `org:${c.owner.clerkOrgId}` &&
      c.promoCredits <= c.balance &&
      c.validUntil > c.generatedAt &&
      c.validUntil - c.generatedAt <= EXECUTABLE_AUTHORITY_MS &&
      c.lots.every((l) => l.walletId === c.walletId) &&
      (c.gateState !== "closing" || c.closeId !== undefined),
    "Invalid wallet authority",
  );
const snapshotBase = {
  schemaVersion: z.literal(2),
  deploymentId: identity,
  scope: identity,
  revision: integer,
  generationId: identity,
  generatedAt: integer,
  expiresAt: integer,
  keyId: identity,
  nonce: identity,
  payloadDigest: digest,
  nextCursor: identity.optional(),
  signature: digest,
};
export const snapshot = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...snapshotBase,
      kind: z.literal("org"),
      payload: z.strictObject({
        organizationId: identity,
        clerkOrgId: identity,
        archived: z.boolean(),
        revision: integer,
      }),
    }),
    z.strictObject({
      ...snapshotBase,
      kind: z.literal("keys"),
      payload: z.strictObject({
        organizationId: identity,
        clerkOrgId: identity,
        keys: z.array(keyPolicy).max(100),
      }),
    }),
    z.strictObject({
      ...snapshotBase,
      kind: z.literal("route"),
      payload: z.strictObject({
        organizationId: identity,
        projectId: identity,
        specVersionId: identity,
        specDigest: digest,
        publisherHandle: identity,
        projectSlug: identity,
        publicationGeneration: integer,
        credentialRevision: integer,
        visibility: z.enum(["private", "public"]),
        retired: z.boolean(),
        spec: z.string().max(1_048_576),
        upstreamHeaders: envelope.optional(),
      }),
    }),
    z.strictObject({
      ...snapshotBase,
      kind: z.literal("catalogue"),
      payload: z.strictObject({
        items: z
          .array(
            z.strictObject({
              projectId: identity,
              publisherHandle: identity,
              projectSlug: identity,
              name: identity,
              description: z.string().max(4096),
              specDigest: digest,
              routeRevision: integer,
              minCost: integer,
              hasFreeTier: z.boolean(),
            }),
          )
          .max(100),
      }),
    }),
  ])
  .refine(
    (s) =>
      s.expiresAt > s.generatedAt &&
      s.expiresAt - s.generatedAt <=
        (s.kind === "catalogue"
          ? CATALOGUE_AUTHORITY_MS
          : EXECUTABLE_AUTHORITY_MS),
    "Authority lifetime exceeded",
  );
export const freezeRequest = z.strictObject({
  protocolVersion: z.literal(2),
  deploymentId: identity,
  walletId: identity,
  ownerKey: identity,
  epoch: integer,
  gateRevision: integer,
  closeId: identity,
  requestedAt: integer,
  reason: z.enum([
    "refund",
    "dispute",
    "expiry",
    "archive",
    "admin",
    "dust_merge",
  ]),
});
export const drainAck = freezeRequest
  .extend({
    edgeFinalSequence: integer,
    settledThroughEdgeSequence: integer,
    sealedAt: integer,
  })
  .refine(
    (a) =>
      a.sealedAt >= a.requestedAt &&
      a.settledThroughEdgeSequence === a.edgeFinalSequence,
    "Drain requires contiguous committed finalization watermark",
  );
export type Snapshot = z.infer<typeof snapshot>;
