import {
  EDGE_KEY_REVOCATION_ACK_SIGNATURE_HEADER,
  EDGE_KEY_REVOCATION_MAX_ACK_BYTES,
  EDGE_KEY_REVOCATION_NONCE_HEADER,
  EDGE_KEY_REVOCATION_PATH,
  EDGE_KEY_REVOCATION_SCHEMA_VERSION,
  EDGE_KEY_REVOCATION_SIGNATURE_HEADER,
  EDGE_KEY_REVOCATION_TIMESTAMP_HEADER,
  ackMatchesEdgeKeyRevocationEvent,
  edgeKeyRevocationBody,
  edgeKeyRevocationBodySha256,
  parseEdgeKeyRevocationAck,
  sha256Hex,
  signEdgeKeyRevocationRequest,
  verifyEdgeKeyRevocationAck,
  type EdgeKeyRevocationEvent,
  type EdgeKeyRevocationReason,
} from "@zevium/shared";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";

const DELIVERY_LEASE_MS = 30_000;
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_RETRY_MS = 15 * 60_000;

function backoffMs(attempts: number): number {
  const exp = Math.min(MAX_RETRY_MS, 1_000 * 2 ** Math.max(0, attempts - 1));
  return exp;
}

/**
 * Bump monotonic edge revision and enqueue durable signed revocation. Caller
 * must already have disabled the local key projection in the same mutation.
 */
export async function enqueueEdgeKeyRevocation(
  ctx: MutationCtx,
  row: Doc<"keySettings">,
  reason: EdgeKeyRevocationReason,
): Promise<{ eventId: string; revision: number }> {
  const now = Date.now();
  const revision = (row.edgeRevision ?? 0) + 1;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Edge revocation revision is exhausted");
  }
  await ctx.db.patch(row._id, {
    edgeRevision: revision,
    updatedAt: now,
  });
  const eventId = `ekr_${(await sha256Hex(`${row.keyId}:${revision}`)).slice(0, 40)}`;
  const event: EdgeKeyRevocationEvent = {
    schemaVersion: EDGE_KEY_REVOCATION_SCHEMA_VERSION,
    eventId,
    clerkOrgId: row.clerkOrgId,
    keyId: row.keyId,
    revision,
    occurredAt: now,
    reason,
  };
  const bodyJson = edgeKeyRevocationBody(event);
  const bodySha256 = await edgeKeyRevocationBodySha256(bodyJson);
  const existing = await ctx.db
    .query("edgeKeyRevocationOutbox")
    .withIndex("by_key_revision", (q) =>
      q.eq("keyId", row.keyId).eq("revision", revision),
    )
    .unique();
  if (existing !== null) {
    if (existing.status !== "acked") {
      await ctx.db.patch(existing._id, {
        status: "pending",
        leaseToken: undefined,
        leaseUntil: undefined,
        nextAttemptAt: now,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.edgeKeyRevocation.dispatch, {
        outboxId: existing._id,
      });
    }
    return { eventId: existing.eventId, revision };
  }
  const outboxId = await ctx.db.insert("edgeKeyRevocationOutbox", {
    eventId,
    clerkOrgId: row.clerkOrgId,
    keyId: row.keyId,
    revision,
    reason,
    bodyJson,
    bodySha256,
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.edgeKeyRevocation.dispatch, {
    outboxId,
  });
  return { eventId, revision };
}

export const claim = internalMutation({
  args: {
    outboxId: v.id("edgeKeyRevocationOutbox"),
    leaseToken: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.leaseToken.length < 16 || args.leaseToken.length > 128) {
      throw new Error("Edge revocation lease is invalid");
    }
    const row = await ctx.db.get(args.outboxId);
    if (row === null || row.status === "acked") return null;
    const now = Date.now();
    if (row.status === "delivering" && (row.leaseUntil ?? 0) > now) {
      return null;
    }
    if (row.status === "pending" && row.nextAttemptAt > now) {
      await ctx.scheduler.runAfter(
        row.nextAttemptAt - now,
        internal.edgeKeyRevocation.dispatch,
        { outboxId: row._id },
      );
      return null;
    }
    await ctx.db.patch(row._id, {
      status: "delivering",
      attempts: row.attempts + 1,
      leaseToken: args.leaseToken,
      leaseUntil: now + DELIVERY_LEASE_MS,
      updatedAt: now,
    });
    return {
      eventId: row.eventId,
      clerkOrgId: row.clerkOrgId,
      keyId: row.keyId,
      revision: row.revision,
      bodyJson: row.bodyJson,
      bodySha256: row.bodySha256,
      attempts: row.attempts + 1,
    };
  },
});

export const markAcked = internalMutation({
  args: {
    outboxId: v.id("edgeKeyRevocationOutbox"),
    leaseToken: v.string(),
    ackJson: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.outboxId);
    if (row === null) return;
    if (row.status === "acked") return;
    if (row.leaseToken !== args.leaseToken) return;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "acked",
      ackJson: args.ackJson,
      leaseToken: undefined,
      leaseUntil: undefined,
      lastErrorCode: undefined,
      ackedAt: now,
      updatedAt: now,
    });
  },
});

export const markFailed = internalMutation({
  args: {
    outboxId: v.id("edgeKeyRevocationOutbox"),
    leaseToken: v.string(),
    errorCode: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.outboxId);
    if (row === null || row.status === "acked") return;
    if (row.leaseToken !== args.leaseToken) return;
    const now = Date.now();
    const nextAttemptAt = now + backoffMs(row.attempts);
    await ctx.db.patch(row._id, {
      status: "pending",
      leaseToken: undefined,
      leaseUntil: undefined,
      lastErrorCode: args.errorCode.slice(0, 128),
      nextAttemptAt,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      nextAttemptAt - now,
      internal.edgeKeyRevocation.dispatch,
      { outboxId: row._id },
    );
  },
});

export const scheduleDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("edgeKeyRevocationOutbox")
      .withIndex("by_status_next", (q) =>
        q.eq("status", "pending").lte("nextAttemptAt", now),
      )
      .take(25);
    const stale = await ctx.db
      .query("edgeKeyRevocationOutbox")
      .withIndex("by_status_lease", (q) =>
        q.eq("status", "delivering").lte("leaseUntil", now),
      )
      .take(25);
    for (const row of [...due, ...stale]) {
      await ctx.scheduler.runAfter(0, internal.edgeKeyRevocation.dispatch, {
        outboxId: row._id,
      });
    }
    return { scheduled: due.length + stale.length };
  },
});

function edgeEndpoint(): URL {
  const base =
    process.env.GATEWAY_EDGE_REVOCATION_BASE_URL ??
    process.env.GATEWAY_REGISTRY_SYNC_BASE_URL ??
    process.env.GATEWAY_URL;
  if (base === undefined || base.trim() === "") {
    throw new Error("Edge revocation endpoint is not configured");
  }
  const url = new URL(EDGE_KEY_REVOCATION_PATH, base);
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      ))
  ) {
    throw new Error("Edge revocation endpoint is invalid");
  }
  return url;
}

async function readAckBody(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > EDGE_KEY_REVOCATION_MAX_ACK_BYTES) {
    throw new Error("ack_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("ack_empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > EDGE_KEY_REVOCATION_MAX_ACK_BYTES) {
      await reader.cancel();
      throw new Error("ack_too_large");
    }
    chunks.push(chunk.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(body);
}

export const dispatch = internalAction({
  args: { outboxId: v.id("edgeKeyRevocationOutbox") },
  handler: async (ctx, args): Promise<void> => {
    const leaseToken = crypto.randomUUID().replaceAll("-", "");
    const event = await ctx.runMutation(internal.edgeKeyRevocation.claim, {
      outboxId: args.outboxId,
      leaseToken,
    });
    if (event === null) return;
    try {
      const secret =
        process.env.GATEWAY_EDGE_REVOCATION_HMAC_SECRET ??
        process.env.GATEWAY_INTERNAL_SECRET ??
        "";
      if (secret.length < 32) {
        throw new Error("secret_missing");
      }
      const timestamp = String(Date.now());
      const nonce = crypto.randomUUID().replaceAll("-", "");
      const signature = await signEdgeKeyRevocationRequest(
        secret,
        timestamp,
        nonce,
        event.bodyJson,
      );
      const response = await fetch(edgeEndpoint(), {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          [EDGE_KEY_REVOCATION_TIMESTAMP_HEADER]: timestamp,
          [EDGE_KEY_REVOCATION_NONCE_HEADER]: nonce,
          [EDGE_KEY_REVOCATION_SIGNATURE_HEADER]: signature,
        },
        body: event.bodyJson,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`http_${response.status}`);
      }
      const rawAck = await readAckBody(response);
      const ackSignature =
        response.headers.get(EDGE_KEY_REVOCATION_ACK_SIGNATURE_HEADER) ?? "";
      const ackOk = await verifyEdgeKeyRevocationAck(
        secret,
        timestamp,
        nonce,
        rawAck,
        ackSignature,
      );
      if (!ackOk) throw new Error("ack_signature");
      const ack = parseEdgeKeyRevocationAck(JSON.parse(rawAck) as unknown);
      const eventBody = JSON.parse(event.bodyJson) as EdgeKeyRevocationEvent;
      if (
        !ackMatchesEdgeKeyRevocationEvent(ack, eventBody, event.bodySha256)
      ) {
        throw new Error("ack_identity");
      }
      if (
        ack.status !== "applied" &&
        ack.status !== "stale" &&
        ack.status !== "duplicate"
      ) {
        throw new Error(`ack_status_${ack.status}`);
      }
      await ctx.runMutation(internal.edgeKeyRevocation.markAcked, {
        outboxId: args.outboxId,
        leaseToken,
        ackJson: rawAck,
      });
    } catch (error) {
      const code =
        error instanceof Error ? error.message.slice(0, 64) : "delivery_failed";
      console.error(
        JSON.stringify({
          schema: 1,
          type: "zevium.dependency_failure",
          component: "edge_key_revocation",
          code: "delivery_failed",
        }),
      );
      await ctx.runMutation(internal.edgeKeyRevocation.markFailed, {
        outboxId: args.outboxId,
        leaseToken,
        errorCode: code,
      });
    }
  },
});
