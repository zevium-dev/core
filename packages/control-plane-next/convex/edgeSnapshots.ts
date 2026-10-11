import { z } from "zod";
import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";
import { isActive } from "./lib/identity";
import { membershipRemoved } from "./lib/keys";
import { credentialBinding, decryptSecret } from "./lib/credentialCrypto";
import { facts } from "./money/walletLedger";
import { fingerprint, sign, verify } from "../contracts/transport";
import {
  encryptHeaders,
  readRing,
  type Checkpoint,
  type RoutePayload,
} from "@zevium/shared/edge/replication";

/** Claim before installing any spend authority. The DO writes this identity
 * locally first, so retries survive crashes without granting a second owner. */
export const activate = internalMutation({
  args: {
    clerkOrgId: v.string(),
    bootstrapId: v.string(),
    deploymentId: v.string(),
  },
  handler: async (ctx, args) => {
    if (
      args.deploymentId !== process.env.NEXT_DEPLOYMENT_ID ||
      !/^[a-f0-9-]{36}$/.test(args.bootstrapId)
    )
      throw new Error("Invalid activation");
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_owner", (q) => q.eq("ownerKey", `org:${args.clerkOrgId}`))
      .unique();
    if (!wallet) throw new Error("Wallet unavailable");
    if (wallet.edgeBootstrapId) {
      if (wallet.edgeBootstrapId !== args.bootstrapId)
        throw new Error("Wallet authority already claimed");
      return null;
    }
    if (
      wallet.epoch !== 1 ||
      wallet.settledThroughEdgeSequence !== 0 ||
      !["open", "closing"].includes(wallet.gateState)
    )
      throw new Error("Wallet recovery required");
    await ctx.db.patch(wallet._id, { edgeBootstrapId: args.bootstrapId });
    return null;
  },
});

/** All joins for an executable projection occur at one database snapshot. Key
 * scopes are possession hashes (one key), avoiding changing org-key page walks. */
export const read = internalQuery({
  args: {
    kind: v.string(),
    scope: v.string(),
    cursor: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (
    ctx,
    { kind, scope, cursor, now },
  ): Promise<{
    payload: unknown;
    generationId: string;
    generatedAt: number;
    expiresAt: number;
  }> => {
    const deploymentId = process.env.NEXT_DEPLOYMENT_ID!;
    let payload: unknown = null;
    if (kind === "keys") {
      const row = scope.startsWith("key:")
        ? await ctx.db
            .query("apiKeys")
            .withIndex("by_key", (q) => q.eq("keyId", scope.slice(4)))
            .unique()
        : await ctx.db
            .query("apiKeys")
            .withIndex("by_hash", (q) => q.eq("secretSha256", scope))
            .unique();
      if (row?.kind === "key") {
        const org = await ctx.db.get(row.organizationId);
        const revoked =
          row.revokedAt !== undefined ||
          row.membershipRevokedAt !== undefined ||
          !org ||
          !(await isActive(ctx, org)) ||
          (await membershipRemoved(
            ctx,
            row.clerkOrgId,
            row.ownerUserId,
            row.verifiedAt,
          ));
        payload = facts({
          organizationId: row.organizationId,
          clerkOrgId: row.clerkOrgId,
          keys: revoked
            ? []
            : [
                {
                  keyId: row.keyId,
                  secretSha256: row.secretSha256,
                  ownerUserId: row.ownerUserId,
                  subjectUserId: row.subjectUserId,
                  keyFamilyId: row.keyFamilyId,
                  budgetId: row.budgetId,
                  budgetRevision: row.budgetRevision,
                  scopes: row.scopes,
                  lifecycle: row.lifecycle,
                  monthlyCapCredits: row.monthlyCapCredits,
                  expiresAt: row.expiresAt,
                  graceUntil: row.graceUntil,
                  edgeRevision: row.edgeRevision,
                },
              ],
        });
      }
    } else if (kind === "org") {
      const org = await ctx.db
        .query("organizations")
        .withIndex("by_clerk", (q) => q.eq("clerkOrgId", scope))
        .unique();
      if (org)
        payload = {
          organizationId: org._id,
          clerkOrgId: scope,
          archived: !(await isActive(ctx, org)),
          revision: org.revision,
        };
    } else if (kind === "route") {
      const [handle, slug, consumer] = z
        .tuple([
          z.string().min(1).max(128),
          z.string().min(1).max(128),
          z.string().max(256),
        ])
        .parse(JSON.parse(scope));
      const route = await ctx.db
        .query("routeTombstones")
        .withIndex("by_route", (q) =>
          q.eq("publisherHandle", handle!).eq("projectSlug", slug!),
        )
        .unique();
      if (route) {
        const org = await ctx.db.get(route.organizationId),
          project = await ctx.db.get(route.projectId);
        const version = project?.latestVersionId
          ? await ctx.db.get(project.latestVersionId)
          : null;
        if (
          org &&
          project &&
          version &&
          (await isActive(ctx, org)) &&
          (project.visibility === "public" ||
            (project.retirement?.state === "retired" &&
              project.desiredVisibility === "public") ||
            consumer === org.clerkOrgId)
        ) {
          const retired =
            route.retiredAt !== undefined ||
            project.retirement?.state === "retired" ||
            (project.retirement !== undefined &&
              project.retirement.sunsetAt <= now);
          if (
            retired ||
            (project.status === "published" &&
              project.qualityStatus === "active")
          ) {
            const consumerOrg = consumer
              ? await ctx.db
                  .query("organizations")
                  .withIndex("by_clerk", (q) => q.eq("clerkOrgId", consumer))
                  .unique()
              : null;
            const entitled = consumerOrg
              ? await ctx.db
                  .query("usageRollups")
                  .withIndex("by_consumer_project", (q) =>
                    q
                      .eq("kind", "lifetime_consumer_project")
                      .eq("consumerOrganizationId", consumerOrg._id)
                      .eq("projectId", project._id),
                  )
                  .unique()
              : null;
            const credentials = consumer
              ? await ctx.db
                  .query("upstreamCredentials")
                  .withIndex("by_project_name", (q) =>
                    q.eq("projectId", project._id),
                  )
                  .take(33)
              : [];
            if (credentials.length > 32)
              throw new Error("Credential bound exceeded");
            const revision = project.revision;
            const headers: Record<string, string> = {};
            for (const c of credentials)
              headers[c.name] = await decryptSecret(
                c.envelope,
                credentialBinding(project._id, c.name, c.revision),
              );
            const value: RoutePayload = facts({
              organizationId: org._id,
              clerkOrgId: org.clerkOrgId,
              projectId: project._id,
              specVersionId: version._id,
              version: version.version,
              specDigest: version.contentHash,
              publisherHandle: handle!,
              projectSlug: slug!,
              publicationGeneration: project.publicationGeneration,
              credentialRevision: revision,
              visibility: retired
                ? project.desiredVisibility
                : project.visibility,
              retired,
              spec: version.spec,
              admission: project.retirement
                ? {
                    mode: "entitled_only",
                    policyRevision: project.retirement.revision,
                    allowed: consumer === org.clerkOrgId || !!entitled,
                    consumerClerkOrgId: consumer || "public",
                  }
                : { mode: "open", policyRevision: revision, allowed: true },
              deprecatedAt:
                project.retirement?.startedAt ?? version.deprecatedAt,
              // Version sunset is informational; only project retirement
              // owns the executable cutoff and consumer notice window.
              sunsetAt: project.retirement?.sunsetAt,
              deprecationMessage:
                project.retirement?.message ?? version.deprecationMessage,
              retiredAt: route.retiredAt ?? project.retirement?.retiredAt,
              upstreamHeaders: credentials.length
                ? await encryptHeaders(
                    headers,
                    [deploymentId, project._id, revision],
                    readRing(process.env.NEXT_TRANSPORT_KEYS),
                  )
                : undefined,
            });
            payload = value;
          }
        }
      }
    } else if (kind === "catalogue") {
      const page = await ctx.db
        .query("projects")
        .withIndex("by_discoverable_newest", (q) => q.eq("discoverable", true))
        .order("desc")
        .paginate({ cursor: cursor ?? null, numItems: 50 });
      const items = [];
      for (const project of page.page) {
        const org = await ctx.db.get(project.organizationId),
          version = project.latestVersionId
            ? await ctx.db.get(project.latestVersionId)
            : null;
        if (
          !org ||
          !version ||
          !(await isActive(ctx, org)) ||
          project.visibility !== "public" ||
          project.qualityStatus !== "active" ||
          project.retirement?.state === "retired"
        )
          continue;
        items.push(
          facts({
            projectId: project._id,
            publisherHandle: org.publicHandle,
            slug: project.slug,
            name: project.name,
            description: project.description,
            tags: project.tags,
            orgName: org.name,
            publishedAt: project.publishedAt ?? null,
            houseOperated: project.houseOperated,
            specDigest: version.contentHash,
            routeRevision: project.revision,
            pricing: {
              minCost: project.minCost ?? 0,
              maxCost: project.maxCost ?? 0,
              endpointCount: project.endpointCount,
              hasFreeTier: project.hasFreeTier,
            },
          }),
        );
      }
      payload = { items, nextCursor: page.isDone ? null : page.continueCursor };
    } else if (kind === "wallet") {
      const wallet = await ctx.db
        .query("wallets")
        .withIndex("by_owner", (q) => q.eq("ownerKey", `org:${scope}`))
        .unique();
      if (!wallet) throw new Error("Wallet unavailable");
      const org = await ctx.db.get(wallet.owner.organizationId);
      const stamp = await fingerprint([
        wallet._id,
        wallet.sequence,
        wallet.epoch,
        wallet.gateRevision,
        wallet.settledThroughEdgeSequence,
        wallet.edgeBootstrapId ?? null,
        org?.revision ?? 0,
        org?.archivedAt ?? null,
      ]);
      const ring = readRing(process.env.NEXT_SNAPSHOT_KEYS);
      let pageCursor: string | null = null,
        generatedAt = now,
        pageNumber = 0;
      if (cursor) {
        const token = JSON.parse(cursor) as {
          stamp: string;
          cursor: string;
          generatedAt: number;
          page: number;
          keyId: string;
          signature: string;
        };
        const { signature, ...body } = token;
        if (
          token.stamp !== stamp ||
          token.generatedAt + 30_000 <= now ||
          !Object.hasOwn(ring.keys, token.keyId) ||
          !(await verify(body, signature, ring.keys[token.keyId]!))
        )
          throw new Error("Checkpoint generation changed");
        pageCursor = token.cursor;
        generatedAt = token.generatedAt;
        pageNumber = token.page;
      }
      const rows = await ctx.db
        .query("fundingLotSources")
        .withIndex("by_wallet_spend", (q) =>
          q.eq("walletId", wallet._id).eq("state", "available"),
        )
        .paginate({ cursor: pageCursor, numItems: 100 });
      const lots: Checkpoint["lots"] = [];
      for (const id of new Set(rows.page.map((s) => s.lotId))) {
        const lot = await ctx.db.get(id);
        if (!lot) throw new Error("Funding container missing");
        lots.push(
          facts({
            lotId: lot._id,
            walletId: wallet._id,
            sourceRef: lot.sourceRef,
            createdAt: lot.createdAt,
            remainingCredits: lot.remainingCredits,
            expiryClass: lot.expiryClass,
            expiresAt: lot.expiresAt,
            sourceKind: lot.sourceKind,
            refundable: lot.refundable,
            priority: lot.priority,
          }),
        );
      }
      let nextCursor: string | undefined;
      if (!rows.isDone) {
        const body = {
          stamp,
          cursor: rows.continueCursor,
          generatedAt,
          page: pageNumber + 1,
          keyId: ring.current,
        };
        nextCursor = JSON.stringify({
          ...body,
          signature: await sign(body, ring.keys[ring.current]!),
        });
      }
      const checkpoint: Checkpoint = facts({
        protocolVersion: 2,
        deploymentId,
        walletId: wallet._id,
        ownerKey: wallet.ownerKey,
        owner: wallet.owner,
        balance: wallet.balance,
        promoCredits: wallet.promoCredits,
        sequence: wallet.sequence,
        epoch: wallet.epoch,
        gateRevision: wallet.gateRevision,
        gateState: wallet.gateState,
        settledThroughEdgeSequence: wallet.settledThroughEdgeSequence,
        edgeBootstrapId: wallet.edgeBootstrapId,
        generatedAt,
        validUntil: generatedAt + 30_000,
        generationId: stamp,
        page: pageNumber,
        nextCursor,
        closeId: wallet.close?.id,
        lots,
        sources: rows.page.map((s) =>
          facts({
            lotId: s.lotId,
            originLotId: s.originLotId,
            sourceRef: s.sourceRef,
            paymentId: s.paymentId,
            sourceCreatedAt: s.sourceCreatedAt,
            remainingCredits: s.remainingCredits,
          }),
        ),
        keyPolicies: [],
      });
      payload = facts({
        checkpoint,
        freeze:
          wallet.gateState === "closing" && wallet.close
            ? {
                protocolVersion: 2,
                deploymentId,
                walletId: wallet._id,
                ownerKey: wallet.ownerKey,
                epoch: wallet.epoch,
                gateRevision: wallet.gateRevision,
                closeId: wallet.close.id,
                requestedAt: wallet.close.requestedAt,
                reason: wallet.close.reason,
              }
            : undefined,
      });
      return {
        payload,
        generationId: stamp,
        generatedAt,
        expiresAt: generatedAt + 30_000,
      };
    } else throw new Error("Unknown projection");
    return {
      payload,
      generationId: await fingerprint(payload),
      generatedAt: now,
      expiresAt: now + (kind === "catalogue" ? 60_000 : 30_000),
    };
  },
});
