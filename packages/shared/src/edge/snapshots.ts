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
  ciphertext: z.string().min(1).max(16_384),
  iv: identity,
  keyVersion: identity,
  format: z.literal("aes-gcm-aad-v1"),
});
// The transport bundles up to 32 separately bounded credentials. Preserve the
// per-credential envelope bound above; JSON escaping/base64 enlarge a bundle.
export const headerBundle = envelope.extend({
  ciphertext: z.string().min(1).max(2_097_152),
});
const gate = z.enum(["open", "closing", "closed", "maintenance"]);
/** Preserve the current gateway catalogue fields; pricing remains scalar. */
export const catalogueListing = z.strictObject({
  projectId: identity,
  publisherHandle: identity,
  slug: identity,
  name: identity,
  description: z.string().max(4096).optional(),
  tags: z.array(identity).max(64),
  orgName: identity,
  publishedAt: integer.nullable(),
  houseOperated: z.boolean(),
  specDigest: digest,
  routeRevision: integer,
  pricing: z.strictObject({
    minCost: integer,
    maxCost: integer,
    endpointCount: integer.positive(),
    hasFreeTier: z.boolean(),
  }),
});
const routeAdmission = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("open"),
    policyRevision: integer,
    allowed: z.literal(true),
  }),
  z.strictObject({
    mode: z.literal("entitled_only"),
    policyRevision: integer,
    allowed: z.boolean(),
    consumerClerkOrgId: identity,
  }),
]);
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
    edgeBootstrapId: identity.optional(),
    generatedAt: integer,
    validUntil: integer,
    generationId: identity,
    page: integer,
    nextCursor: z.string().min(1).max(8192).optional(),
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
      (!["closing", "maintenance"].includes(c.gateState) ||
        c.closeId !== undefined),
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
  nextCursor: z.string().min(1).max(8192).optional(),
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
        clerkOrgId: identity,
        projectId: identity,
        specVersionId: identity,
        version: identity,
        specDigest: digest,
        publisherHandle: identity,
        projectSlug: identity,
        publicationGeneration: integer,
        credentialRevision: integer,
        visibility: z.enum(["private", "public"]),
        retired: z.boolean(),
        admission: routeAdmission,
        // Epoch milliseconds; the gateway converts to RFC header formats.
        deprecatedAt: integer.optional(),
        sunsetAt: integer.optional(),
        deprecationMessage: z.string().max(4096).optional(),
        retiredAt: integer.optional(),
        spec: z.string().max(1_048_576),
        upstreamHeaders: headerBundle.optional(),
      }),
    }),
    z.strictObject({
      ...snapshotBase,
      kind: z.literal("catalogue"),
      payload: z.strictObject({
        items: z.array(catalogueListing).max(100),
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
    (a) => a.settledThroughEdgeSequence === a.edgeFinalSequence,
    "Drain requires contiguous committed finalization watermark",
  );
export type Snapshot = z.infer<typeof snapshot>;
