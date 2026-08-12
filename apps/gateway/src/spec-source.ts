/**
 * Published OpenAPI spec resolution for the gateway.
 * ConvexSpecSource calls public query specs:getPublishedForGateway.
 * CachedSpecSource wraps any source with a 30s TTL.
 */

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { trimTrailingSlashes } from "@zevium/shared";

export type PublishedSpec = {
  /** Raw OpenAPI JSON string. */
  spec: string;
  projectId: string;
  /** Exact immutable version selected by control plane. */
  specVersionId: string;
  version: string;
  /** Convex organizations table id (ledger / usage). */
  organizationId: string;
  /** Clerk org id — wallet DO idFromName key. */
  clerkOrgId: string;
  /**
   * Marketplace access: "public" projects accept any authenticated key;
   * "private" projects only accept keys whose org owns the project.
   */
  visibility: "public" | "private";
  /** Publisher-owned headers injected after consumer auth headers are stripped. */
  upstreamHeaders?: Record<string, string>;
  /** Epoch seconds when this spec version was deprecated (RFC 8594). Undefined when active. */
  deprecatedAt?: number;
  /** Epoch seconds when this spec version is scheduled for removal (RFC 8594 Sunset). */
  sunsetAt?: number;
  /** Human-readable deprecation reason surfaced to consumers (optional). */
  deprecationMessage?: string;
};

export interface SpecSource {
  getPublishedSpec(
    publisherHandle: string,
    projectSlug: string,
  ): Promise<PublishedSpec | null>;
}

export class SpecSourceUnavailableError extends Error {}

/** Production safety valve when the authenticated control-plane source is absent. */
export class FailClosedSpecSource implements SpecSource {
  async getPublishedSpec(): Promise<PublishedSpec | null> {
    return null;
  }
}

const DEFAULT_TTL_MS = 30_000;
const MEMORY_MAX = 256;

const getPublishedForGatewayRef = makeFunctionReference<
  "query",
  { publisherHandle: string; projectSlug: string },
  {
    spec: string;
    specVersionId: string;
    version: string;
    projectId: string;
    organizationId: string;
    clerkOrgId: string;
    visibility?: "public" | "private";
    deprecatedAt?: number;
    sunsetAt?: number;
    deprecationMessage?: string;
  } | null
>("specs:getPublishedForGateway");

type CacheEntry = {
  value: PublishedSpec | null;
  expiresAt: number;
};

export type CachedSpecSourceOptions = {
  inner: SpecSource;
  ttlMs?: number;
  now?: () => number;
};

/** Small TTL cache wrapping any SpecSource. */
export class CachedSpecSource implements SpecSource {
  readonly #inner: SpecSource;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(opts: CachedSpecSourceOptions) {
    this.#inner = opts.inner;
    this.#ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = opts.now ?? Date.now;
  }

  async getPublishedSpec(
    publisherHandle: string,
    projectSlug: string,
  ): Promise<PublishedSpec | null> {
    const key = `${publisherHandle}/${projectSlug}`;
    const now = this.#now();
    const hit = this.#cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    const value = await this.#inner.getPublishedSpec(
      publisherHandle,
      projectSlug,
    );
    if (this.#cache.size >= MEMORY_MAX) {
      const first = this.#cache.keys().next().value;
      if (first !== undefined) this.#cache.delete(first);
    }
    this.#cache.set(key, { value, expiresAt: now + this.#ttlMs });
    return value;
  }
}

export type ConvexSpecSourceOptions = {
  convexUrl: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Injected client (tests). */
  client?: ConvexHttpClient;
};

/**
 * Control-plane published-spec lookup via Convex HTTP client.
 * Function: specs:getPublishedForGateway (public query).
 */
export class ConvexSpecSource implements SpecSource {
  readonly #client: ConvexHttpClient;

  constructor(opts: ConvexSpecSourceOptions) {
    if (opts.client) {
      this.#client = opts.client;
    } else {
      this.#client = new ConvexHttpClient(opts.convexUrl, {
        skipConvexDeploymentUrlCheck: true,
        logger: false,
        fetch: opts.fetchImpl,
      });
    }
  }

  async getPublishedSpec(
    publisherHandle: string,
    projectSlug: string,
  ): Promise<PublishedSpec | null> {
    try {
      const value = await this.#client.query(getPublishedForGatewayRef, {
        publisherHandle,
        projectSlug,
      });
      return parsePublishedSpecPayload(value);
    } catch (err) {
      console.error("ConvexSpecSource.getPublishedSpec failed", err);
      return null;
    }
  }
}

export type InternalHttpSpecSourceOptions = {
  siteUrl: string;
  internalSecret: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
};

/** Gateway-only spec lookup. Shared-secret httpAction also returns upstream headers. */
export class InternalHttpSpecSource implements SpecSource {
  readonly #siteUrl: string;
  readonly #internalSecret: string;
  readonly #fetch: typeof fetch;

  constructor(opts: InternalHttpSpecSourceOptions) {
    this.#siteUrl = trimTrailingSlashes(opts.siteUrl);
    this.#internalSecret = opts.internalSecret;
    // Workerd's global fetch requires its receiver; storing the bare function
    // and invoking it as a private field throws "Illegal invocation".
    this.#fetch =
      opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async getPublishedSpec(
    publisherHandle: string,
    projectSlug: string,
  ): Promise<PublishedSpec | null> {
    const target = new URL(`${this.#siteUrl}/gateway-spec`);
    target.searchParams.set("publisherHandle", publisherHandle);
    target.searchParams.set("projectSlug", projectSlug);
    try {
      const response = await this.#fetch(target, {
        headers: { "x-internal-secret": this.#internalSecret },
      });
      if (response.status === 404) return null;
      if (!response.ok) {
        console.error("InternalHttpSpecSource.getPublishedSpec failed", {
          status: response.status,
        });
        throw new SpecSourceUnavailableError(
          "Internal spec source unavailable",
        );
      }
      return parsePublishedSpecPayload(await response.json());
    } catch (err) {
      if (err instanceof SpecSourceUnavailableError) throw err;
      console.error("InternalHttpSpecSource.getPublishedSpec failed", err);
      throw new SpecSourceUnavailableError("Internal spec source unavailable");
    }
  }
}

/** Accepts raw PublishedSpec, null, or Convex-shaped payloads. */
export function parsePublishedSpecPayload(json: unknown): PublishedSpec | null {
  if (json === null || json === undefined) return null;
  if (typeof json !== "object") return null;

  let candidate: unknown = json;
  if ("value" in json) {
    candidate = json.value;
  }

  if (candidate === null || candidate === undefined) return null;
  if (typeof candidate !== "object") return null;

  if (!("spec" in candidate) || typeof candidate.spec !== "string") return null;
  if (!("projectId" in candidate) || typeof candidate.projectId !== "string") {
    return null;
  }
  if (
    !("specVersionId" in candidate) ||
    typeof candidate.specVersionId !== "string" ||
    candidate.specVersionId.length === 0 ||
    !("version" in candidate) ||
    typeof candidate.version !== "string" ||
    candidate.version.length === 0
  ) {
    return null;
  }
  if (
    !("organizationId" in candidate) ||
    typeof candidate.organizationId !== "string"
  ) {
    return null;
  }

  // Prefer clerkOrgId; fall back to organizationId only when absent (legacy fixtures).
  let clerkOrgId: string;
  if ("clerkOrgId" in candidate && typeof candidate.clerkOrgId === "string") {
    clerkOrgId = candidate.clerkOrgId;
  } else {
    clerkOrgId = candidate.organizationId;
  }

  // Fail closed: unknown/absent visibility is never treated as public.
  let visibility: "public" | "private" = "private";
  if (
    "visibility" in candidate &&
    (candidate.visibility === "public" || candidate.visibility === "private")
  ) {
    visibility = candidate.visibility;
  }

  const published: PublishedSpec = {
    spec: candidate.spec,
    projectId: candidate.projectId,
    specVersionId: candidate.specVersionId,
    version: candidate.version,
    organizationId: candidate.organizationId,
    clerkOrgId,
    visibility,
  };
  if (
    "upstreamHeaders" in candidate &&
    candidate.upstreamHeaders !== null &&
    typeof candidate.upstreamHeaders === "object" &&
    !Array.isArray(candidate.upstreamHeaders)
  ) {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(candidate.upstreamHeaders)) {
      if (typeof value === "string") headers[name] = value;
    }
    published.upstreamHeaders = headers;
  }
  if (
    "deprecatedAt" in candidate &&
    typeof candidate.deprecatedAt === "number" &&
    Number.isFinite(candidate.deprecatedAt)
  ) {
    published.deprecatedAt = candidate.deprecatedAt;
  }
  if (
    "sunsetAt" in candidate &&
    typeof candidate.sunsetAt === "number" &&
    Number.isFinite(candidate.sunsetAt)
  ) {
    published.sunsetAt = candidate.sunsetAt;
  }
  if (
    "deprecationMessage" in candidate &&
    typeof candidate.deprecationMessage === "string"
  ) {
    published.deprecationMessage = candidate.deprecationMessage;
  }
  return published;
}

/** In-memory fixture for workerd tests. */
export class FixtureSpecSource implements SpecSource {
  readonly #specs: Map<string, PublishedSpec>;

  constructor(entries: Record<string, PublishedSpec> = {}) {
    this.#specs = new Map(Object.entries(entries));
  }

  set(
    publisherHandle: string,
    projectSlug: string,
    value: PublishedSpec,
  ): void {
    this.#specs.set(`${publisherHandle}/${projectSlug}`, value);
  }

  async getPublishedSpec(
    publisherHandle: string,
    projectSlug: string,
  ): Promise<PublishedSpec | null> {
    return this.#specs.get(`${publisherHandle}/${projectSlug}`) ?? null;
  }
}
