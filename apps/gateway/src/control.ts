export type ControlPayload = {
  entityKey: string;
  sourceRevision: number;
  operation: string;
  publisherHandle?: string;
  projectSlug?: string;
  discoverable?: boolean;
  archived?: boolean;
};

type RouteGate = { allowed: boolean; sourceRevision: number };

/** Durable monotonic edge gate. One global instance keeps control ordering exact. */
export class ControlDO extends DurableObject<Cloudflare.Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/apply") {
      const payload = (await request.json()) as ControlPayload;
      if (
        !payload.entityKey ||
        !Number.isSafeInteger(payload.sourceRevision) ||
        payload.sourceRevision <= 0
      ) {
        return Response.json({ error: "invalid control" }, { status: 400 });
      }
      const revisionKey = `revision:${payload.entityKey}`;
      const current = (await this.ctx.storage.get<number>(revisionKey)) ?? 0;
      if (payload.sourceRevision <= current) {
        return Response.json({
          status: payload.sourceRevision === current ? "duplicate" : "stale",
        });
      }
      await this.ctx.storage.put(revisionKey, payload.sourceRevision);
      if (
        payload.publisherHandle &&
        (payload.operation === "org.state" ||
          payload.operation === "org.archive")
      ) {
        await this.ctx.storage.put<RouteGate>(
          `publisher:${payload.publisherHandle}`,
          {
            allowed: payload.archived !== true,
            sourceRevision: payload.sourceRevision,
          },
        );
      }
      if (payload.publisherHandle && payload.projectSlug) {
        const routeKey = `route:${payload.publisherHandle}/${payload.projectSlug}`;
        const allowed =
          payload.archived !== true &&
          payload.discoverable !== false &&
          !payload.operation.endsWith("archive");
        await this.ctx.storage.put<RouteGate>(routeKey, {
          allowed,
          sourceRevision: payload.sourceRevision,
        });
      }
      return Response.json({ status: "applied" });
    }
    if (request.method === "GET" && url.pathname === "/gate") {
      const route = url.searchParams.get("route");
      if (!route)
        return Response.json({ error: "route required" }, { status: 400 });
      const publisherHandle = route.split("/", 1)[0] ?? "";
      const publisher = await this.ctx.storage.get<RouteGate>(
        `publisher:${publisherHandle}`,
      );
      if (publisher?.allowed === false) return Response.json(publisher);
      const gate = await this.ctx.storage.get<RouteGate>(`route:${route}`);
      return Response.json(gate ?? null);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyControlRequest(
  request: Request,
  secret: string,
  now = Date.now(),
): Promise<{ payload: ControlPayload; body: string } | null> {
  const timestamp = request.headers.get("x-zevium-timestamp") ?? "";
  const nonce = request.headers.get("x-zevium-nonce") ?? "";
  const signature = request.headers.get("x-zevium-signature") ?? "";
  const digest = request.headers.get("x-zevium-control-digest") ?? "";
  const timestampMs = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampMs) ||
    Math.abs(now - timestampMs) > 5 * 60_000 ||
    nonce.length < 8 ||
    nonce.length > 200
  )
    return null;
  const body = await request.text();
  const bodyDigest = hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
  );
  if (digest !== `sha256=${bodyDigest}`) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const supplied = signature.startsWith("v1=") ? signature.slice(3) : "";
  if (!/^[0-9a-f]{64}$/i.test(supplied)) return null;
  const bytes = new Uint8Array(
    supplied.match(/.{2}/g)!.map((part) => Number.parseInt(part, 16)),
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    bytes,
    new TextEncoder().encode(`${timestamp}.${nonce}.${body}`),
  );
  if (!valid) return null;
  try {
    const payload = JSON.parse(body) as ControlPayload;
    return { payload, body };
  } catch {
    return null;
  }
}
import { DurableObject } from "cloudflare:workers";
