/**
 * Published OpenAPI spec resolution for the gateway.
 * ConvexSpecSource calls public query specs:getPublishedForGateway.
 * CachedSpecSource wraps any source with a 30s TTL.
 */

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

export type PublishedSpec = {
  /** Raw OpenAPI JSON string. */
  spec: string;
  projectId: string;
  /** Convex organizations table id (ledger / usage). */
  organizationId: string;
  /** Clerk org id — wallet DO idFromName key. */
  clerkOrgId: string;
};

export interface SpecSource {
  getPublishedSpec(
    orgSlug: string,
    projectSlug: string,
  ): Promise<PublishedSpec | null>;
}

const DEFAULT_TTL_MS = 30_000;
const MEMORY_MAX = 256;

const getPublishedForGatewayRef = makeFunctionReference<
  "query",
  { orgSlug: string; projectSlug: string },
  {
    spec: string;
    projectId: string;
    organizationId: string;
    clerkOrgId: string;
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
    orgSlug: string,
    projectSlug: string,
  ): Promise<PublishedSpec | null> {
    const key = `${orgSlug}/${projectSlug}`;
    const now = this.#now();
    const hit = this.#cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    const value = await this.#inner.getPublishedSpec(orgSlug, projectSlug);
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
    orgSlug: string,
    projectSlug: string,
  ): Promise<PublishedSpec | null> {
    try {
      const value = await this.#client.query(getPublishedForGatewayRef, {
        orgSlug,
        projectSlug,
      });
      return parsePublishedSpecPayload(value);
    } catch (err) {
      console.error("ConvexSpecSource.getPublishedSpec failed", err);
      return null;
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

  return {
    spec: candidate.spec,
    projectId: candidate.projectId,
    organizationId: candidate.organizationId,
    clerkOrgId,
  };
}

/** In-memory fixture for workerd tests. */
export class FixtureSpecSource implements SpecSource {
  readonly #specs: Map<string, PublishedSpec>;

  constructor(entries: Record<string, PublishedSpec> = {}) {
    this.#specs = new Map(Object.entries(entries));
  }

  set(orgSlug: string, projectSlug: string, value: PublishedSpec): void {
    this.#specs.set(`${orgSlug}/${projectSlug}`, value);
  }

  async getPublishedSpec(
    orgSlug: string,
    projectSlug: string,
  ): Promise<PublishedSpec | null> {
    return this.#specs.get(`${orgSlug}/${projectSlug}`) ?? null;
  }
}
