import { DurableObject } from "cloudflare:workers";
import {
  openProjection,
  sealProjection,
  readRing,
  projection,
  type Projection,
} from "@zevium/shared/edge/replication";
import { canonical, fingerprint } from "@zevium/shared/edge/transport";
import type { EdgeOAuthDO } from "./oauth";
import type { NextWalletDO } from "./wallet";
export interface NextEnv {
  EDGE_OAUTH?: DurableObjectNamespace<EdgeOAuthDO>;
  CLERK_SECRET_KEY?: string;
  MCP_OAUTH_ISSUER?: string;
  MCP_OAUTH_RESOURCE?: string;
  CONTROL_PLANE_MODE?: string;
  NEXT_DEPLOYMENT_ID?: string;
  NEXT_CONVEX_SITE_URL?: string;
  NEXT_SNAPSHOT_KEYS?: string;
  NEXT_TRANSPORT_KEYS?: string;
  NEXT_ADMISSION_KEYS?: string;
  GATEWAY_INTERNAL_SECRET?: string;
  EDGE_SNAPSHOTS?: DurableObjectNamespace<EdgeSnapshotDO>;
  NEXT_WALLET?: DurableObjectNamespace<NextWalletDO>;
}
export async function pull(
  env: NextEnv,
  kind: Projection["kind"],
  scope: string,
  cursor?: string,
  minimumRevision = 0,
) {
  const nonce = crypto.randomUUID(),
    url = new URL(
      kind === "wallet" ? "/wallet-grants" : "/edge-snapshot",
      env.NEXT_CONVEX_SITE_URL,
    );
  for (const [name, value] of Object.entries({
    kind,
    scope,
    nonce,
    ...(cursor ? { cursor } : {}),
  }))
    url.searchParams.set(name, value);
  const res = await fetch(url, {
    headers: { "x-internal-secret": env.GATEWAY_INTERNAL_SECRET ?? "" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error("Snapshot unavailable");
  return openProjection(await res.json(), {
    deploymentId: env.NEXT_DEPLOYMENT_ID!,
    kind,
    scope,
    nonce,
    minimumRevision,
    now: Date.now(),
    keys: readRing(env.NEXT_SNAPSHOT_KEYS).keys,
  });
}
/** Private, deployment-scoped SQLite coordinator. Only alarms contact Convex;
 * read() schedules a cold refresh and returns unavailable immediately. */
export class EdgeSnapshotDO extends DurableObject<NextEnv> {
  constructor(ctx: DurableObjectState, env: NextEnv) {
    super(ctx, env);
  }
  async read(kind: Projection["kind"], scope: string): Promise<string | null> {
    const identity = await this.ctx.storage.get<{
      kind: Projection["kind"];
      scope: string;
    }>("identity");
    if (identity && (identity.kind !== kind || identity.scope !== scope))
      throw new Error("Scope mismatch");
    if (!identity) await this.ctx.storage.put("identity", { kind, scope });
    const touched = (await this.ctx.storage.get<number>("lastRead")) ?? 0;
    if (Date.now() - touched > 15_000)
      await this.ctx.storage.put("lastRead", Date.now());
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + 1);
    const current = await this.ctx.storage.get<Projection>("current");
    return current &&
      current.deploymentId === this.env.NEXT_DEPLOYMENT_ID &&
      current.expiresAt > Date.now() &&
      current.generatedAt <= Date.now()
      ? JSON.stringify(current)
      : null;
  }
  async alarm() {
    if (
      Date.now() - ((await this.ctx.storage.get<number>("lastRead")) ?? 0) >
      60_000
    )
      return;
    await this.ctx.storage.setAlarm(Date.now() + 15_000);
    const identity = await this.ctx.storage.get<{
      kind: Projection["kind"];
      scope: string;
    }>("identity");
    if (!identity) return;
    try {
      const old = await this.ctx.storage.get<Projection>("current");
      let candidate = await pull(
        this.env,
        identity.kind,
        identity.scope,
        undefined,
        old?.revision ?? 0,
      );
      // Catalogue manifests are built twice with identical page content/cursors.
      // Any publish/revoke changing a page aborts installation; only a complete
      // immutable generation is ever exposed by read().
      if (identity.kind === "catalogue") {
        const collect = async (first: Projection) => {
          const pages = [
            first.payload as { items: unknown[]; nextCursor: string | null },
          ];
          while (pages.at(-1)!.nextCursor) {
            if (pages.length >= 100 || Date.now() >= first.expiresAt)
              throw new Error("Manifest unavailable");
            pages.push(
              (
                await pull(
                  this.env,
                  "catalogue",
                  identity.scope,
                  pages.at(-1)!.nextCursor!,
                )
              ).payload as (typeof pages)[number],
            );
          }
          return pages;
        };
        const pages = await collect(candidate),
          check = await collect(
            await pull(this.env, "catalogue", identity.scope),
          );
        if (canonical(pages) !== canonical(check))
          throw new Error("Generation changed");
        // Stored manifest is private and derived only from verified envelopes.
        const {
          signature: _signature,
          payloadDigest: _digest,
          keyId: _keyId,
          ...facts
        } = candidate;
        candidate = await sealProjection(
          {
            ...facts,
            payload: { items: pages.flatMap((p) => p.items) },
            generationId: await fingerprint(pages),
          },
          readRing(this.env.NEXT_SNAPSHOT_KEYS),
        );
      }
      if (candidate.expiresAt <= Date.now())
        throw new Error("Expired generation");
      await this.ctx.storage.transaction(async (tx) => {
        const latest = await tx.get<Projection>("current");
        if (
          latest &&
          (latest.revision > candidate.revision ||
            (latest.revision === candidate.revision &&
              latest.generationId !== candidate.generationId))
        )
          throw new Error("Stale generation");
        const nonce = await tx.get<string>("consumedNonce");
        if (nonce === candidate.nonce) throw new Error("Nonce replay");
        await tx.put({ current: candidate, consumedNonce: candidate.nonce });
      });
    } catch {
      /* Retain prior generation only until its original expiry. */
    }
  }
}
export async function readSnapshot(
  env: NextEnv,
  kind: Projection["kind"],
  scope: string,
) {
  if (!env.EDGE_SNAPSHOTS || !env.NEXT_DEPLOYMENT_ID) return null;
  const value = await env.EDGE_SNAPSHOTS.get(
    env.EDGE_SNAPSHOTS.idFromName(
      JSON.stringify([env.NEXT_DEPLOYMENT_ID, kind, scope]),
    ),
  ).read(kind, scope);
  return value ? projection.parse(JSON.parse(value)) : null;
}
