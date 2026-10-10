import { MACHINE_SESSION_SECONDS, machineWalletId } from "@zevium/shared";
import type { VerifiedKey } from "./key-verifier";
const PREFIX = "zev_ws_";
const encoder = new TextEncoder();
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function decode(value: string): Uint8Array {
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
}
async function key(secret: string) {
  if (secret.length < 32) throw new Error("Session signing unavailable");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function issueWalletSession(
  secret: string,
  audience: string,
  network: string,
  payer: string,
  now = Date.now(),
): Promise<string> {
  const body = encode(
    encoder.encode(
      JSON.stringify({
        v: 1,
        aud: audience,
        sub: machineWalletId(network, payer),
        scope: "gateway:public",
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + MACHINE_SESSION_SECONDS,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    encoder.encode(body),
  );
  return PREFIX + body + "." + encode(new Uint8Array(signature));
}
export function isWalletSession(value: string): boolean {
  return value.startsWith(PREFIX);
}
export async function verifyWalletSession(
  token: string,
  secret: string,
  audience: string,
  now = Date.now(),
): Promise<VerifiedKey | null> {
  try {
    if (!token.startsWith(PREFIX) || token.length > 2048) return null;
    const parts = token.slice(PREFIX.length).split(".");
    if (parts.length !== 2) return null;
    const [body, signature] = parts as [string, string];
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await key(secret),
        decode(signature),
        encoder.encode(body),
      ))
    )
      return null;
    const c = JSON.parse(new TextDecoder().decode(decode(body))) as Record<
      string,
      unknown
    >;
    const seconds = Math.floor(now / 1000);
    if (
      c.v !== 1 ||
      c.aud !== audience ||
      c.scope !== "gateway:public" ||
      typeof c.sub !== "string" ||
      !/^x402:eip155:[0-9]+:0x[0-9a-f]{40}$/.test(c.sub) ||
      typeof c.exp !== "number" ||
      typeof c.iat !== "number" ||
      !Number.isSafeInteger(c.exp) ||
      !Number.isSafeInteger(c.iat) ||
      c.exp <= seconds ||
      c.iat > seconds ||
      c.exp - c.iat !== MACHINE_SESSION_SECONDS
    )
      return null;
    return { orgId: c.sub, keyId: c.sub, scopes: ["gateway:public"] };
  } catch {
    return null;
  }
}
