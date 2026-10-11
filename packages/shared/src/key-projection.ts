export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type Sha256Hex = string;

export type RegistryKeyLifecycle = "active" | "grace" | "disabled" | "revoked";
export type KeyProvision = {
  secretSha256: Sha256Hex;
  clerkKeyId: string;
  clerkOrgId: string;
  ownerUserId: string;
  subjectUserId: string;
  budgetId: string;
  budgetRevision: number;
  lifecycle: "active" | "grace" | "disabled";
  monthlyCapCredits: number | null;
  graceUntil: number | null;
  expiresAt: number | null;
  scopes: string[];
};

export type VerifiedOneTimeExecutionKey = {
  keyId: string;
  secret: string;
  clerkOrgId: string;
  ownerUserId: string;
  subjectUserId: string;
  budgetId: string;
  budgetRevision: number;
  scopes: string[];
};

export type SealedExecutionKey = {
  oneTimeSecret: string;
  provision: KeyProvision;
};

export type RegistryVerifiedKeyProjection = {
  schemaVersion: 1;
  verifiedAt: number;
  provision: KeyProvision;
};

export type RegistryVerifiedKeyRotationProjection = {
  schemaVersion: 1;
  verifiedAt: number;
  operationId: string;
  oldKeyId: string;
  newProvision: KeyProvision;
  graceUntil: number;
};

const HEX_SHA256 = /^[a-f0-9]{64}$/;

const IDENTIFIER = /^[A-Za-z0-9_:./-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function codePointCompare(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const delta = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

function assertJsonValue(
  value: unknown,
  seen: Set<object>,
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Canonical JSON rejects non-finite numbers");
    return;
  }

  if (typeof value !== "object")
    throw new Error("Canonical JSON rejects unsupported values");
  if (seen.has(value)) throw new Error("Canonical JSON rejects cyclic values");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Canonical JSON accepts plain objects only");
    }

    for (const [key, item] of Object.entries(value)) {
      if (item === undefined)
        throw new Error(`Canonical JSON rejects undefined field ${key}`);
      assertJsonValue(item, seen);
    }
  }
  seen.delete(value);
}

function serializeCanonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(serializeCanonical).join(",")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object)
    .sort(codePointCompare)
    .map((key) => `${JSON.stringify(key)}:${serializeCanonical(object[key]!)}`)
    .join(",")}}`;
}

/** Deterministic JSON for the strict JSON value domain. */
export function canonicalJson(value: unknown): string {
  assertJsonValue(value, new Set());
  return serializeCanonical(value);
}

export function registryEncodedByteLength(value: unknown): number {
  const raw = typeof value === "string" ? value : canonicalJson(value);
  return new TextEncoder().encode(raw).byteLength;
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(new TextEncoder().encode(value));
}

function toHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function sha256Hex(value: string): Promise<Sha256Hex> {
  return toHex(await crypto.subtle.digest("SHA-256", utf8(value)));
}

function assertString(
  value: unknown,
  label: string,
  maxBytes = 256,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    registryEncodedByteLength(value) > maxBytes
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function assertId(
  value: unknown,
  label: string,
  maxBytes = 256,
): asserts value is string {
  assertString(value, label, maxBytes);
  if (!IDENTIFIER.test(value)) throw new Error(`${label} is invalid`);
}

function assertPositive(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new Error(`${label} must be a positive safe integer`);
}

function assertNullablePositive(value: unknown, label: string): void {
  if (value !== null) assertPositive(value, label);
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  label = "Registry value",
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} fields are invalid`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function validateHash(
  value: unknown,
  label: string,
): asserts value is Sha256Hex {
  if (typeof value !== "string" || !HEX_SHA256.test(value))
    throw new Error(`${label} is invalid`);
}

function validateLifecycle(
  value: unknown,
): asserts value is RegistryKeyLifecycle {
  if (!["active", "grace", "disabled", "revoked"].includes(String(value))) {
    throw new Error("Registry key lifecycle is invalid");
  }
}

function validateScopes(value: unknown): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 32 ||
    value.some(
      (scope) =>
        typeof scope !== "string" ||
        scope.length < 1 ||
        registryEncodedByteLength(scope) > 128 ||
        !IDENTIFIER.test(scope),
    )
  ) {
    throw new Error("Registry key scopes are invalid");
  }
}
function validateKeyProvision(value: unknown): void {
  const payload = record(value, "Key provision");
  assertKeys(payload, [
    "secretSha256",
    "clerkKeyId",
    "clerkOrgId",
    "ownerUserId",
    "subjectUserId",
    "budgetId",
    "budgetRevision",
    "lifecycle",
    "monthlyCapCredits",
    "graceUntil",
    "expiresAt",
    "scopes",
  ]);
  validateHash(payload.secretSha256, "Registry key secret hash");
  assertId(payload.clerkKeyId, "Registry Clerk key id");
  assertId(payload.clerkOrgId, "Registry Clerk organization id");
  assertId(payload.ownerUserId, "Registry key owner");
  assertId(payload.subjectUserId, "Registry key subject");
  if (payload.ownerUserId !== payload.subjectUserId)
    throw new Error("Registry key ownership is not verified");
  assertId(payload.budgetId, "Registry key budget id");
  if (payload.budgetId === payload.clerkOrgId)
    throw new Error(
      "Registry key budget must be independent from organization",
    );
  assertPositive(payload.budgetRevision, "Registry budget revision");
  validateLifecycle(payload.lifecycle);
  if (payload.lifecycle === "revoked")
    throw new Error("Registry key.put cannot be revoked");
  if (payload.monthlyCapCredits !== null)
    assertPositive(payload.monthlyCapCredits, "Registry monthly cap");
  assertNullablePositive(payload.graceUntil, "Registry grace time");
  assertNullablePositive(payload.expiresAt, "Registry key expiry");
  validateScopes(payload.scopes);
  if (payload.lifecycle === "grace" && payload.graceUntil === null)
    throw new Error("Registry grace key requires an expiry");
  return;
}

async function hmac(
  secret: string,
  message: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const length = new TextEncoder().encode(secret).byteLength;
  if (length < 32 || length > 4096)
    throw new Error("Registry signing secret must be 32-4096 UTF-8 bytes");
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return toHex(await crypto.subtle.sign("HMAC", key, message));
}

async function verifyHmac(
  secret: string,
  message: Uint8Array<ArrayBuffer>,
  expected: string,
): Promise<boolean> {
  if (!HEX_SHA256.test(expected)) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      utf8(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "HMAC",
      key,
      Uint8Array.from(expected.match(/.{2}/g)!, (pair) =>
        Number.parseInt(pair, 16),
      ) as Uint8Array<ArrayBuffer>,
      message,
    );
  } catch {
    return false;
  }
}

export function validateRegistryVerifiedKeyProjection(
  value: unknown,
): RegistryVerifiedKeyProjection {
  const projection = record(value, "Registry verified key projection");
  assertKeys(
    projection,
    ["schemaVersion", "verifiedAt", "provision"],
    [],
    "Registry verified key projection",
  );
  if (projection.schemaVersion !== 1)
    throw new Error("Registry verified key projection schema is invalid");
  assertPositive(
    projection.verifiedAt,
    "Registry verified key projection time",
  );
  validateKeyProvision(projection.provision);
  return projection as RegistryVerifiedKeyProjection;
}

export function validateRegistryVerifiedKeyRotationProjection(
  value: unknown,
): RegistryVerifiedKeyRotationProjection {
  const projection = record(value, "Registry verified key rotation projection");
  assertKeys(projection, [
    "schemaVersion",
    "verifiedAt",
    "operationId",
    "oldKeyId",
    "newProvision",
    "graceUntil",
  ]);
  if (projection.schemaVersion !== 1)
    throw new Error("Registry verified key rotation schema is invalid");
  assertPositive(projection.verifiedAt, "Registry verified key rotation time");
  assertId(projection.operationId, "Registry rotation operation");
  assertId(projection.oldKeyId, "Registry old key id");
  assertPositive(projection.graceUntil, "Registry key grace time");
  validateKeyProvision(projection.newProvision);
  const provision = projection.newProvision as KeyProvision;
  if (
    provision.clerkKeyId === projection.oldKeyId ||
    projection.graceUntil <= projection.verifiedAt
  )
    throw new Error("Registry verified key rotation is invalid");
  return projection as RegistryVerifiedKeyRotationProjection;
}

export async function sealOneTimeExecutionKey(
  issued: VerifiedOneTimeExecutionKey,
  settings: {
    lifecycle?: "active" | "grace" | "disabled";
    monthlyCapCredits?: number | null;
    graceUntil?: number | null;
    expiresAt?: number | null;
  } = {},
): Promise<SealedExecutionKey> {
  if (issued.ownerUserId !== issued.subjectUserId)
    throw new Error("Registry key ownership is not verified");
  assertString(issued.secret, "Execution key secret", 16_384);
  const provision: KeyProvision = {
    secretSha256: await sha256Hex(issued.secret),
    clerkKeyId: issued.keyId,
    clerkOrgId: issued.clerkOrgId,
    ownerUserId: issued.ownerUserId,
    subjectUserId: issued.subjectUserId,
    budgetId: issued.budgetId,
    budgetRevision: issued.budgetRevision,
    lifecycle: settings.lifecycle ?? "active",
    monthlyCapCredits: settings.monthlyCapCredits ?? null,
    graceUntil: settings.graceUntil ?? null,
    expiresAt: settings.expiresAt ?? null,
    scopes: [...issued.scopes],
  };
  validateKeyProvision(provision);
  return { oneTimeSecret: issued.secret, provision };
}

export async function signRegistryVerifiedKeyProjection(
  secret: string,
  projection: RegistryVerifiedKeyProjection,
): Promise<`v1=${string}`> {
  validateRegistryVerifiedKeyProjection(projection);
  return `v1=${await hmac(secret, utf8(`zevium-registry-key-projection-v1\0${canonicalJson(projection)}`))}`;
}

export async function verifyRegistryVerifiedKeyProjection(
  secret: string,
  projection: RegistryVerifiedKeyProjection,
  signature: string,
): Promise<boolean> {
  try {
    validateRegistryVerifiedKeyProjection(projection);
  } catch {
    return false;
  }
  return (
    signature.startsWith("v1=") &&
    (await verifyHmac(
      secret,
      utf8(`zevium-registry-key-projection-v1\0${canonicalJson(projection)}`),
      signature.slice(3),
    ))
  );
}

export async function signRegistryVerifiedKeyRotationProjection(
  secret: string,
  projection: RegistryVerifiedKeyRotationProjection,
): Promise<`v1=${string}`> {
  validateRegistryVerifiedKeyRotationProjection(projection);
  return `v1=${await hmac(secret, utf8(`zevium-registry-key-rotation-projection-v1\0${canonicalJson(projection)}`))}`;
}

export async function verifyRegistryVerifiedKeyRotationProjection(
  secret: string,
  projection: RegistryVerifiedKeyRotationProjection,
  signature: string,
): Promise<boolean> {
  try {
    validateRegistryVerifiedKeyRotationProjection(projection);
  } catch {
    return false;
  }
  return (
    signature.startsWith("v1=") &&
    (await verifyHmac(
      secret,
      utf8(
        `zevium-registry-key-rotation-projection-v1\0${canonicalJson(projection)}`,
      ),
      signature.slice(3),
    ))
  );
}
