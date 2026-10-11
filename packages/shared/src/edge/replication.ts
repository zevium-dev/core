import { z } from "zod";
import { checkpoint, freezeRequest, snapshot } from "./snapshots";
import { identity, integer, digest } from "./money";
import { canonical, fingerprint, sign, verify } from "./transport";

export const signingRing = z.strictObject({
  current: identity,
  keys: z.record(identity, z.string().min(32)),
});
export function readRing(raw: string | undefined) {
  const ring = signingRing.parse(JSON.parse(raw ?? "null"));
  if (!Object.hasOwn(ring.keys, ring.current))
    throw new Error("Missing signing key");
  return ring;
}
export const projection = z.strictObject({
  deploymentId: identity,
  kind: z.enum(["org", "keys", "route", "catalogue", "wallet"]),
  scope: identity,
  revision: integer,
  generationId: identity,
  generatedAt: integer,
  expiresAt: integer,
  nonce: identity,
  keyId: identity,
  payloadDigest: digest,
  payload: z.unknown(),
  signature: digest,
});
export type Projection = z.infer<typeof projection>;
export const walletPage = z.strictObject({
  checkpoint,
  freeze: freezeRequest.optional(),
});
export type WalletPage = z.infer<typeof walletPage>;
export type Checkpoint = z.infer<typeof checkpoint>;
export type KeyPolicy = Checkpoint["keyPolicies"][number];
export type RoutePayload = Extract<
  z.infer<typeof snapshot>,
  { kind: "route" }
>["payload"];
export async function sealProjection(
  facts: Omit<Projection, "signature" | "payloadDigest" | "keyId">,
  ring: ReturnType<typeof readRing>,
): Promise<Projection> {
  const value = {
    ...facts,
    keyId: ring.current,
    payloadDigest: await fingerprint(facts.payload),
  };
  return projection.parse({
    ...value,
    signature: await sign(value, ring.keys[ring.current]!),
  });
}
export async function openProjection(
  input: unknown,
  expected: {
    deploymentId: string;
    kind: Projection["kind"];
    scope: string;
    nonce: string;
    minimumRevision: number;
    now: number;
    keys: Record<string, string>;
  },
): Promise<Projection> {
  const p = projection.parse(input),
    { signature, ...facts } = p;
  // Tolerate 1s of issuance clock skew only. Expiry remains exact.
  if (
    p.deploymentId !== expected.deploymentId ||
    p.kind !== expected.kind ||
    p.scope !== expected.scope ||
    p.nonce !== expected.nonce ||
    p.revision < expected.minimumRevision ||
    p.generatedAt > expected.now + 1000 ||
    p.expiresAt <= expected.now ||
    p.expiresAt <= p.generatedAt ||
    p.expiresAt - p.generatedAt > (p.kind === "catalogue" ? 60_000 : 30_000) ||
    !Object.hasOwn(expected.keys, p.keyId) ||
    p.payloadDigest !== (await fingerprint(p.payload)) ||
    !(await verify(facts, signature, expected.keys[p.keyId]!))
  )
    throw new Error("Projection rejected");
  return p;
}
const bytes = (s: string) => new TextEncoder().encode(s);
const b64 = (b: Uint8Array) => {
  let text = "";
  for (let offset = 0; offset < b.length; offset += 8192)
    text += String.fromCharCode(...b.subarray(offset, offset + 8192));
  return btoa(text);
};
const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export type TransportEnvelope = {
  format: "aes-gcm-aad-v1";
  ciphertext: string;
  iv: string;
  keyVersion: string;
};
async function transportKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", bytes(secret)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
export async function encryptHeaders(
  headers: Record<string, string>,
  binding: unknown,
  ring: ReturnType<typeof readRing>,
): Promise<TransportEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: bytes(
        canonical(["edge-headers:v2", binding, ring.current]),
      ),
    },
    await transportKey(ring.keys[ring.current]!),
    bytes(JSON.stringify(headers)),
  );
  return {
    format: "aes-gcm-aad-v1",
    ciphertext: b64(new Uint8Array(ciphertext)),
    iv: b64(iv),
    keyVersion: ring.current,
  };
}
export async function decryptHeaders(
  envelope: TransportEnvelope,
  binding: unknown,
  ring: ReturnType<typeof readRing>,
) {
  if (!Object.hasOwn(ring.keys, envelope.keyVersion))
    throw new Error("Transport key unavailable");
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decode(envelope.iv),
      additionalData: bytes(
        canonical(["edge-headers:v2", binding, envelope.keyVersion]),
      ),
    },
    await transportKey(ring.keys[envelope.keyVersion]!),
    decode(envelope.ciphertext),
  );
  return z
    .record(z.string(), z.string())
    .parse(JSON.parse(new TextDecoder().decode(plaintext)));
}
