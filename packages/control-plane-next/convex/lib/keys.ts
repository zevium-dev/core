import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireActiveOrg } from "./auth";
import { isPrivilegedOrgRole } from "@zevium/shared";
import { provisionHash, type Provision } from "./keyProjection";
export type Key = Extract<Doc<"apiKeys">, { kind: "key" }>;
export type Rotation = Extract<Doc<"apiKeys">, { kind: "rotation" }>;
export function keyDto(row: Key) {
  return {
    _id: row._id,
    keyId: row.keyId,
    keyFamilyId: row.keyFamilyId,
    keyName: row.keyName,
    ownerUserId: row.ownerUserId,
    budgetId: row.budgetId,
    budgetRevision: row.budgetRevision,
    monthlyCapCredits: row.monthlyCapCredits,
    disabled: row.lifecycle === "disabled" || row.revokedAt !== undefined,
    lifecycle: row.revokedAt !== undefined ? "revoked" : row.lifecycle,
    rotatedFromKeyId: row.rotatedFromKeyId,
    graceUntil: row.graceUntil,
    createdAt: row._creationTime,
    updatedAt: row.updatedAt,
  };
}
export function rotationDto(row: Rotation, clerkOrgId: string) {
  return {
    _id: row._id,
    _creationTime: row._creationTime,
    clerkOrgId,
    userId: row.actorUserId,
    operationId: row.operationId,
    oldKeyId: row.oldKeyId,
    newKeyId: row.newKeyId,
    status:
      row.state === "pending"
        ? "reserved"
        : row.state === "complete"
          ? "completed"
          : "failed",
    failure: row.failure,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
export function currentKey(row: Key) {
  return (
    row.revokedAt === undefined &&
    row.membershipRevokedAt === undefined &&
    row.graceUntil === undefined &&
    (row.expiresAt === undefined || row.expiresAt > Date.now())
  );
}
export async function membershipRemoved(
  ctx: Pick<QueryCtx, "db">,
  org: string,
  user: string,
  verifiedAt: number,
) {
  const deleted = await ctx.db
    .query("users")
    .withIndex("by_clerk", (q) => q.eq("clerkUserId", user))
    .unique();
  if (deleted?.deletedAt !== undefined) return true;
  const receipt = await ctx.db
    .query("webhookReceipts")
    .withIndex("by_object", (q) =>
      q
        .eq("provider", "clerk")
        .eq("account", "instance")
        .eq("objectId", `membership:${org}:${user}`),
    )
    .order("desc")
    .first();
  return !!receipt && receipt.sourceTimestamp >= verifiedAt;
}
export async function ownedKey(
  ctx: Pick<QueryCtx, "db" | "auth">,
  keyId: string,
) {
  const auth = await requireActiveOrg(ctx);
  const key = await ctx.db
    .query("apiKeys")
    .withIndex("by_key", (q) => q.eq("keyId", keyId))
    .unique();
  if (
    !key ||
    key.kind !== "key" ||
    key.organizationId !== auth.org._id ||
    key.clerkOrgId !== auth.org.clerkOrgId ||
    key.ownerUserId !== key.subjectUserId
  )
    throw new ConvexError("Verified key not found");
  return { ...auth, key };
}
export function requireKeyManager(
  subject: string,
  role: string | undefined,
  key: Key,
) {
  if (key.ownerUserId !== subject && !isPrivilegedOrgRole(role))
    throw new ConvexError("Verified key not found");
}
export async function insertKey(
  ctx: MutationCtx,
  org: Doc<"organizations">,
  p: Provision,
  verifiedAt: number,
  name?: string,
  old?: Key,
) {
  if (
    p.lifecycle !== "active" ||
    p.graceUntil !== null ||
    (p.expiresAt !== null && p.expiresAt <= Date.now()) ||
    (await membershipRemoved(ctx, p.clerkOrgId, p.ownerUserId, verifiedAt))
  )
    throw new ConvexError("Verified key is no longer active");
  for (const [index, field, value] of [
    ["by_key", "keyId", p.clerkKeyId],
    ["by_hash", "secretSha256", p.secretSha256],
  ] as const) {
    if (
      await ctx.db
        .query("apiKeys")
        .withIndex(index, (q) => q.eq(field, value))
        .first()
    )
      throw new ConvexError(
        "Verified key projection conflicts with existing state",
      );
  }
  const owned = await ctx.db
    .query("apiKeys")
    .withIndex("by_org_owner", (q) =>
      q
        .eq("kind", "key")
        .eq("organizationId", org._id)
        .eq("ownerUserId", p.ownerUserId),
    )
    .collect();
  if (
    owned.some((r) => r.kind === "key" && r._id !== old?._id && currentKey(r))
  )
    throw new ConvexError(
      "You already have a key in this organization. Rotate or revoke it before creating another.",
    );
  const id = await ctx.db.insert("apiKeys", {
    kind: "key",
    organizationId: org._id,
    clerkOrgId: org.clerkOrgId,
    keyId: p.clerkKeyId,
    keyName: name?.trim().slice(0, 64) || "API key",
    ownerUserId: p.ownerUserId,
    subjectUserId: p.subjectUserId,
    secretSha256: p.secretSha256,
    verifiedProjectionHash: await provisionHash(p),
    verifiedAt,
    keyFamilyId: old?.keyFamilyId ?? p.clerkKeyId,
    budgetId: p.budgetId,
    budgetRevision: p.budgetRevision,
    scopes: p.scopes,
    monthlyCapCredits: p.monthlyCapCredits ?? undefined,
    lifecycle: p.lifecycle,
    expiresAt: p.expiresAt ?? undefined,
    edgeRevision: 1,
    updatedAt: Date.now(),
    rotatedFromKeyId: old?.keyId,
  });
  return (await ctx.db.get(id)) as Key;
}
export async function revokeKey(
  ctx: MutationCtx,
  key: Key,
  membershipAt?: number,
) {
  if (key.revokedAt !== undefined) return key;
  await ctx.db.patch(key._id, {
    lifecycle: "disabled",
    revokedAt: Date.now(),
    membershipRevokedAt: membershipAt,
    edgeRevision: key.edgeRevision + 1,
    updatedAt: Date.now(),
    providerRevoke: {
      state: "pending",
      attempts: 0,
      nextAttemptAt: Date.now(),
    },
  });
  await ctx.scheduler.runAfter(0, internal.keyVerification.revokeWithRetry, {
    keyId: key.keyId,
  });
  return (await ctx.db.get(key._id)) as Key;
}
