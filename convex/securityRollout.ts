import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireAdmin } from "./lib/auth";
import {
  credentialBinding,
  migrateStoredSecret,
  webhookBinding,
  type StoredEncryptedSecret,
} from "./lib/credentialCrypto";

const SINGLETON = "security-rollout" as const;
const MAX_AUDIT_PAGE = 100;

type DbCtx = QueryCtx | MutationCtx;

export type SecurityAuditView = {
  auditId: string;
  generation: number;
  highWaterCreationTime: number;
  phase: Doc<"securityRolloutAudits">["phase"];
  credentialsScanned: number;
  webhooksScanned: number;
  current: number;
  old: number;
  plaintext: number;
  corrupt: number;
  broken: number;
  zeroCorruption: boolean;
  completedAt?: number;
};

function auditView(row: Doc<"securityRolloutAudits">): SecurityAuditView {
  return {
    auditId: row.auditId,
    generation: row.generation,
    highWaterCreationTime: row.highWaterCreationTime,
    phase: row.phase,
    credentialsScanned: row.credentialsScanned,
    webhooksScanned: row.webhooksScanned,
    current: row.current,
    old: row.old,
    plaintext: row.plaintext,
    corrupt: row.corrupt,
    broken: row.broken,
    zeroCorruption: row.zeroCorruption,
    ...(row.completedAt === undefined ? {} : { completedAt: row.completedAt }),
  };
}

async function rolloutState(ctx: DbCtx) {
  return await ctx.db
    .query("securityRolloutState")
    .withIndex("by_singleton", (q) => q.eq("singleton", SINGLETON))
    .unique();
}

export async function securityRolloutGeneration(ctx: DbCtx): Promise<number> {
  return (await rolloutState(ctx))?.generation ?? 0;
}

/**
 * Every non-audit credential or webhook-secret write hits this singleton.
 * Convex OCC turns concurrent audit/migration races into retry + invalidation.
 */
export async function bumpSecurityRolloutGeneration(
  ctx: MutationCtx,
): Promise<number> {
  const state = await rolloutState(ctx);
  const now = Date.now();
  if (state === null) {
    await ctx.db.insert("securityRolloutState", {
      singleton: SINGLETON,
      generation: 1,
      updatedAt: now,
    });
    return 1;
  }
  const generation = state.generation + 1;
  await ctx.db.patch(state._id, { generation, updatedAt: now });
  return generation;
}

async function auditById(ctx: DbCtx, auditId: string) {
  return await ctx.db
    .query("securityRolloutAudits")
    .withIndex("by_audit", (q) => q.eq("auditId", auditId))
    .unique();
}

/** Migration gate. Call from every mutation capable of scrubbing plaintext. */
export async function requireCompletedSecurityAudit(
  ctx: DbCtx,
  auditId: string,
): Promise<Doc<"securityRolloutAudits">> {
  const audit = await auditById(ctx, auditId);
  const generation = await securityRolloutGeneration(ctx);
  if (
    audit === null ||
    audit.phase !== "completed" ||
    audit.completedAt === undefined ||
    !audit.zeroCorruption ||
    audit.corrupt !== 0 ||
    audit.broken !== 0 ||
    audit.generation !== generation
  ) {
    throw new Error(
      "A completed zero-corruption security audit for the current generation is required",
    );
  }
  return audit;
}

type AuditCounts = Pick<
  Doc<"securityRolloutAudits">,
  "current" | "old" | "plaintext" | "corrupt" | "broken"
>;

async function inspectSecret(
  stored: StoredEncryptedSecret,
  binding: ReturnType<typeof credentialBinding>,
): Promise<AuditCounts> {
  const result = await migrateStoredSecret(stored, binding);
  return {
    current: result.broken ? 0 : 1,
    old: result.old ? 1 : 0,
    plaintext: result.plaintext ? 1 : 0,
    corrupt: result.corrupt ? 1 : 0,
    broken: result.broken ? 1 : 0,
  };
}

function addCounts(left: AuditCounts, right: AuditCounts): AuditCounts {
  return {
    current: left.current + right.current,
    old: left.old + right.old,
    plaintext: left.plaintext + right.plaintext,
    corrupt: left.corrupt + right.corrupt,
    broken: left.broken + right.broken,
  };
}

function previousWebhookSecret(
  row: Doc<"webhookEndpoints">,
): StoredEncryptedSecret | null {
  const values = [
    row.previousCiphertext,
    row.previousIv,
    row.previousKeyVersion,
    row.previousSealedCiphertext,
    row.previousSealedIv,
    row.previousSealedKeyVersion,
    row.previousSealedVersion,
  ];
  if (values.every((value) => value === undefined)) return null;
  return {
    ciphertext: row.previousCiphertext,
    iv: row.previousIv,
    keyVersion: row.previousKeyVersion,
    sealedCiphertext: row.previousSealedCiphertext,
    sealedIv: row.previousSealedIv,
    sealedKeyVersion: row.previousSealedKeyVersion,
    sealedVersion: row.previousSealedVersion,
  };
}

export const startAudit = mutation({
  args: {},
  handler: async (ctx): Promise<SecurityAuditView> => {
    await requireAdmin(ctx);
    const now = Date.now();
    const auditId = crypto.randomUUID();
    const generation = await securityRolloutGeneration(ctx);
    const [latestCredential, latestWebhook] = await Promise.all([
      ctx.db.query("upstreamCredentials").order("desc").first(),
      ctx.db.query("webhookEndpoints").order("desc").first(),
    ]);
    const highWaterCreationTime = Math.max(
      latestCredential?._creationTime ?? 0,
      latestWebhook?._creationTime ?? 0,
    );
    const id = await ctx.db.insert("securityRolloutAudits", {
      auditId,
      generation,
      highWaterCreationTime,
      phase: "credentials",
      credentialCursor: null,
      webhookCursor: null,
      credentialsScanned: 0,
      webhooksScanned: 0,
      current: 0,
      old: 0,
      plaintext: 0,
      corrupt: 0,
      broken: 0,
      zeroCorruption: false,
      createdAt: now,
    });
    const row = await ctx.db.get(id);
    if (row === null) throw new Error("Security audit could not be started");
    return auditView(row);
  },
});

export const getAudit = query({
  args: { auditId: v.string() },
  handler: async (ctx, args): Promise<SecurityAuditView | null> => {
    await requireAdmin(ctx);
    const row = await auditById(ctx, args.auditId);
    return row === null ? null : auditView(row);
  },
});

/**
 * Pages across both secret tables without changing a secret row. Generation
 * and creation-time high-water remain immutable from start through completion.
 */
export const auditPage = mutation({
  args: { auditId: v.string(), numItems: v.optional(v.number()) },
  handler: async (ctx, args): Promise<SecurityAuditView> => {
    await requireAdmin(ctx);
    const audit = await auditById(ctx, args.auditId);
    if (audit === null) throw new Error("Security audit not found");
    if (audit.phase === "completed" || audit.phase === "invalidated") {
      return auditView(audit);
    }
    const generation = await securityRolloutGeneration(ctx);
    if (generation !== audit.generation) {
      await ctx.db.patch(audit._id, {
        phase: "invalidated",
        zeroCorruption: false,
      });
      const invalidated = await ctx.db.get(audit._id);
      if (invalidated === null) throw new Error("Security audit unavailable");
      return auditView(invalidated);
    }

    const requested = args.numItems ?? 50;
    const numItems = Math.max(
      1,
      Math.min(MAX_AUDIT_PAGE, Math.floor(requested)),
    );
    let counts: AuditCounts = {
      current: audit.current,
      old: audit.old,
      plaintext: audit.plaintext,
      corrupt: audit.corrupt,
      broken: audit.broken,
    };

    if (audit.phase === "credentials") {
      const page = await ctx.db.query("upstreamCredentials").paginate({
        cursor: audit.credentialCursor ?? null,
        numItems,
      });
      for (const row of page.page) {
        if (row._creationTime > audit.highWaterCreationTime) {
          await ctx.db.patch(audit._id, {
            phase: "invalidated",
            zeroCorruption: false,
          });
          const invalidated = await ctx.db.get(audit._id);
          if (invalidated === null)
            throw new Error("Security audit unavailable");
          return auditView(invalidated);
        }
        counts = addCounts(
          counts,
          await inspectSecret(row, credentialBinding(row.projectId, row.name)),
        );
      }
      await ctx.db.patch(audit._id, {
        ...counts,
        credentialsScanned: audit.credentialsScanned + page.page.length,
        credentialCursor: page.continueCursor,
        phase: page.isDone ? "webhooks" : "credentials",
      });
    } else {
      const page = await ctx.db.query("webhookEndpoints").paginate({
        cursor: audit.webhookCursor ?? null,
        numItems,
      });
      for (const row of page.page) {
        if (row._creationTime > audit.highWaterCreationTime) {
          await ctx.db.patch(audit._id, {
            phase: "invalidated",
            zeroCorruption: false,
          });
          const invalidated = await ctx.db.get(audit._id);
          if (invalidated === null)
            throw new Error("Security audit unavailable");
          return auditView(invalidated);
        }
        const currentVersion = row.secretVersion ?? 1;
        counts = addCounts(
          counts,
          await inspectSecret(
            row,
            webhookBinding(row.projectId, currentVersion),
          ),
        );
        const previous = previousWebhookSecret(row);
        if (previous !== null) {
          counts = addCounts(
            counts,
            await inspectSecret(
              previous,
              webhookBinding(row.projectId, row.previousSecretVersion ?? 1),
            ),
          );
        }
      }
      const completedAt = page.isDone ? Date.now() : undefined;
      await ctx.db.patch(audit._id, {
        ...counts,
        webhooksScanned: audit.webhooksScanned + page.page.length,
        webhookCursor: page.continueCursor,
        phase: page.isDone ? "completed" : "webhooks",
        zeroCorruption:
          page.isDone && counts.corrupt === 0 && counts.broken === 0,
        completedAt,
      });
    }

    const updated = await ctx.db.get(audit._id);
    if (updated === null) throw new Error("Security audit unavailable");
    return auditView(updated);
  },
});
