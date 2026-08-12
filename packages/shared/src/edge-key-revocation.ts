import { canonicalJson, sha256Hex } from "./registry-sync.js";

/** Security-owned immediate edge revocation. Independent of Registry receiver. */
export const EDGE_KEY_REVOCATION_SCHEMA_VERSION = 1 as const;
export const EDGE_KEY_REVOCATION_PATH =
  "/internal/key-revocation" as const;
export const EDGE_KEY_REVOCATION_MAX_BODY_BYTES = 8_192;
export const EDGE_KEY_REVOCATION_MAX_ACK_BYTES = 4_096;
export const EDGE_KEY_REVOCATION_MAX_CLOCK_SKEW_MS = 300_000;
export const EDGE_KEY_REVOCATION_TIMESTAMP_HEADER =
  "x-zevium-edge-timestamp" as const;
export const EDGE_KEY_REVOCATION_NONCE_HEADER =
  "x-zevium-edge-nonce" as const;
export const EDGE_KEY_REVOCATION_SIGNATURE_HEADER =
  "x-zevium-edge-signature" as const;
export const EDGE_KEY_REVOCATION_ACK_SIGNATURE_HEADER =
  "x-zevium-edge-ack-signature" as const;

export type EdgeKeyRevocationReason =
  | "membership_deleted"
  | "admin_revoked"
  | "rotated"
  | "provider_revoked"
  | "disabled";

export type EdgeKeyRevocationEvent = {
  schemaVersion: typeof EDGE_KEY_REVOCATION_SCHEMA_VERSION;
  eventId: string;
  clerkOrgId: string;
  keyId: string;
  revision: number;
  occurredAt: number;
  reason: EdgeKeyRevocationReason;
};

export type EdgeKeyRevocationAckStatus =
  | "applied"
  | "stale"
  | "rejected"
  | "duplicate";

export type EdgeKeyRevocationAck = {
  schemaVersion: typeof EDGE_KEY_REVOCATION_SCHEMA_VERSION;
  eventId: string;
  bodySha256: string;
  clerkOrgId: string;
  keyId: string;
  revision: number;
  status: EdgeKeyRevocationAckStatus;
  receiverRevision: number;
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function buffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  if (utf8(secret).byteLength < 32) {
    throw new Error("Edge revocation secret must be at least 32 bytes");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    buffer(utf8(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    buffer(utf8(message)),
  );
  return toHex(new Uint8Array(mac));
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function edgeKeyRevocationBody(
  event: EdgeKeyRevocationEvent,
): string {
  return canonicalJson(event);
}

export async function edgeKeyRevocationBodySha256(
  rawBody: string,
): Promise<string> {
  return await sha256Hex(rawBody);
}

export async function signEdgeKeyRevocationRequest(
  secret: string,
  timestamp: string,
  nonce: string,
  rawBody: string,
): Promise<`v1=${string}`> {
  const hex = await hmacHex(secret, `${timestamp}.${nonce}.${rawBody}`);
  return `v1=${hex}`;
}

export async function signEdgeKeyRevocationAck(
  secret: string,
  requestTimestamp: string,
  requestNonce: string,
  rawAckBody: string,
): Promise<`v1=${string}`> {
  const hex = await hmacHex(
    secret,
    `ack.${requestTimestamp}.${requestNonce}.${rawAckBody}`,
  );
  return `v1=${hex}`;
}

export async function verifyEdgeKeyRevocationRequest(
  secret: string,
  timestamp: string,
  nonce: string,
  rawBody: string,
  signatureHeader: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!/^\d{1,16}$/.test(timestamp) || timestamp.startsWith("0")) return false;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return false;
  const ts = Number(timestamp);
  if (!Number.isSafeInteger(ts)) return false;
  if (Math.abs(nowMs - ts) > EDGE_KEY_REVOCATION_MAX_CLOCK_SKEW_MS) return false;
  if (!signatureHeader.startsWith("v1=")) return false;
  const expected = await signEdgeKeyRevocationRequest(
    secret,
    timestamp,
    nonce,
    rawBody,
  );
  return timingSafeEqualHex(signatureHeader.slice(3), expected.slice(3));
}

export async function verifyEdgeKeyRevocationAck(
  secret: string,
  requestTimestamp: string,
  requestNonce: string,
  rawAckBody: string,
  signatureHeader: string,
): Promise<boolean> {
  if (!signatureHeader.startsWith("v1=")) return false;
  const expected = await signEdgeKeyRevocationAck(
    secret,
    requestTimestamp,
    requestNonce,
    rawAckBody,
  );
  return timingSafeEqualHex(signatureHeader.slice(3), expected.slice(3));
}

export function parseEdgeKeyRevocationEvent(
  value: unknown,
): EdgeKeyRevocationEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Edge key revocation event is invalid");
  }
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== EDGE_KEY_REVOCATION_SCHEMA_VERSION) {
    throw new Error("Edge key revocation schema is invalid");
  }
  if (
    typeof row.eventId !== "string" ||
    row.eventId.length < 8 ||
    row.eventId.length > 256 ||
    typeof row.clerkOrgId !== "string" ||
    row.clerkOrgId.length < 1 ||
    row.clerkOrgId.length > 256 ||
    typeof row.keyId !== "string" ||
    row.keyId.length < 1 ||
    row.keyId.length > 256 ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    typeof row.occurredAt !== "number" ||
    !Number.isSafeInteger(row.occurredAt) ||
    row.occurredAt <= 0 ||
    typeof row.reason !== "string"
  ) {
    throw new Error("Edge key revocation event fields are invalid");
  }
  const reason = row.reason as EdgeKeyRevocationReason;
  if (
    reason !== "membership_deleted" &&
    reason !== "admin_revoked" &&
    reason !== "rotated" &&
    reason !== "provider_revoked" &&
    reason !== "disabled"
  ) {
    throw new Error("Edge key revocation reason is invalid");
  }
  return {
    schemaVersion: EDGE_KEY_REVOCATION_SCHEMA_VERSION,
    eventId: row.eventId,
    clerkOrgId: row.clerkOrgId,
    keyId: row.keyId,
    revision: row.revision,
    occurredAt: row.occurredAt,
    reason,
  };
}

export function parseEdgeKeyRevocationAck(
  value: unknown,
): EdgeKeyRevocationAck {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Edge key revocation acknowledgement is invalid");
  }
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== EDGE_KEY_REVOCATION_SCHEMA_VERSION) {
    throw new Error("Edge key revocation acknowledgement schema is invalid");
  }
  if (
    typeof row.eventId !== "string" ||
    typeof row.bodySha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.bodySha256) ||
    typeof row.clerkOrgId !== "string" ||
    typeof row.keyId !== "string" ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    typeof row.receiverRevision !== "number" ||
    !Number.isSafeInteger(row.receiverRevision) ||
    typeof row.status !== "string"
  ) {
    throw new Error("Edge key revocation acknowledgement fields are invalid");
  }
  const status = row.status as EdgeKeyRevocationAckStatus;
  if (
    status !== "applied" &&
    status !== "stale" &&
    status !== "rejected" &&
    status !== "duplicate"
  ) {
    throw new Error("Edge key revocation acknowledgement status is invalid");
  }
  return {
    schemaVersion: EDGE_KEY_REVOCATION_SCHEMA_VERSION,
    eventId: row.eventId,
    bodySha256: row.bodySha256,
    clerkOrgId: row.clerkOrgId,
    keyId: row.keyId,
    revision: row.revision,
    status,
    receiverRevision: row.receiverRevision,
  };
}

export function ackMatchesEdgeKeyRevocationEvent(
  ack: EdgeKeyRevocationAck,
  event: EdgeKeyRevocationEvent,
  bodySha256: string,
): boolean {
  return (
    ack.eventId === event.eventId &&
    ack.bodySha256 === bodySha256 &&
    ack.clerkOrgId === event.clerkOrgId &&
    ack.keyId === event.keyId &&
    ack.revision === event.revision
  );
}
