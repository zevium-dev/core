import type { HttpRouter } from "convex/server";
import {
  CONNECTION_CALLBACK_PATH,
  CONNECTION_PENDING_TTL_MS,
  buildAuthorizationUrl,
  getOAuthProvider,
  isConnectionId,
  isSafeReturnUrl,
  isSchemeName,
  normalizeConnectionLabel,
} from "@zevium/shared";

import { validInternalSecret } from "../contracts/transport";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { connectionSecretBinding, encryptSecret } from "./lib/credentialCrypto";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const MAX_ID = 256;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function authorized(request: Request): Promise<boolean> {
  return await validInternalSecret(
    request.headers.get("x-internal-secret"),
    process.env.GATEWAY_INTERNAL_SECRET,
  );
}

async function readBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function optionalStr(value: unknown, max: number): boolean {
  return value === undefined || str(value, max);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );
}

export async function stateHash(state: string): Promise<string> {
  return [...(await sha256(state))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function random(bytes: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(bytes));
}

function isCallbackUri(value: unknown): value is string {
  if (!isSafeReturnUrl(value)) return false;
  const url = new URL(value);
  return (
    url.pathname === CONNECTION_CALLBACK_PATH &&
    url.search === "" &&
    url.hash === ""
  );
}

/** Gateway-only connection routes; all require the internal secret. */
export function registerConnectionRoutes(http: HttpRouter): void {
  http.route({
    path: "/connections-start",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!(await authorized(request)))
        return json({ error: "unauthorized" }, 401);
      const body = await readBody(request);
      const label = normalizeConnectionLabel(body?.label);
      if (
        body === null ||
        !str(body.orgId, MAX_ID) ||
        !str(body.keyId, MAX_ID) ||
        !str(body.projectId, MAX_ID) ||
        !str(body.api, 2 * MAX_ID) ||
        (body.scheme !== undefined && !isSchemeName(body.scheme)) ||
        label === false ||
        (body.returnUrl !== undefined && !isSafeReturnUrl(body.returnUrl)) ||
        !isCallbackUri(body.redirectUri)
      ) {
        return json({ error: "invalid_body" }, 400);
      }
      const start = await ctx.runQuery(internal.connections.prepareStart, {
        clerkOrgId: body.orgId,
        projectId: body.projectId,
        scheme: body.scheme as string | undefined,
      });
      if (!start.ok) return json({ error: start.error }, 200);

      const provider = getOAuthProvider(start.provider)!;
      const connectionId = `conn_${base32(random(16))}`;
      const state = base64Url(random(32));
      const verifier = provider.pkce ? base64Url(random(32)) : null;
      const pendingExpiresAt = Date.now() + CONNECTION_PENDING_TTL_MS;
      const connection = await ctx.runMutation(
        internal.connections.createPending,
        {
          publicId: connectionId,
          clerkOrgId: body.orgId,
          projectId: body.projectId,
          api: body.api,
          scheme: start.scheme,
          provider: start.provider,
          ...(label === null ? {} : { label }),
          requestedScopes: start.scopes,
          createdByKeyId: body.keyId,
          redirectUri: body.redirectUri,
          ...(body.returnUrl === undefined
            ? {}
            : { returnUrl: body.returnUrl as string }),
          stateHash: await stateHash(state),
          ...(verifier === null
            ? {}
            : {
                codeVerifier: await encryptSecret(
                  verifier,
                  connectionSecretBinding(connectionId, "verifier"),
                ),
              }),
          pendingExpiresAt,
        },
      );
      return json(
        {
          connection,
          authorizationUrl: buildAuthorizationUrl({
            provider,
            clientId: start.clientId,
            redirectUri: body.redirectUri,
            state,
            codeChallenge:
              verifier === null ? null : base64Url(await sha256(verifier)),
            scopes: start.scopes,
          }),
          expiresAt: pendingExpiresAt,
        },
        200,
      );
    }),
  });

  http.route({
    path: "/connections-callback",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!(await authorized(request)))
        return json({ error: "unauthorized" }, 401);
      const body = await readBody(request);
      if (
        body === null ||
        !str(body.state, 512) ||
        !optionalStr(body.code, 4096) ||
        !optionalStr(body.error, 128)
      ) {
        return json({ error: "invalid_body" }, 400);
      }
      return json(
        await ctx.runAction(internal.connectionsNode.completeAuthorization, {
          stateHash: await stateHash(body.state),
          ...(body.code === undefined ? {} : { code: body.code as string }),
          ...(body.error === undefined ? {} : { error: body.error as string }),
        }),
        200,
      );
    }),
  });

  http.route({
    path: "/connections-list",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!(await authorized(request)))
        return json({ error: "unauthorized" }, 401);
      const body = await readBody(request);
      if (
        body === null ||
        !str(body.orgId, MAX_ID) ||
        (body.connectionId !== undefined && !isConnectionId(body.connectionId))
      ) {
        return json({ error: "invalid_body" }, 400);
      }
      if (body.connectionId === undefined) {
        return json(
          {
            connections: await ctx.runQuery(internal.connections.listForOrg, {
              clerkOrgId: body.orgId,
            }),
          },
          200,
        );
      }
      return json(
        {
          connection: await ctx.runQuery(internal.connections.getForOrg, {
            clerkOrgId: body.orgId,
            connectionId: body.connectionId as string,
          }),
        },
        200,
      );
    }),
  });

  http.route({
    path: "/connections-revoke",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!(await authorized(request)))
        return json({ error: "unauthorized" }, 401);
      const body = await readBody(request);
      if (
        body === null ||
        !str(body.orgId, MAX_ID) ||
        !isConnectionId(body.connectionId)
      ) {
        return json({ error: "invalid_body" }, 400);
      }
      return json(
        {
          connection: await ctx.runMutation(internal.connections.revoke, {
            clerkOrgId: body.orgId,
            connectionId: body.connectionId,
          }),
        },
        200,
      );
    }),
  });

  /** Cold path behind the gateway's token cache; refreshes when due. */
  http.route({
    path: "/gateway-connection-token",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!(await authorized(request)))
        return json({ error: "unauthorized" }, 401);
      const body = await readBody(request);
      if (
        body === null ||
        !str(body.orgId, MAX_ID) ||
        !str(body.projectId, MAX_ID) ||
        !isSchemeName(body.scheme) ||
        (body.connectionId !== undefined && !isConnectionId(body.connectionId))
      ) {
        return json({ error: "invalid_body" }, 400);
      }
      const select = () =>
        ctx.runQuery(internal.connections.selectForGateway, {
          clerkOrgId: body.orgId as string,
          projectId: body.projectId as string,
          scheme: body.scheme as string,
          ...(body.connectionId === undefined
            ? {}
            : { connectionId: body.connectionId as string }),
          now: Date.now(),
        });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const selection = await select();
        if (selection.status !== "refresh") return json(selection, 200);
        const refreshed = await ctx.runAction(
          internal.connectionsNode.refresh,
          {
            connectionId: selection.connectionId,
            tokenRevision: selection.tokenRevision,
          },
        );
        if (refreshed.status === "ok") {
          return json(
            { connectionId: selection.connectionId, ...refreshed },
            200,
          );
        }
        if (refreshed.status === "reauthorize") {
          return json({ status: "connection_reauthorize" }, 200);
        }
        if (refreshed.status === "unavailable") break;
        // Another request holds the lease; its result is usually ready shortly.
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      return json({ error: "connection_unavailable" }, 503);
    }),
  });
}
