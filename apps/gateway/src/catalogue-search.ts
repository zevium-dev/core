/** Semantic discovery via the authenticated control-plane route. No result cache:
 * each request must pass caller admission and recheck listing visibility. */
import { trimTrailingSlashes } from "@zevium/shared";
import { parseCataloguePage, type CatalogueListing } from "./catalogue-source";
import type { VerifiedKey } from "./key-verifier";

export type CatalogueSearchResult = {
  items: CatalogueListing[];
  degraded: boolean;
};
export interface CatalogueSearchSource {
  search(
    query: string,
    caller?: Pick<VerifiedKey, "orgId" | "keyId">,
  ): Promise<CatalogueSearchResult>;
}

export class InternalHttpCatalogueSearch implements CatalogueSearchSource {
  constructor(
    readonly options: {
      siteUrl: string;
      internalSecret: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async search(
    query: string,
    caller?: Pick<VerifiedKey, "orgId" | "keyId">,
  ): Promise<CatalogueSearchResult> {
    try {
      const response = await (this.options.fetchImpl ?? fetch)(
        `${trimTrailingSlashes(this.options.siteUrl)}/gateway-search`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": this.options.internalSecret,
          },
          body: JSON.stringify({ query, caller }),
          // Leave time for keyword fallback within the MCP tool's 10s deadline.
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!response.ok) return { items: [], degraded: true };
      const body: unknown = await response.json();
      if (
        typeof body !== "object" ||
        body === null ||
        !("degraded" in body) ||
        typeof body.degraded !== "boolean"
      ) {
        return { items: [], degraded: true };
      }
      const page = parseCataloguePage(body);
      if (page === null) return { items: [], degraded: true };
      return { items: page.items.slice(0, 10), degraded: body.degraded };
    } catch {
      return { items: [], degraded: true };
    }
  }
}
