import { getRequest } from "@tanstack/react-start/server";

import { searchRead, type SearchRead } from "@zevium/shared/edge/read";
import { readBoundedJson } from "@zevium/shared/edge/transport";
export function searchNetwork(ip: string): string {
  if (!ip.includes(":")) return ip;
  const canonical = new URL(`https://[${ip}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const words =
    right === undefined
      ? head
      : [
          ...head,
          ...Array<string>(8 - head.length - tail.length).fill("0"),
          ...tail,
        ];
  return `${words
    .slice(0, 4)
    .map((w) => w.padStart(4, "0"))
    .join(":")}/64`;
}
/** Only an actual Cloudflare request supplies trustworthy connection metadata. */
export async function trustedCatalogueSearch(
  query: string,
): Promise<SearchRead> {
  const degraded: SearchRead = { items: [], degraded: true },
    request = getRequest();
  const settings = process.env;
  const secret = settings.NEXT_WEB_SEARCH_SECRET,
    site = settings.NEXT_CONVEX_SITE_URL;
  const ip =
    "cf" in request && request.cf && request.headers.get("cf-connecting-ip");
  if (!site || !secret || typeof ip !== "string" || ip.length > 64)
    return degraded;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(searchNetwork(ip)),
    );
    const anonymousKey = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    const response = await fetch(new URL("/web-search", site), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": secret,
      },
      body: JSON.stringify({ query, anonymousKey, limit: 20 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return degraded;
    return await readBoundedJson(
      new Request("https://internal.invalid", {
        method: "POST",
        body: response.body,
        headers: response.headers,
        duplex: "half",
      } as RequestInit),
      searchRead,
      262144,
    );
  } catch {
    return degraded;
  }
}
