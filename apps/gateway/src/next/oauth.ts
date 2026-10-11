import { DurableObject } from "cloudflare:workers";
import { decodeJwt } from "jose";
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
import type { NextEnv } from "./snapshots";
/** Provider/JWKS and identity fetches run only on the background alarm. Tokens
 * are encrypted at rest; consumers get at most 30s of verified authority. */
export class EdgeOAuthDO extends DurableObject<NextEnv> {
  async read(token: string): Promise<McpOAuthOutcome> {
    if (token.length > 16_384) return { status: "invalid" };
    const scope = await sha256Hex(token),
      old = await this.ctx.storage.get<string>("scope");
    if (old && old !== scope) throw new Error("OAuth scope mismatch");
    if (!old)
      await this.ctx.storage.put({
        scope,
        token: await encryptHeaders(
          { token },
          [this.env.NEXT_DEPLOYMENT_ID, scope],
          readRing(this.env.NEXT_TRANSPORT_KEYS),
        ),
      });
    await this.ctx.storage.put("lastRead", Date.now());
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + 1);
    const state = await this.ctx.storage.get<{
      outcome: McpOAuthOutcome;
      expiresAt: number;
    }>("authority");
    return state && state.expiresAt > Date.now()
      ? state.outcome
      : { status: "unavailable" };
  }
  async alarm() {
    if (
      Date.now() - ((await this.ctx.storage.get<number>("lastRead")) ?? 0) >
      60_000
    ) {
      await this.ctx.storage.delete(["token", "scope", "authority"]);
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + 15_000);
    try {
      const scope = (await this.ctx.storage.get<string>("scope"))!,
        envelope = (await this.ctx.storage.get<TransportEnvelope>("token"))!;
      const { token } = await decryptHeaders(
        envelope,
        [this.env.NEXT_DEPLOYMENT_ID, scope],
        readRing(this.env.NEXT_TRANSPORT_KEYS),
      );
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
          const response = await fetch(input, init);
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
      await this.ctx.storage.put("authority", { outcome, expiresAt });
    } catch {
      await this.ctx.storage.delete("authority");
    }
  }
}
export function nextOAuth(env: NextEnv) {
  return {
    verify: async (token: string): Promise<McpOAuthOutcome> => {
      if (!env.EDGE_OAUTH || token.length > 16_384)
        return { status: "unavailable" };
      const scope = await sha256Hex(token);
      return env.EDGE_OAUTH.get(
        env.EDGE_OAUTH.idFromName(
          JSON.stringify([env.NEXT_DEPLOYMENT_ID, scope]),
        ),
      ).read(token);
    },
  };
}
