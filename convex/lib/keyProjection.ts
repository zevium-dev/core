import { v, ConvexError } from "convex/values";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "@zevium/shared";
const keyProvisionValidator = v.object({
  secretSha256: v.string(),
  clerkKeyId: v.string(),
  clerkOrgId: v.string(),
  ownerUserId: v.string(),
  subjectUserId: v.string(),
  budgetId: v.string(),
  budgetRevision: v.number(),
  lifecycle: v.union(
    v.literal("active"),
    v.literal("grace"),
    v.literal("disabled"),
  ),
  monthlyCapCredits: v.union(v.number(), v.null()),
  graceUntil: v.union(v.number(), v.null()),
  expiresAt: v.union(v.number(), v.null()),
  scopes: v.array(v.string()),
});

export const verifiedKeyProjectionValidator = v.object({
  schemaVersion: v.literal(1),
  verifiedAt: v.number(),
  provision: keyProvisionValidator,
});

export const verifiedKeyRotationProjectionValidator = v.object({
  schemaVersion: v.literal(1),
  verifiedAt: v.number(),
  operationId: v.string(),
  oldKeyId: v.string(),
  newProvision: keyProvisionValidator,
  graceUntil: v.number(),
});

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_:./-]+$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const provisionSchema = z
  .object({
    secretSha256: z.string().regex(/^[a-f0-9]{64}$/),
    clerkKeyId: id,
    clerkOrgId: id,
    ownerUserId: id,
    subjectUserId: id,
    budgetId: id,
    budgetRevision: positive,
    lifecycle: z.enum(["active", "grace", "disabled"]),
    monthlyCapCredits: positive.nullable(),
    graceUntil: positive.nullable(),
    expiresAt: positive.nullable(),
    scopes: z.array(id.max(126)).min(1).max(32),
  })
  .strict()
  .refine(
    (p) =>
      p.ownerUserId === p.subjectUserId &&
      p.budgetId !== p.clerkOrgId &&
      (p.lifecycle !== "grace" || p.graceUntil !== null),
  );
const projectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    verifiedAt: positive,
    provision: provisionSchema,
  })
  .strict();
const rotationSchema = z
  .object({
    schemaVersion: z.literal(1),
    verifiedAt: positive,
    operationId: id,
    oldKeyId: id,
    newProvision: provisionSchema,
    graceUntil: positive,
  })
  .strict()
  .refine(
    (p) =>
      p.oldKeyId !== p.newProvision.clerkKeyId && p.graceUntil > p.verifiedAt,
  );
export type Provision = z.infer<typeof provisionSchema>;
export const provisionHash = (p: Provision) => sha256Hex(canonicalJson(p));
export async function verifyProjection(
  value: unknown,
  signature: string,
  rotation: boolean,
  allowExpired = false,
) {
  const parsed = (rotation ? rotationSchema : projectionSchema).safeParse(
    value,
  );
  if (
    !parsed.success ||
    (!allowExpired && Math.abs(Date.now() - parsed.data.verifiedAt) > 300_000)
  )
    throw new ConvexError("Verified key projection is expired or invalid");
  const secret = process.env.REGISTRY_KEY_PROJECTION_HMAC_SECRET;
  if (!secret || new TextEncoder().encode(secret).length < 32)
    throw new ConvexError("Verified key projection is not configured");
  if (!/^v1=[a-f0-9]{64}$/.test(signature))
    throw new ConvexError("Verified key projection signature is invalid");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = Uint8Array.from(signature.slice(3).match(/../g)!, (pair) =>
    parseInt(pair, 16),
  );
  const domain = rotation
    ? "zevium-registry-key-rotation-projection-v1"
    : "zevium-registry-key-projection-v1";
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      bytes,
      new TextEncoder().encode(`${domain}\0${canonicalJson(value)}`),
    ))
  )
    throw new ConvexError("Verified key projection signature is invalid");
}
