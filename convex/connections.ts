import { v } from "convex/values";
import {
  collectOAuthSchemes,
  getOAuthProvider,
  parseSpec,
  requestedScopes,
  type ConnectedAccountScheme,
  type ConnectionView,
  type OAuthProviderId,
} from "@zevium/shared";

import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { getOrganization, isActive } from "./lib/identity";
import { connectionSecretBinding, decryptSecret } from "./lib/credentialCrypto";
import { providerClient } from "./lib/oauthProviderClients";
import { envelope as encryptedSecret } from "./schema/common";

type EncryptedSecret = Doc<"upstreamCredentials">["envelope"];

/** Open authorization links per consumer org; bounds abandoned flows. */
export const MAX_PENDING_CONNECTIONS = 50;
/** Refresh this long before the provider's expiry. */
export const REFRESH_SKEW_MS = 60_000;
/** One refresh at a time per connection; rotation-safe. */
export const REFRESH_LEASE_MS = 15_000;
/** Failed and revoked rows stay visible for this long. */
export const CONNECTION_TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;
const CLEANUP_BATCH = 100;
/** Renewals started per cron run; the rest wait for the next hour. */
const RENEW_BATCH = 25;

export type ConnectionStartContext =
  | {
      ok: true;
      scheme: string;
      provider: OAuthProviderId;
      clientId: string;
      scopes: string[];
    }
  | {
      ok: false;
      error:
        | "organization_unavailable"
        | "project_not_found"
        | "no_oauth_scheme"
        | "scheme_required"
        | "scheme_not_found"
        | "provider_not_configured"
        | "publisher_not_allowed"
        | "too_many_pending";
    };

export type GatewayConnectionSelection =
  | {
      status: "ok";
      connectionId: string;
      accessToken: string;
      accessExpiresAt: number | null;
    }
  | { status: "refresh"; connectionId: string; tokenRevision: number }
  | {
      status:
        | "connection_required"
        | "connection_ambiguous"
        | "connection_not_found"
        | "connection_reauthorize";
    };

export function toConnectionView(
  row: Doc<"oauthConnections">,
  now: number,
): ConnectionView {
  const pending = row.status === "pending" || row.status === "exchanging";
  return {
    id: row.publicId,
    api: row.api,
    scheme: row.scheme,
    provider: row.provider,
    label: row.label ?? null,
    status:
      pending && (row.pendingExpiresAt ?? 0) <= now
        ? "expired"
        : pending
          ? "pending"
          : (row.status as Exclude<
              Doc<"oauthConnections">["status"],
              "pending" | "exchanging"
            >),
    scopes: row.grantedScopes ?? row.requestedScopes,
    createdAt: row.createdAt,
    connectedAt: row.connectedAt ?? null,
    error: row.error ?? null,
  };
}

/**
 * Renewal time for providers whose long-lived tokens die unused; `undefined`
 * for short-lived tokens, which refresh on the call path.
 */
export function renewAtFor(
  providerId: string,
  accessExpiresAt: number | undefined,
): number | undefined {
  const ahead = getOAuthProvider(providerId)?.renewBeforeMs;
  return ahead === undefined || accessExpiresAt === undefined
    ? undefined
    : accessExpiresAt - ahead;
}

/** Latest published spec's provider-bound schemes for a live project. */
async function publishedScheme(
  ctx: QueryCtx,
  projectId: Id<"projects">,
): Promise<ConnectedAccountScheme[] | null> {
  const spec = await publishedSpec(ctx, projectId);
  if (spec === null) return null;
  try {
    return collectOAuthSchemes(parseSpec(spec)).schemes;
  } catch {
    return [];
  }
}

/** Latest published spec text of a live (published, not retired) project. */
async function publishedSpec(
  ctx: QueryCtx,
  projectId: Id<"projects">,
): Promise<string | null> {
  const project = await ctx.db.get(projectId);
  if (
    project === null ||
    project.status !== "published" ||
    project.retirement?.state === "retired" ||
    project.latestVersionId === undefined
  ) {
    return null;
  }
  return (await ctx.db.get(project.latestVersionId))?.spec ?? null;
}

async function byPublicId(
  ctx: QueryCtx,
  publicId: string,
): Promise<Doc<"oauthConnections"> | null> {
  return await ctx.db
    .query("oauthConnections")
    .withIndex("by_public_id", (q) => q.eq("publicId", publicId))
    .unique();
}

/**
 * Everything a new authorization link needs. The gateway has already applied
 * route visibility and admission to the caller; this re-reads the published
 * spec so scopes and endpoints come from Convex, not the request.
 */
export const prepareStart = internalQuery({
  args: {
    clerkOrgId: v.string(),
    projectId: v.string(),
    scheme: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ConnectionStartContext> => {
    const org = await getOrganization(ctx, args.clerkOrgId);
    if (org === null || !(await isActive(ctx, org))) {
      return { ok: false, error: "organization_unavailable" };
    }
    const projectId = ctx.db.normalizeId("projects", args.projectId);
    const schemes = projectId ? await publishedScheme(ctx, projectId) : null;
    if (projectId === null || schemes === null) {
      return { ok: false, error: "project_not_found" };
    }
    if (schemes.length === 0) return { ok: false, error: "no_oauth_scheme" };
    let scheme: ConnectedAccountScheme | undefined;
    if (args.scheme !== undefined) {
      scheme = schemes.find((s) => s.name === args.scheme);
      if (!scheme) return { ok: false, error: "scheme_not_found" };
    } else if (schemes.length === 1) {
      scheme = schemes[0];
    } else {
      return { ok: false, error: "scheme_required" };
    }
    // Tokens are issued to Zevium's provider apps: house listings only.
    if (!(await ctx.db.get(projectId))!.houseOperated) {
      return { ok: false, error: "publisher_not_allowed" };
    }
    const client = providerClient(getOAuthProvider(scheme.provider)!);
    if (client === null) return { ok: false, error: "provider_not_configured" };
    const pending = await ctx.db
      .query("oauthConnections")
      .withIndex("by_org_status", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("status", "pending"),
      )
      .take(MAX_PENDING_CONNECTIONS);
    if (pending.length >= MAX_PENDING_CONNECTIONS) {
      return { ok: false, error: "too_many_pending" };
    }
    return {
      ok: true,
      scheme: scheme.name,
      provider: scheme.provider,
      clientId: client.clientId,
      scopes: requestedScopes(
        parseSpec((await publishedSpec(ctx, projectId))!),
        scheme,
      ),
    };
  },
});

export const createPending = internalMutation({
  args: {
    publicId: v.string(),
    clerkOrgId: v.string(),
    projectId: v.string(),
    api: v.string(),
    scheme: v.string(),
    provider: v.string(),
    label: v.optional(v.string()),
    requestedScopes: v.array(v.string()),
    createdByKeyId: v.string(),
    redirectUri: v.string(),
    returnUrl: v.optional(v.string()),
    stateHash: v.string(),
    /** Absent for providers without PKCE. */
    codeVerifier: v.optional(encryptedSecret),
    pendingExpiresAt: v.number(),
  },
  handler: async (ctx, args): Promise<ConnectionView> => {
    const projectId = ctx.db.normalizeId("projects", args.projectId);
    if (projectId === null) throw new Error("Project not found");
    const now = Date.now();
    const id = await ctx.db.insert("oauthConnections", {
      ...args,
      projectId,
      status: "pending",
      tokenRevision: 0,
      createdAt: now,
      updatedAt: now,
    });
    return toConnectionView((await ctx.db.get(id))!, now);
  },
});

export type ClaimedAuthorization =
  | {
      status: "claimed";
      connectionId: string;
      provider: string;
      redirectUri: string;
      returnUrl: string | null;
      codeVerifier: EncryptedSecret | null;
    }
  | { status: "expired"; connectionId: string; returnUrl: string | null };

/** Single use: the state is cleared in the same transaction that claims it. */
export const claimByState = internalMutation({
  args: { stateHash: v.string() },
  handler: async (ctx, args): Promise<ClaimedAuthorization | null> => {
    const row = await ctx.db
      .query("oauthConnections")
      .withIndex("by_state_hash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    if (row === null || row.status !== "pending") return null;
    const now = Date.now();
    if ((row.pendingExpiresAt ?? 0) <= now) {
      await ctx.db.patch(row._id, {
        status: "failed",
        error: "Authorization link expired. Start a new connection.",
        stateHash: undefined,
        codeVerifier: undefined,
        updatedAt: now,
      });
      return {
        status: "expired",
        connectionId: row.publicId,
        returnUrl: row.returnUrl ?? null,
      };
    }
    await ctx.db.patch(row._id, {
      status: "exchanging",
      stateHash: undefined,
      updatedAt: now,
    });
    return {
      status: "claimed",
      connectionId: row.publicId,
      provider: row.provider,
      redirectUri: row.redirectUri,
      returnUrl: row.returnUrl ?? null,
      codeVerifier: row.codeVerifier ?? null,
    };
  },
});

export const activate = internalMutation({
  args: {
    connectionId: v.string(),
    accessToken: encryptedSecret,
    refreshToken: v.optional(encryptedSecret),
    accessExpiresAt: v.optional(v.number()),
    grantedScopes: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await byPublicId(ctx, args.connectionId);
    if (row === null || row.status !== "exchanging") return false;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "active",
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      accessExpiresAt: args.accessExpiresAt,
      renewAt: renewAtFor(row.provider, args.accessExpiresAt),
      grantedScopes: args.grantedScopes,
      codeVerifier: undefined,
      pendingExpiresAt: undefined,
      error: undefined,
      tokenRevision: row.tokenRevision + 1,
      connectedAt: now,
      updatedAt: now,
    });
    return true;
  },
});

/** Ends a flow or a grant. Secrets are dropped; the row stays for status. */
export const fail = internalMutation({
  args: {
    connectionId: v.string(),
    from: v.union(v.literal("exchanging"), v.literal("active")),
    error: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await byPublicId(ctx, args.connectionId);
    if (row === null || row.status !== args.from) return;
    await ctx.db.patch(row._id, {
      status: args.from === "active" ? "reauthorize" : "failed",
      error: args.error,
      accessToken: undefined,
      refreshToken: undefined,
      accessExpiresAt: undefined,
      renewAt: undefined,
      codeVerifier: undefined,
      pendingExpiresAt: undefined,
      refreshLeaseUntil: undefined,
      updatedAt: Date.now(),
    });
  },
});

export const listForOrg = internalQuery({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args): Promise<ConnectionView[]> => {
    const now = Date.now();
    const rows = await ctx.db
      .query("oauthConnections")
      .withIndex("by_org_status", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .take(500);
    return rows
      .filter((row) => row.status !== "revoked")
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((row) => toConnectionView(row, now));
  },
});

export const getForOrg = internalQuery({
  args: { clerkOrgId: v.string(), connectionId: v.string() },
  handler: async (ctx, args): Promise<ConnectionView | null> => {
    const row = await byPublicId(ctx, args.connectionId);
    return row === null || row.clerkOrgId !== args.clerkOrgId
      ? null
      : toConnectionView(row, Date.now());
  },
});

/**
 * Zevium stops using the grant at once; gateway caches expire within 60 s.
 * The provider is asked to revoke it too, best effort, after commit.
 */
export const revoke = internalMutation({
  args: { clerkOrgId: v.string(), connectionId: v.string() },
  handler: async (ctx, args): Promise<ConnectionView | null> => {
    const row = await byPublicId(ctx, args.connectionId);
    if (row === null || row.clerkOrgId !== args.clerkOrgId) return null;
    const now = Date.now();
    if (row.status !== "revoked") {
      const revocation = getOAuthProvider(row.provider)?.revoke;
      const field =
        revocation?.token === "refresh" && row.refreshToken
          ? "refresh"
          : "access";
      const token = field === "refresh" ? row.refreshToken : row.accessToken;
      if (revocation && token) {
        await ctx.scheduler.runAfter(
          0,
          internal.connectionsNode.revokeAtProvider,
          {
            connectionId: row.publicId,
            provider: row.provider,
            field,
            token,
          },
        );
      }
      await ctx.db.patch(row._id, {
        status: "revoked",
        stateHash: undefined,
        codeVerifier: undefined,
        accessToken: undefined,
        refreshToken: undefined,
        accessExpiresAt: undefined,
        renewAt: undefined,
        pendingExpiresAt: undefined,
        refreshLeaseUntil: undefined,
        updatedAt: now,
      });
    }
    return toConnectionView((await ctx.db.get(row._id))!, now);
  },
});

/**
 * Pick the connection for a gateway call. An explicit id must belong to the
 * caller's org and this API's scheme; otherwise exactly one active connection
 * is used and several are ambiguous.
 */
export const selectForGateway = internalQuery({
  args: {
    clerkOrgId: v.string(),
    projectId: v.string(),
    scheme: v.string(),
    connectionId: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<GatewayConnectionSelection> => {
    const projectId = ctx.db.normalizeId("projects", args.projectId);
    if (projectId === null) return { status: "connection_not_found" };
    let row: Doc<"oauthConnections"> | null;
    if (args.connectionId !== undefined) {
      row = await byPublicId(ctx, args.connectionId);
      if (
        row === null ||
        row.clerkOrgId !== args.clerkOrgId ||
        row.projectId !== projectId ||
        row.scheme !== args.scheme
      ) {
        return { status: "connection_not_found" };
      }
      if (row.status === "reauthorize") {
        return { status: "connection_reauthorize" };
      }
      if (row.status !== "active") return { status: "connection_not_found" };
    } else {
      const active = await ctx.db
        .query("oauthConnections")
        .withIndex("by_org_project_scheme_status", (q) =>
          q
            .eq("clerkOrgId", args.clerkOrgId)
            .eq("projectId", projectId)
            .eq("scheme", args.scheme)
            .eq("status", "active"),
        )
        .take(2);
      if (active.length > 1) return { status: "connection_ambiguous" };
      row = active[0] ?? null;
      if (row === null) {
        const stale = await ctx.db
          .query("oauthConnections")
          .withIndex("by_org_project_scheme_status", (q) =>
            q
              .eq("clerkOrgId", args.clerkOrgId)
              .eq("projectId", projectId)
              .eq("scheme", args.scheme)
              .eq("status", "reauthorize"),
          )
          .first();
        return {
          status: stale ? "connection_reauthorize" : "connection_required",
        };
      }
    }
    if (
      !row.accessToken ||
      (row.accessExpiresAt !== undefined &&
        row.accessExpiresAt - REFRESH_SKEW_MS <= args.now)
    ) {
      return {
        status: "refresh",
        connectionId: row.publicId,
        tokenRevision: row.tokenRevision,
      };
    }
    return {
      status: "ok",
      connectionId: row.publicId,
      accessToken: await decryptSecret(
        row.accessToken,
        connectionSecretBinding(row.publicId, "access"),
      ),
      accessExpiresAt: row.accessExpiresAt ?? null,
    };
  },
});

export type RefreshLease =
  | {
      status: "leased";
      provider: string;
      refreshToken: EncryptedSecret | null;
      /** Instagram-style providers refresh with the access token itself. */
      accessToken: EncryptedSecret | null;
    }
  | { status: "busy" }
  | { status: "gone" };

/** Take the refresh lease for one token revision. */
export const beginRefresh = internalMutation({
  args: { connectionId: v.string(), tokenRevision: v.number() },
  handler: async (ctx, args): Promise<RefreshLease> => {
    const row = await byPublicId(ctx, args.connectionId);
    if (row === null || row.status !== "active") return { status: "gone" };
    const now = Date.now();
    if (
      row.tokenRevision !== args.tokenRevision ||
      (row.refreshLeaseUntil !== undefined && row.refreshLeaseUntil > now)
    ) {
      return { status: "busy" };
    }
    await ctx.db.patch(row._id, { refreshLeaseUntil: now + REFRESH_LEASE_MS });
    return {
      status: "leased",
      provider: row.provider,
      refreshToken: row.refreshToken ?? null,
      accessToken: row.accessToken ?? null,
    };
  },
});

export const completeRefresh = internalMutation({
  args: {
    connectionId: v.string(),
    tokenRevision: v.number(),
    accessToken: encryptedSecret,
    refreshToken: v.optional(encryptedSecret),
    accessExpiresAt: v.optional(v.number()),
    grantedScopes: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await byPublicId(ctx, args.connectionId);
    if (
      row === null ||
      row.status !== "active" ||
      row.tokenRevision !== args.tokenRevision
    ) {
      return false;
    }
    await ctx.db.patch(row._id, {
      accessToken: args.accessToken,
      // Providers that don't rotate keep the existing refresh token.
      refreshToken: args.refreshToken ?? row.refreshToken,
      accessExpiresAt: args.accessExpiresAt,
      renewAt: renewAtFor(row.provider, args.accessExpiresAt),
      grantedScopes: args.grantedScopes ?? row.grantedScopes,
      tokenRevision: row.tokenRevision + 1,
      refreshLeaseUntil: undefined,
      updatedAt: Date.now(),
    });
    return true;
  },
});

/** Cron: drop abandoned authorizations and old failed or revoked rows. */
export const cleanup = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const now = Date.now();
    let removed = 0;
    for (const status of ["pending", "exchanging"] as const) {
      const rows = await ctx.db
        .query("oauthConnections")
        .withIndex("by_status_expiry", (q) =>
          q.eq("status", status).lt("pendingExpiresAt", now - 60 * 60 * 1000),
        )
        .take(CLEANUP_BATCH);
      for (const row of rows) {
        await ctx.db.delete(row._id);
        removed += 1;
      }
    }
    for (const status of ["failed", "revoked"] as const) {
      const rows = await ctx.db
        .query("oauthConnections")
        .withIndex("by_status_updated", (q) =>
          q.eq("status", status).lt("updatedAt", now - CONNECTION_TOMBSTONE_MS),
        )
        .take(CLEANUP_BATCH);
      for (const row of rows) {
        await ctx.db.delete(row._id);
        removed += 1;
      }
    }
    return removed;
  },
});

/**
 * Cron: refresh long-lived grants before they lapse unused. Each refresh
 * takes the normal per-revision lease, so a concurrent call-path refresh
 * simply wins; transient failures are retried next run.
 */
export const scheduleRenewals = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const due = await ctx.db
      .query("oauthConnections")
      .withIndex("by_status_renew", (q) =>
        // Undefined sorts first: the lower bound skips short-lived grants.
        q.eq("status", "active").gte("renewAt", 0).lte("renewAt", Date.now()),
      )
      .take(RENEW_BATCH);
    for (const row of due) {
      await ctx.scheduler.runAfter(0, internal.connectionsNode.refresh, {
        connectionId: row.publicId,
        tokenRevision: row.tokenRevision,
      });
    }
    return due.length;
  },
});
