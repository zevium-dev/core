import { z } from "zod";
import {
  admission,
  admittedRequest,
  type Admission,
  type Settlement,
} from "./settlement";
import { snapshot, type Snapshot } from "./snapshots";

/** Canonical JSON deliberately rejects non-JSON and unsafe numeric facts. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported fingerprint value");
}
const bytes = (s: string) => new TextEncoder().encode(s);
const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
export async function fingerprint(value: unknown): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes(canonical(value))));
}
async function key(secret: string) {
  if (bytes(secret).length < 32)
    throw new Error("Signing key must contain at least 32 bytes");
  return crypto.subtle.importKey(
    "raw",
    bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function sign(value: unknown, secret: string): Promise<string> {
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      await key(secret),
      bytes(canonical(value)),
    ),
  );
}
export async function verify(
  value: unknown,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const signatureBytes = Uint8Array.from(signature.match(/../g)!, (x) =>
    Number.parseInt(x, 16),
  );
  return crypto.subtle.verify(
    "HMAC",
    await key(secret),
    signatureBytes,
    bytes(canonical(value)),
  );
}
/** Native HMAC verification avoids early-exit byte/string secret comparison. */
export async function validInternalSecret(
  provided: string | null,
  expected: string | undefined,
): Promise<boolean> {
  if (
    !expected ||
    expected.length < 32 ||
    provided === null ||
    provided.length < 32 ||
    provided.length > 4096
  )
    return false;
  return verify(
    "zevium:internal-secret:v2",
    await sign("zevium:internal-secret:v2", expected),
    provided,
  );
}
export function admissionFacts(value: Admission | Settlement): Admission {
  const facts = Object.fromEntries(
    Object.keys(admission.shape)
      .filter((k) => value[k as keyof Admission] !== undefined)
      .map((k) => [k, value[k as keyof Admission]]),
  );
  return admittedRequest.parse(facts);
}
export async function admissionFingerprint(
  value: Admission | Settlement,
  secret: string,
): Promise<string> {
  return sign(
    { purpose: "admission:v2", facts: admissionFacts(value) },
    secret,
  );
}
export async function verifyAdmission(
  value: Settlement,
  secret: string,
): Promise<boolean> {
  return verify(
    { purpose: "admission:v2", facts: admissionFacts(value) },
    value.admissionFingerprint,
    secret,
  );
}
export async function verifySnapshot(
  input: unknown,
  expected: {
    deploymentId: string;
    kind: Snapshot["kind"];
    scope: string;
    nonce: string;
    minimumRevision: number;
    now: number;
    keys: Readonly<Record<string, string>>;
  },
): Promise<Snapshot> {
  const s = snapshot.parse(input);
  if (
    s.deploymentId !== expected.deploymentId ||
    s.kind !== expected.kind ||
    s.scope !== expected.scope ||
    s.nonce !== expected.nonce ||
    s.revision < expected.minimumRevision ||
    s.generatedAt > expected.now + 1000 ||
    s.expiresAt <= expected.now
  )
    throw new Error("Snapshot authority rejected");
  const secret = Object.hasOwn(expected.keys, s.keyId)
    ? expected.keys[s.keyId]
    : undefined;
  const { signature, ...facts } = s;
  if (
    typeof secret !== "string" ||
    s.payloadDigest !== (await fingerprint(s.payload)) ||
    !(await verify(facts, signature, secret))
  )
    throw new Error("Snapshot signature rejected");
  return s;
}
export class BoundaryError extends Error {
  constructor(
    readonly status: 400 | 401 | 413,
    message: string,
  ) {
    super(message);
  }
}
/** Content-Length is only an early check; stream bytes enforce actual bound. */
export async function readBoundedJson<T>(
  request: Request,
  validator: z.ZodType<T>,
  maxBytes = 1_048_576,
): Promise<T> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))
    throw new BoundaryError(413, "Request too large");
  if (!request.body) throw new BoundaryError(400, "Invalid request");
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new BoundaryError(413, "Request too large");
      }
      chunks.push(value);
    }
    const all = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return validator.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(all),
      ),
    );
  } catch (error) {
    if (error instanceof BoundaryError) throw error;
    throw new BoundaryError(400, "Invalid request");
  } finally {
    reader.releaseLock();
  }
}
