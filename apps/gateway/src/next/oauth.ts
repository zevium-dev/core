import { DurableObject } from "cloudflare:workers";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { sha256Hex } from "@zevium/shared";
import {
  encryptHeaders,
  decryptHeaders,
  readRing,
  type TransportEnvelope,
} from "@zevium/shared/edge/replication";
import {
  ClerkMcpOAuthVerifier,
  oauthConfig,
  type McpOAuthOutcome,
} from "../mcp-oauth";
import {
  coldRefreshBudget,
  COLD_FILL_MS,
  NEGATIVE_TTL_MS,
  waitForColdFill,
} from "./cold-refresh";
import type { NextEnv } from "./snapshots";

/** Reject malformed opaque/JWT bearers before allocating storage or calling Clerk.
 * Decoding is only a cheap rejection filter, never proof of authentication. */
export function plausibleOAuthToken(token: string) {
  if (token.length > 16_384) return false;
  if (token.startsWith("oat_"))
    return /^oat_[A-Za-z0-9_-]{16,512}$/.test(token);
  try {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
      return false;
    const header = decodeProtectedHeader(token),
      claims = decodeJwt(token);
    return (
      header.alg === "RS256" &&
      ["at+jwt", "application/at+jwt"].includes(
        header.typ?.toLowerCase() ?? "",
      ) &&
      typeof claims.exp === "number" &&
      claims.exp * 1000 > Date.now() &&
      typeof claims.iat === "number" &&
      typeof claims.sub === "string" &&
      claims.sub.startsWith("user_") &&
      typeof claims.org_id === "string" &&
      claims.org_id.startsWith("org_") &&
      typeof claims.jti === "string" &&
      typeof claims.client_id === "string"
    );
  } catch {
    return false;
  }
}
type Authority = { outcome: McpOAuthOutcome; expiresAt: number };
/** Warm requests use local authority. Cold fills are bounded and single-flight;
 * only verified identities retain an encrypted token for periodic refresh. */
export class EdgeOAuthDO extends DurableObject<NextEnv> {
  private pending?: Promise<void>;
  private retryAt = 0;
  async read(token: string): Promise<McpOAuthOutcome> {
    if (!plausibleOAuthToken(token)) return { status: "invalid" };
    const scope = await sha256Hex(token),
      old = await this.ctx.storage.get<string>("scope");
    if (old && old !== scope) throw new Error("OAuth scope mismatch");
    let state = await this.ctx.storage.get<Authority>("authority");
    if (!state || state.expiresAt <= Date.now()) {
      await waitForColdFill(this.refresh(token, scope, true));
      state = await this.ctx.storage.get<Authority>("authority");
    }
    if (!state || state.expiresAt <= Date.now())
      return { status: "unavailable" };
    if (state.outcome.status === "ok") {
      const touched = (await this.ctx.storage.get<number>("lastRead")) ?? 0;
      if (Date.now() - touched > 15_000)
        await this.ctx.storage.put("lastRead", Date.now());
      if ((await this.ctx.storage.getAlarm()) === null)
        await this.ctx.storage.setAlarm(Date.now() + 15_000);
    }
    return state.outcome;
  }
  private async refresh(token: string, scope: string, cold: boolean) {
    if (this.pending) return this.pending;
    if (cold && (Date.now() < this.retryAt || !coldRefreshBudget.take()))
      return;
    this.retryAt = Date.now() + 5000;
    this.pending = this.fill(
      token,
      scope,
      AbortSignal.timeout(cold ? COLD_FILL_MS : 5000),
    );
    try {
      await this.pending;
    } finally {
      this.pending = undefined;
    }
  }
  async alarm() {
    const scope = await this.ctx.storage.get<string>("scope");
    if (
      !scope ||
      Date.now() - ((await this.ctx.storage.get<number>("lastRead")) ?? 0) >
        60_000
    ) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + 15_000);
    try {
      const envelope =
        (await this.ctx.storage.get<TransportEnvelope>("token"))!;
      const { token } = await decryptHeaders(
        envelope,
        [this.env.NEXT_DEPLOYMENT_ID, scope],
        readRing(this.env.NEXT_TRANSPORT_KEYS),
      );
      await this.refresh(token, scope, false);
    } catch {
      /* Existing authority expires without extension. */
    }
  }
  private async fill(token: string, scope: string, signal: AbortSignal) {
    try {
      const config = oauthConfig(
        this.env.MCP_OAUTH_ISSUER,
        this.env.MCP_OAUTH_RESOURCE,
      );
      if (
        !config ||
        !this.env.CLERK_SECRET_KEY ||
        !this.env.GATEWAY_INTERNAL_SECRET ||
        !this.env.NEXT_CONVEX_SITE_URL
      )
        return;
      let expiresAt = Date.now() + 30_000;
      if (!token.startsWith("oat_"))
        expiresAt = Math.min(expiresAt, (decodeJwt(token).exp ?? 0) * 1000);
      const verifier = new ClerkMcpOAuthVerifier({
        ...config,
        secretKey: this.env.CLERK_SECRET_KEY,
        siteUrl: this.env.NEXT_CONVEX_SITE_URL,
        internalSecret: this.env.GATEWAY_INTERNAL_SECRET,
        fetchImpl: async (input, init) => {
          signal.throwIfAborted();
          // Workers support manual/follow only. Provider redirects remain failures.
          const response = await fetch(input, {
            ...init,
            signal,
            redirect: "manual",
          });
          if (String(input).includes("access_tokens/verify") && response.ok) {
            const value = (await response.clone().json()) as {
              expiration?: number;
            };
            expiresAt = Math.min(expiresAt, (value.expiration ?? 0) * 1000);
          }
          return response;
        },
      });
      const outcome = await verifier.verify(token);
      signal.throwIfAborted();
      if (outcome.status === "unavailable") return;
      if (outcome.status !== "ok" || expiresAt <= Date.now()) {
        await this.ctx.storage.deleteAll();
        await this.ctx.storage.put("authority", {
          outcome: expiresAt <= Date.now() ? { status: "invalid" } : outcome,
          expiresAt: Date.now() + NEGATIVE_TTL_MS,
        });
        await this.ctx.storage.setAlarm(Date.now() + NEGATIVE_TTL_MS);
        return;
      }
      await this.ctx.storage.put({
        scope,
        authority: { outcome, expiresAt },
        token: await encryptHeaders(
          { token },
          [this.env.NEXT_DEPLOYMENT_ID, scope],
          readRing(this.env.NEXT_TRANSPORT_KEYS),
        ),
      });
      await this.ctx.storage.setAlarm(Date.now() + 15_000);
    } catch {
      /* Fail closed without retaining an unverified token. */
    }
  }
}
export function nextOAuth(env: NextEnv) {
  return {
    verify: async (token: string): Promise<McpOAuthOutcome> => {
      if (!plausibleOAuthToken(token)) return { status: "invalid" };
      if (!env.EDGE_OAUTH) return { status: "unavailable" };
      const scope = await sha256Hex(token);
      return env.EDGE_OAUTH.get(
        env.EDGE_OAUTH.idFromName(
          JSON.stringify([env.NEXT_DEPLOYMENT_ID, scope]),
        ),
      ).read(token);
    },
  };
}
