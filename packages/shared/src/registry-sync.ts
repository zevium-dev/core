export const REGISTRY_SYNC_SCHEMA_VERSION = 1 as const;

export type RegistrySyncOperation =
  | "route.upsert"
  | "route.archive"
  | "key.upsert"
  | "key.state"
  | "org.archive"
  | "catalogue.replace";

export type RegistryRouteSnapshot = {
  spec: string;
  version: string;
  projectId: string;
  organizationId: string;
  clerkOrgId: string;
  visibility: "private" | "public";
  upstreamHeaders: Record<string, string>;
  deprecatedAt?: number;
  sunsetAt?: number;
  deprecationMessage?: string;
};

export type RegistryKeySetting = {
  disabled: boolean;
  monthlyCapCredits?: number;
  rotatedFromKeyId?: string;
  graceUntil?: number;
};

export type RegistryKeyLifecycle = "active" | "disabled" | "grace" | "revoked";

export type RegistrySyncPayloadMap = {
  "route.upsert": {
    publisherHandle: string;
    projectSlug: string;
    snapshot: RegistryRouteSnapshot;
  };
  "route.archive": {
    publisherHandle: string;
    projectSlug: string;
  };
  "key.upsert": {
    keyId: string;
    orgId: string;
    setting: RegistryKeySetting;
  };
  "key.state": {
    keyId: string;
    orgId: string;
    budgetId: string;
    lifecycle: RegistryKeyLifecycle;
    monthlyCapCredits?: number;
    graceUntil?: number;
  };
  "org.archive": {
    clerkOrgId: string;
    publisherHandle?: string;
  };
  "catalogue.replace": {
    items: unknown[];
  };
};

export type RegistrySyncEnvelope<
  Operation extends RegistrySyncOperation = RegistrySyncOperation,
> = RegistrySyncPayloadMap[Operation] & {
  schemaVersion: typeof REGISTRY_SYNC_SCHEMA_VERSION;
  operation: Operation;
  sourceRevision: number;
  occurredAt: number;
  nonce: string;
  payloadDigest: string;
};

export type RegistrySyncAck = {
  status: "applied" | "duplicate" | "stale";
  operation: RegistrySyncOperation;
  sourceRevision: number;
  clerkOrgId?: string;
  publisherHandle?: string;
  projectSlug?: string;
  keyId?: string;
};

export type RegistrySyncPathOverrides = Partial<
  Record<RegistrySyncOperation, string>
>;

const DEFAULT_PATHS: Record<RegistrySyncOperation, string> = {
  "route.upsert": "/internal/registry/v1/route",
  "route.archive": "/internal/registry/v1/route/archive",
  "key.upsert": "/internal/registry/v1/key",
  "key.state": "/internal/registry/v1/key/state",
  "org.archive": "/internal/registry/v1/org/archive",
  "catalogue.replace": "/internal/registry/v1/catalogue",
};

function assertJsonValue(value: unknown, seen: Set<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Canonical JSON rejects non-finite numbers");
    return;
  }
  if (typeof value !== "object") {
    throw new Error("Canonical JSON rejects unsupported values");
  }
  if (seen.has(value)) throw new Error("Canonical JSON rejects cyclic values");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Canonical JSON accepts plain objects only");
    }
    for (const item of Object.values(value)) {
      if (item === undefined) continue;
      assertJsonValue(item, seen);
    }
  }
  seen.delete(value);
}

function serializeCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("Canonical JSON rejects unsupported values");
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonical(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${serializeCanonical((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

/** Stable key ordering and strict JSON-domain validation for signed payloads. */
export function canonicalJson(value: unknown): string {
  assertJsonValue(value, new Set());
  return serializeCanonical(value);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function buffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(bytes(value)))),
  );
}

export async function registryPayloadDigest(
  operation: RegistrySyncOperation,
  payload: unknown,
): Promise<string> {
  return await sha256Hex(canonicalJson({ operation, payload }));
}

/** Exact v1 request MAC: timestamp + nonce + raw canonical body. */
export async function signRegistrySyncRequest(
  secret: string,
  timestamp: string,
  nonce: string,
  rawBody: string,
): Promise<`v1=${string}`> {
  if (bytes(secret).byteLength < 32) {
    throw new Error("Registry sync secret must be at least 32 bytes");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    buffer(bytes(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    buffer(bytes(`${timestamp}.${nonce}.${rawBody}`)),
  );
  return `v1=${toHex(new Uint8Array(mac))}`;
}

export function registrySyncPath(
  operation: RegistrySyncOperation,
  overrides: RegistrySyncPathOverrides = {},
): string {
  const path = overrides[operation] ?? DEFAULT_PATHS[operation];
  if (!path.startsWith("/internal/registry/v1/") || path.includes("?")) {
    throw new Error(`Registry sync path for ${operation} is invalid`);
  }
  return path;
}
