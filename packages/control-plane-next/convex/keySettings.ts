import { v, ConvexError } from "convex/values";
import { isPrivilegedOrgRole, canonicalJson, sha256Hex } from "@zevium/shared";
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireActiveOrg, requireOrgAdmin } from "./lib/auth";
import { getOrganization, isActive } from "./lib/identity";
import {
  currentKey,
  insertKey,
  keyDto,
  ownedKey,
  requireKeyManager,
  revokeKey,
  rotationDto,
  membershipRemoved,
  type Key,
  type Rotation,
} from "./lib/keys";
import {
  provisionHash,
  verifiedKeyProjectionValidator,
  verifiedKeyRotationProjectionValidator,
  verifyProjection,
} from "./lib/keyProjection";
import type { QueryCtx, MutationCtx } from "./_generated/server";
async function visible(ctx: QueryCtx) {
  const { org, claims } = await requireActiveOrg(ctx);
  const rows = isPrivilegedOrgRole(claims.orgRole)
    ? await ctx.db
        .query("apiKeys")
        .withIndex("by_org", (q) =>
          q.eq("kind", "key").eq("organizationId", org._id),
        )
        .collect()
    : await ctx.db
        .query("apiKeys")
        .withIndex("by_org_owner", (q) =>
          q
            .eq("kind", "key")
            .eq("organizationId", org._id)
            .eq("ownerUserId", claims.subject),
        )
        .collect();
  return rows.filter((r): r is Key => r.kind === "key");
}
export const getForOrg = query({
  args: {},
  handler: async (ctx) => (await visible(ctx)).map(keyDto),
});
export const listKeys = query({
  args: {},
  handler: async (ctx) =>
    (await visible(ctx))
      .filter((r) => r.revokedAt === undefined)
      .map((r) => ({
        ...keyDto(r),
        id: r.keyId,
        name: r.keyName,
        masked: `••••${r.keyId.slice(-4)}`,
        lastUsedAt: null,
        revoked: false,
        current: currentKey(r),
      })),
});
export const registerVerified = mutation({
  args: {
    projection: verifiedKeyProjectionValidator,
    signature: v.string(),
    keyName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { org, claims } = await requireActiveOrg(ctx);
    await verifyProjection(args.projection, args.signature, false);
    const p = args.projection.provision;
    if (
      p.clerkOrgId !== org.clerkOrgId ||
      p.ownerUserId !== claims.subject ||
      p.subjectUserId !== claims.subject
    )
      throw new ConvexError("Verified key projection does not match identity");
    const row = await ctx.db
      .query("apiKeys")
      .withIndex("by_key", (q) => q.eq("keyId", p.clerkKeyId))
      .unique();
    if (row) {
      if (
        row.kind !== "key" ||
        row.organizationId !== org._id ||
        row.ownerUserId !== claims.subject ||
        row.verifiedProjectionHash !== (await provisionHash(p))
      )
        throw new ConvexError(
          "Verified key projection conflicts with existing state",
        );
      return keyDto(row);
    }
    return keyDto(
      await insertKey(ctx, org, p, args.projection.verifiedAt, args.keyName),
    );
  },
});
export const registerOwnedKey = mutation({
  args: { keyId: v.string(), keyName: v.string() },
  handler: async (ctx, args) => {
    const { key, claims } = await ownedKey(ctx, args.keyId);
    if (key.ownerUserId !== claims.subject)
      throw new ConvexError("Verified key not found");
    const name = args.keyName.trim();
    if (!name || name.length > 64)
      throw new ConvexError("Key name must be 1–64 characters");
    await ctx.db.patch(key._id, { keyName: name, updatedAt: Date.now() });
    return keyDto((await ctx.db.get(key._id)) as Key);
  },
});
export const setCap = mutation({
  args: { keyId: v.string(), monthlyCapCredits: v.union(v.number(), v.null()) },
  handler: async (ctx, args) => {
    const { key, claims, org } = await ownedKey(ctx, args.keyId);
    requireOrgAdmin(claims);
    if (
      args.monthlyCapCredits !== null &&
      (!Number.isSafeInteger(args.monthlyCapCredits) ||
        args.monthlyCapCredits <= 0)
    )
      throw new ConvexError("Cap must be a positive whole number of credits");
    // Apply one policy revision to current/grace family members so rotation cannot split a budget.
    const family = await ctx.db
      .query("apiKeys")
      .withIndex("by_org_owner", (q) =>
        q
          .eq("kind", "key")
          .eq("organizationId", org._id)
          .eq("ownerUserId", key.ownerUserId),
      )
      .collect();
    const revision =
      Math.max(
        ...family
          .filter(
            (r): r is Key =>
              r.kind === "key" && r.keyFamilyId === key.keyFamilyId,
          )
          .map((r) => r.budgetRevision),
      ) + 1;
    for (const row of family)
      if (
        row.kind === "key" &&
        row.keyFamilyId === key.keyFamilyId &&
        row.revokedAt === undefined
      )
        await ctx.db.patch(row._id, {
          monthlyCapCredits: args.monthlyCapCredits ?? undefined,
          budgetRevision: revision,
          edgeRevision: row.edgeRevision + 1,
          updatedAt: Date.now(),
        });
    return keyDto((await ctx.db.get(key._id)) as Key);
  },
});
export const setDisabled = mutation({
  args: { keyId: v.string(), disabled: v.boolean() },
  handler: async (ctx, args) => {
    const { key, claims } = await ownedKey(ctx, args.keyId);
    requireKeyManager(claims.subject, claims.orgRole, key);
    if (
      !currentKey(key) ||
      (await membershipRemoved(
        ctx,
        key.clerkOrgId,
        key.ownerUserId,
        key.verifiedAt,
      ))
    )
      throw new ConvexError("This key is no longer active");
    await ctx.db.patch(key._id, {
      lifecycle: args.disabled ? "disabled" : "active",
      edgeRevision: key.edgeRevision + 1,
      updatedAt: Date.now(),
    });
    return keyDto((await ctx.db.get(key._id)) as Key);
  },
});
export const revokePrevious = mutation({
  args: { keyId: v.string() },
  handler: async (ctx, args) => {
    const { key, claims } = await ownedKey(ctx, args.keyId);
    requireKeyManager(claims.subject, claims.orgRole, key);
    return keyDto(await revokeKey(ctx, key));
  },
});
export const beginRotation = mutation({
  args: { operationId: v.string(), oldKeyId: v.string() },
  handler: async (ctx, args) => {
    const { org, key, claims } = await ownedKey(ctx, args.oldKeyId);
    requireKeyManager(claims.subject, claims.orgRole, key);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(args.operationId))
      throw new ConvexError("Invalid rotation operation");
    const existing = await ctx.db
      .query("apiKeys")
      .withIndex("by_rotation", (q) =>
        q
          .eq("kind", "rotation")
          .eq("organizationId", org._id)
          .eq("actorUserId", claims.subject)
          .eq("operationId", args.operationId),
      )
      .unique();
    if (existing?.kind === "rotation") {
      if (existing.oldKeyId !== args.oldKeyId)
        throw new ConvexError("Rotation operation conflicts with key");
      if (
        existing.state === "pending" &&
        (existing.leaseUntil ?? 0) <= Date.now()
      )
        await ctx.db.patch(existing._id, {
          state: "failed",
          failure: "Reservation expired",
          updatedAt: Date.now(),
        });
      return rotationDto(
        (await ctx.db.get(existing._id)) as Rotation,
        org.clerkOrgId,
      );
    }
    const active = await ctx.db
      .query("apiKeys")
      .withIndex("by_active_rotation", (q) =>
        q
          .eq("kind", "rotation")
          .eq("organizationId", org._id)
          .eq("oldKeyId", key.keyId)
          .eq("state", "pending"),
      )
      .unique();
    if (active?.kind === "rotation") {
      if ((active.leaseUntil ?? 0) > Date.now())
        throw new ConvexError("A rotation is already in progress for this key");
      await ctx.db.patch(active._id, {
        state: "failed",
        failure: "Reservation expired",
        updatedAt: Date.now(),
      });
    }
    if (
      !currentKey(key) ||
      key.lifecycle !== "active" ||
      (await membershipRemoved(
        ctx,
        org.clerkOrgId,
        key.ownerUserId,
        key.verifiedAt,
      ))
    )
      throw new ConvexError("Only the current key can be rotated");
    const id = await ctx.db.insert("apiKeys", {
      kind: "rotation",
      organizationId: org._id,
      actorUserId: claims.subject,
      operationId: args.operationId,
      oldKeyId: key.keyId,
      state: "pending",
      requestFingerprint: await sha256Hex(canonicalJson(args)),
      leaseUntil: Date.now() + 300_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return rotationDto((await ctx.db.get(id)) as Rotation, org.clerkOrgId);
  },
});
/** Only authenticated broker projections may nominate a minted key for cleanup. */
async function recordFailedRotation(
  ctx: MutationCtx,
  op: Rotation,
  clerkOrgId: string,
  newKeyId?: string,
) {
  if (op.state === "complete") return rotationDto(op, clerkOrgId);
  if (op.newKeyId && newKeyId && op.newKeyId !== newKeyId)
    throw new ConvexError("Rotation operation conflicts with cleanup key");
  const keyId = newKeyId ?? op.newKeyId;
  if (keyId && !op.providerRevoke) {
    // Never revoke an already registered key or duplicate another cleanup job.
    const registered = await ctx.db
      .query("apiKeys")
      .withIndex("by_key", (q) => q.eq("keyId", keyId))
      .unique();
    const cleanup = await ctx.db
      .query("apiKeys")
      .withIndex("by_new_key", (q) => q.eq("newKeyId", keyId))
      .first();
    if (!registered && (!cleanup || cleanup._id === op._id)) {
      await ctx.db.patch(op._id, {
        newKeyId: keyId,
        providerRevoke: {
          state: "pending",
          attempts: 0,
          nextAttemptAt: Date.now(),
        },
      });
      await ctx.scheduler.runAfter(
        0,
        internal.keyVerification.revokeWithRetry,
        { keyId },
      );
    }
  }
  if (op.state !== "failed")
    await ctx.db.patch(op._id, {
      state: "failed",
      failure: "Key rotation could not be completed",
      updatedAt: Date.now(),
    });
  return rotationDto((await ctx.db.get(op._id)) as Rotation, clerkOrgId);
}
export const completeRotation = mutation({
  args: {
    projection: verifiedKeyRotationProjectionValidator,
    signature: v.string(),
    keyName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const p = args.projection;
    await verifyProjection(p, args.signature, true, true);
    const { key: old, org, claims } = await ownedKey(ctx, p.oldKeyId);
    requireKeyManager(claims.subject, claims.orgRole, old);
    const op = await ctx.db
      .query("apiKeys")
      .withIndex("by_rotation", (q) =>
        q
          .eq("kind", "rotation")
          .eq("organizationId", org._id)
          .eq("actorUserId", claims.subject)
          .eq("operationId", p.operationId),
      )
      .unique();
    if (!op || op.kind !== "rotation" || op.oldKeyId !== p.oldKeyId)
      throw new ConvexError("Rotation operation not found");
    const fingerprint = await sha256Hex(canonicalJson(p));
    if (op.state === "complete") {
      if (op.requestFingerprint !== fingerprint)
        throw new ConvexError(
          "Rotation operation conflicts with completed key",
        );
      return { ...rotationDto(op, org.clerkOrgId), graceUntil: p.graceUntil };
    }
    const n = p.newProvision;
    const fail = () =>
      recordFailedRotation(ctx, op, org.clerkOrgId, n.clerkKeyId);
    if (
      op.state !== "pending" ||
      (op.leaseUntil ?? 0) <= Date.now() ||
      Math.abs(Date.now() - p.verifiedAt) > 300_000
    )
      return fail();
    if (
      !currentKey(old) ||
      old.lifecycle !== "active" ||
      (await membershipRemoved(
        ctx,
        old.clerkOrgId,
        old.ownerUserId,
        old.verifiedAt,
      ))
    )
      return fail();
    if (
      n.clerkOrgId !== org.clerkOrgId ||
      n.ownerUserId !== old.ownerUserId ||
      n.subjectUserId !== old.subjectUserId ||
      n.budgetId !== old.budgetId ||
      n.budgetRevision !== old.budgetRevision ||
      n.monthlyCapCredits !== (old.monthlyCapCredits ?? null) ||
      canonicalJson(n.scopes) !== canonicalJson(old.scopes)
    )
      return fail();
    if (p.graceUntil !== p.verifiedAt + 86_400_000) return fail();
    try {
      await insertKey(ctx, org, n, p.verifiedAt, args.keyName, old);
    } catch (error) {
      // insertKey's domain checks throw before any write; database failures still roll back.
      if (!(error instanceof ConvexError)) throw error;
      return fail();
    }
    await ctx.db.patch(old._id, {
      lifecycle: "grace",
      graceUntil: p.graceUntil,
      edgeRevision: old.edgeRevision + 1,
      updatedAt: Date.now(),
    });
    await ctx.db.patch(op._id, {
      state: "complete",
      newKeyId: n.clerkKeyId,
      requestFingerprint: fingerprint,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAt(p.graceUntil, internal.keySettings.expireGrace, {
      keyId: old.keyId,
    });
    return {
      ...rotationDto((await ctx.db.get(op._id)) as Rotation, org.clerkOrgId),
      graceUntil: p.graceUntil,
    };
  },
});
export const failRotation = mutation({
  args: {
    operationId: v.string(),
    message: v.string(),
    cleanup: v.optional(
      v.object({
        projection: verifiedKeyRotationProjectionValidator,
        signature: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { org, claims } = await requireActiveOrg(ctx);
    const op = await ctx.db
      .query("apiKeys")
      .withIndex("by_rotation", (q) =>
        q
          .eq("kind", "rotation")
          .eq("organizationId", org._id)
          .eq("actorUserId", claims.subject)
          .eq("operationId", args.operationId),
      )
      .unique();
    if (!op || op.kind !== "rotation")
      throw new ConvexError("Rotation operation not found");
    if (args.cleanup) {
      const { projection, signature } = args.cleanup;
      await verifyProjection(projection, signature, true, true);
      if (
        projection.operationId !== op.operationId ||
        projection.oldKeyId !== op.oldKeyId
      )
        throw new ConvexError("Rotation operation conflicts with cleanup key");
    }
    return recordFailedRotation(
      ctx,
      op,
      org.clerkOrgId,
      args.cleanup?.projection.newProvision.clerkKeyId,
    );
  },
});
export const expireGrace = internalMutation({
  args: { keyId: v.string() },
  handler: async (ctx, args) => {
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_key", (q) => q.eq("keyId", args.keyId))
      .unique();
    if (
      key?.kind === "key" &&
      key.graceUntil !== undefined &&
      key.graceUntil <= Date.now()
    )
      await revokeKey(ctx, key);
  },
});
export const resolveMcpIdentity = internalQuery({
  args: { userId: v.string(), orgId: v.string() },
  handler: async (ctx, args) => {
    const org = await getOrganization(ctx, args.orgId);
    if (!org || !(await isActive(ctx, org))) return null;
    const rows = await ctx.db
      .query("apiKeys")
      .withIndex("by_org_owner", (q) =>
        q
          .eq("kind", "key")
          .eq("organizationId", org._id)
          .eq("ownerUserId", args.userId),
      )
      .collect();
    const keys: Key[] = [];
    for (const row of rows)
      if (
        row.kind === "key" &&
        currentKey(row) &&
        row.lifecycle === "active" &&
        !(await membershipRemoved(
          ctx,
          org.clerkOrgId,
          args.userId,
          row.verifiedAt,
        ))
      )
        keys.push(row);
    return keys.length === 1
      ? { orgId: org.clerkOrgId, keyId: keys[0]!.keyId }
      : null;
  },
});
