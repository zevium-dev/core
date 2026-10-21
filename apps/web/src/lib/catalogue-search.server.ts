import { getRequest } from "@tanstack/react-start/server";

import { searchRead, type SearchRead } from "@zevium/shared/edge/read";
import {
  anonymousSearchKey,
  trustedClientIp,
} from "@zevium/shared/edge/search-identity";
import { readBoundedJson } from "@zevium/shared/edge/transport";

/** Only an actual Cloudflare request supplies trustworthy connection metadata. */
export async function trustedCatalogueSearch(
  query: string,
): Promise<SearchRead> {
  const degraded: SearchRead = { items: [], degraded: true },
    request = getRequest();
  const settings = process.env;
  const secret = settings.NEXT_WEB_SEARCH_SECRET,
    site = settings.CONVEX_SITE_URL;
  const ip = trustedClientIp(request);
  if (!site || !secret || ip === null) return degraded;
  try {
    const anonymousKey = await anonymousSearchKey(secret, ip);
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
