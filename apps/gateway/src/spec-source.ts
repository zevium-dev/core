/**
 * Published OpenAPI spec resolution for the gateway.
 * ConvexSpecSource is a stub until wave-2 functions land; FixtureSpecSource for tests.
 */

export type PublishedSpec = {
  /** Raw OpenAPI JSON string. */
  spec: string;
  projectId: string;
  organizationId: string;
};

export interface SpecSource {
  getPublishedSpec(
    orgSlug: string,
    projectSlug: string,
  ): Promise<PublishedSpec | null>;
}

const DEFAULT_TTL_MS = 30_000;
const MEMORY_MAX = 256;

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
};

/**
 * Stub: hits `${CONVEX_URL}` with a placeholder path.
 * Real Convex function arrives wave 2 — until then returns null on any response
 * that is not the expected shape (or always null in prod without the function).
 */
export class ConvexSpecSource implements SpecSource {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(opts: ConvexSpecSourceOptions) {
    this.#baseUrl = opts.convexUrl.replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async getPublishedSpec(
    orgSlug: string,
    projectSlug: string,
  ): Promise<PublishedSpec | null> {
    // Placeholder HTTP action path — wave 2 replaces with real Convex query URL.
    const url = `${this.#baseUrl}/api/query`;
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "projects:getPublishedSpec",
          args: { orgSlug, projectSlug },
          format: "json",
        }),
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return null;
    }

    return parsePublishedSpecPayload(json);
  }
}

/** Accepts either raw PublishedSpec or Convex { value: PublishedSpec | null }. */
export function parsePublishedSpecPayload(json: unknown): PublishedSpec | null {
  if (!json || typeof json !== "object") return null;

  let candidate: unknown = json;
  if ("value" in json) {
    candidate = json.value;
  } else if ("status" in json && "value" in json) {
    candidate = json.value;
  }

  if (candidate === null) return null;
  if (!candidate || typeof candidate !== "object") return null;
  if (!("spec" in candidate) || typeof candidate.spec !== "string") return null;
  if (!("projectId" in candidate) || typeof candidate.projectId !== "string")
    return null;
  if (
    !("organizationId" in candidate) ||
    typeof candidate.organizationId !== "string"
  )
    return null;

  return {
    spec: candidate.spec,
    projectId: candidate.projectId,
    organizationId: candidate.organizationId,
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
