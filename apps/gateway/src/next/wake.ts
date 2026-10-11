import { z } from "zod";
import {
  readBoundedJson,
  validInternalSecret,
} from "@zevium/shared/edge/transport";
import type { NextEnv } from "./snapshots";

/** Control-plane retries wake cold wallets. This receipt is never a drain ACK. */
export async function wakeWallet(request: Request, env: NextEnv) {
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
      }),
      4096,
    );
    if (
      env.CONTROL_PLANE_MODE !== "next" ||
      !env.NEXT_WALLET ||
      body.deploymentId !== env.NEXT_DEPLOYMENT_ID
    )
      return new Response("Wake unavailable", { status: 503 });
    await env.NEXT_WALLET.get(
      env.NEXT_WALLET.idFromName(
        JSON.stringify([env.NEXT_DEPLOYMENT_ID, body.clerkOrgId]),
      ),
    ).wake(body.clerkOrgId);
    return new Response(null, { status: 202 });
  } catch {
    return new Response("Invalid wake request", { status: 400 });
  }
}
