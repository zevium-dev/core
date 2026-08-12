/**
 * Machine-readable discovery index — GET /discovery.
 * Catalogue listings + per-endpoint pricing from published specs.
 */

import {
  extractPricing,
  isOpenApiPublicCopyAllowed,
  isPublicCopyAllowed,
  parseSpec,
  type HttpMethod,
  type ParsedOpenApiSpec,
} from "@zevium/shared";
import { listAllPublic, type CatalogueSource } from "./catalogue-source";
import type { SpecSource } from "./spec-source";

const HTTP_METHODS: readonly HttpMethod[] = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
];

export type DiscoveryEndpoint = {
  method: string;
  path: string;
  credits: number;
  summary?: string;
  freeTier?: number;
};

export type DiscoveryApi = {
  name: string;
  publisherHandle: string;
  slug: string;
  description: string | undefined;
  gatewayBaseUrl: string;
  endpoints: DiscoveryEndpoint[];
};

export type DiscoveryIndex = {
  apis: DiscoveryApi[];
};

export type DiscoveryDeps = {
  catalogueSource: CatalogueSource;
  specSource: SpecSource;
  /** Origin used to build gatewayBaseUrl, e.g. https://gateway.zevium.dev */
  gatewayOrigin: string;
};

/** Extract priced endpoints from a parsed OpenAPI document. */
export function endpointsFromSpec(
  spec: ParsedOpenApiSpec,
): DiscoveryEndpoint[] {
  const out: DiscoveryEndpoint[] = [];
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const pricing = extractPricing(op);
      const endpoint: DiscoveryEndpoint = {
        method: method.toUpperCase(),
        path,
        credits: pricing.cost,
      };
      if (typeof op.summary === "string" && op.summary.length > 0) {
        endpoint.summary = op.summary;
      }
      if (pricing.freeTier !== undefined) {
        endpoint.freeTier = pricing.freeTier;
      }
      out.push(endpoint);
    }
  }
  return out;
}

/** Build discovery index from catalogue + published specs. */
export async function buildDiscoveryIndex(
  deps: DiscoveryDeps,
): Promise<DiscoveryIndex> {
  const items = await listAllPublic(deps.catalogueSource);
  const apis: DiscoveryApi[] = [];

  for (const item of items) {
    if (
      !isPublicCopyAllowed(
        [item.name, item.description ?? "", ...item.tags, item.orgName].join(
          "\n",
        ),
      )
    ) {
      continue;
    }
    const published = await deps.specSource.getPublishedSpec(
      item.publisherHandle,
      item.slug,
    );
    let endpoints: DiscoveryEndpoint[] = [];
    if (published) {
      if (!isOpenApiPublicCopyAllowed(published.spec)) continue;
      try {
        const parsed = parseSpec(published.spec);
        endpoints = endpointsFromSpec(parsed);
      } catch {
        continue;
      }
    }

    const origin = deps.gatewayOrigin.replace(/\/+$/, "");
    apis.push({
      name: item.name,
      publisherHandle: item.publisherHandle,
      slug: item.slug,
      description: item.description,
      gatewayBaseUrl: `${origin}/gateway/${item.publisherHandle}/${item.slug}`,
      endpoints,
    });
  }

  return { apis };
}

export async function handleDiscoveryRequest(
  request: Request,
  deps: DiscoveryDeps,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json(
      { error: "method_not_allowed", message: "GET only" },
      { status: 405 },
    );
  }

  const index = await buildDiscoveryIndex(deps);
  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=60",
      },
    });
  }

  return new Response(JSON.stringify(index), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=60",
    },
  });
}
