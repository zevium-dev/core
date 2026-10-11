import { z } from "zod";
import {
  readBoundedJson,
  validInternalSecret,
} from "@zevium/shared/edge/transport";
import type { NextEnv } from "./snapshots";

/** Control-plane retries wake cold wallets. This receipt is never a drain ACK. */
export function wakeWallet(request: Request, env: NextEnv) {
  return walletControl(request, env, "wake");
}
export function readWalletFailure(request: Request, env: NextEnv) {
  return walletControl(request, env, "failure");
}
async function walletControl(
  request: Request,
  env: NextEnv,
  action: "wake" | "failure",
) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (
    !(await validInternalSecret(
      request.headers.get("x-internal-secret"),
      env.GATEWAY_INTERNAL_SECRET,
    ))
  )
    return new Response("Unauthorized", { status: 401 });
  try {
    const body = await readBoundedJson(
      request,
      z.strictObject({
        clerkOrgId: z.string().min(1).max(256),
        deploymentId: z.string().min(1).max(512),
        ...(action === "failure"
          ? { settleRefId: z.string().min(1).max(512) }
          : {}),
      }),
      4096,
    );
    if (!env.NEXT_WALLET || body.deploymentId !== env.NEXT_DEPLOYMENT_ID)
      return new Response("Wallet control unavailable", { status: 503 });
    const wallet = env.NEXT_WALLET.get(
      env.NEXT_WALLET.idFromName(
        JSON.stringify([env.NEXT_DEPLOYMENT_ID, body.clerkOrgId]),
      ),
    );
    if (action === "failure") {
      const evidence = await wallet.failureEvidence(
        z.string().parse(body.settleRefId),
      );
      return Response.json(evidence, {
        status: evidence ? 200 : 404,
        headers: { "cache-control": "no-store" },
      });
    }
    await wallet.wake(body.clerkOrgId);
    return new Response(null, { status: 202 });
  } catch {
    return new Response("Invalid wallet control request", { status: 400 });
  }
}
