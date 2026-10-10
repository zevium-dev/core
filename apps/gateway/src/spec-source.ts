/**
 * Published OpenAPI spec resolution for the gateway.
 * ConvexPublicSpecSource calls minimal public query specs:getPublishedForGateway.
 * CachedSpecSource wraps any source with a 30s TTL.
 */

import { queryConvex } from "./convex-http";
import { BoundedCache } from "./cache";
import { logDependencyFailure } from "./telemetry";
import { parseSpec, trimTrailingSlashes } from "@zevium/shared";

export type PublishedSpec = {
  /** Raw OpenAPI JSON string. */
  spec: string;
  /** Exact immutable version used for privacy-safe quality attribution. */
  specVersionId: string;
  projectId: string;
  /** Exact immutable version selected by control plane. */
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
  admission?: {
    mode: "open" | "entitled_only";
    policyRevision: number;
    allowed: boolean;
  };
  /** Epoch seconds when this spec version was deprecated (RFC 8594). Undefined when active. */
  deprecatedAt?: number;
  /** Epoch seconds when this spec version is scheduled for removal (RFC 8594 Sunset). */
  sunsetAt?: number;
  /** Human-readable deprecation reason surfaced to consumers (optional). */
  deprecationMessage?: string;
  /** Epoch milliseconds when cleanup retired this project. */
  retiredAt?: number;
};

export interface SpecSource {
  getPublishedSpec(
    publisherHandle: string,
    projectSlug: string,
    consumerClerkOrgId?: string,
  ): Promise<PublishedSpec | null>;
  invalidate?(publisherHandle?: string, projectSlug?: string): void;
}

export type PublicPublishedSpec = Pick<
  PublishedSpec,
  | "spec"
  | "visibility"
  | "deprecatedAt"
  | "sunsetAt"
  | "deprecationMessage"
  | "retiredAt"
> & { version?: string };

export interface PublicSpecSource {
  getPublishedSpec(
    publisherHandle: string,
    projectSlug: string,
  ): Promise<PublicPublishedSpec | null>;
  invalidate?(publisherHandle?: string, projectSlug?: string): void;
}

export class SpecSourceUnavailableError extends Error {}

const readableSpecs = new WeakMap<
  { spec: string },
  { spec: string; readable: boolean }
>();

/** Validate once per source payload; lifecycle metadata never enters the parsed cache. */
export function isPublishedSpecReadable(published: { spec: string }): boolean {
  const hit = readableSpecs.get(published);
  if (hit?.spec === published.spec) return hit.readable;
  let readable = false;
  try {
    JSON.parse(published.spec);
    readable = true;
  } catch {
    // Invalid payloads fail closed and never reach the proxy.
  }
  readableSpecs.set(published, { spec: published.spec, readable });
  return readable;
}

/** Public anonymous surfaces require explicit public visibility and a readable spec. */
export function isPublishedSpecPublic(published: PublicPublishedSpec): boolean {
  return (
    published.visibility === "public" && isPublishedSpecReadable(published)
  );
}

/** Production safety valve when the authenticated control-plane source is absent. */
export class FailClosedSpecSource implements SpecSource {
  async getPublishedSpec(): Promise<PublishedSpec | null> {
    return null;
  }
}

export class FailClosedPublicSpecSource implements PublicSpecSource {
  async getPublishedSpec(): Promise<PublicPublishedSpec | null> {
    return null;
  }
}

const DEFAULT_TTL_MS = 30_000;
const MEMORY_MAX = 256;

export type CachedSpecSourceOptions<
  T extends PublicPublishedSpec = PublishedSpec,
> = {
  inner: {
    getPublishedSpec(
      publisherHandle: string,
      projectSlug: string,
      consumerClerkOrgId?: string,
    ): Promise<T | null>;
  };
  ttlMs?: number;
  now?: () => number;
};

/** One cache layer for each source, shared by paid and anonymous route adapters. */
export class CachedSpecSource<T extends PublicPublishedSpec = PublishedSpec> {
  readonly #inner: CachedSpecSourceOptions<T>["inner"];
  readonly #cache: BoundedCache<T | null>;
  constructor(opts: CachedSpecSourceOptions<T>) {
    this.#inner = opts.inner;
    this.#cache = new BoundedCache(
      MEMORY_MAX,
      opts.ttlMs ?? DEFAULT_TTL_MS,
      opts.now,
    );
  }
  async getPublishedSpec(
    publisherHandle: string,
    projectSlug: string,
    consumerClerkOrgId?: string,
  ): Promise<T | null> {
    const key = `${publisherHandle}/${projectSlug}/${consumerClerkOrgId ?? ""}`;
    const hit = this.#cache.get(key);
    if (hit !== undefined) return hit;
    return this.#cache.set(
      key,
      await this.#inner.getPublishedSpec(
        publisherHandle,
        projectSlug,
        consumerClerkOrgId,
      ),
    );
  }
  invalidate(publisherHandle?: string, projectSlug?: string): void {
    // One route can have several consumer-specific eligibility snapshots.
    void publisherHandle;
    void projectSlug;
    this.#cache.invalidate();
  }
}

/** Immutable spec bytes identify the parsed version, across TTL metadata refreshes.
 * Bounded independently of route aliases; credentials and lifecycle stay on the source payload.
 */
const parsedSpecs = new BoundedCache<ReturnType<typeof parseSpec>>(
  64,
  Infinity,
);
export function getParsedSpec(published: {
  spec: string;
}): ReturnType<typeof parseSpec> {
  const hit = parsedSpecs.get(published.spec);
  return hit ?? parsedSpecs.set(published.spec, parseSpec(published.spec));
}

export type ConvexPublicSpecSourceOptions = {
  convexUrl: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
};

/**
 * Control-plane published-spec lookup via the Convex public HTTP API.
 * Function: specs:getPublishedForGateway (public query).
 */
export class ConvexPublicSpecSource implements PublicSpecSource {
  constructor(readonly options: ConvexPublicSpecSourceOptions) {}

  async getPublishedSpec(
    publisherHandle: string,
    projectSlug: string,
  ): Promise<PublicPublishedSpec | null> {
    try {
      const value = await queryConvex(
        this.options.convexUrl,
        "specs:getPublishedForGateway",
        {
          publisherHandle,
          projectSlug,
        },
        this.options.fetchImpl,
      );

      return parsePublicPublishedSpecPayload(value);
    } catch {
      logDependencyFailure("public_spec_source");
      return null;
    }
  }
}

export function parsePublicPublishedSpecPayload(
  json: unknown,
): PublicPublishedSpec | null {
  if (json === null || json === undefined || typeof json !== "object") {
    return null;
  }
  let candidate: unknown = json;
  if ("value" in json) candidate = json.value;
  if (candidate === null || typeof candidate !== "object") return null;
  if (!("spec" in candidate) || typeof candidate.spec !== "string") return null;
  if (!("visibility" in candidate) || candidate.visibility !== "public") {
    return null;
  }
  const published: PublicPublishedSpec = {
    spec: candidate.spec,
    visibility: "public",
  };
  if ("version" in candidate && typeof candidate.version === "string") {
    published.version = candidate.version;
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
  if (
    "retiredAt" in candidate &&
    typeof candidate.retiredAt === "number" &&
    Number.isFinite(candidate.retiredAt)
  ) {
    published.retiredAt = candidate.retiredAt;
  }
  if (!isPublishedSpecReadable(published)) return null;
  return published;
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
    consumerClerkOrgId?: string,
  ): Promise<PublishedSpec | null> {
    const target = new URL(`${this.#siteUrl}/gateway-spec`);
    target.searchParams.set("publisherHandle", publisherHandle);
    target.searchParams.set("projectSlug", projectSlug);
    if (consumerClerkOrgId)
      target.searchParams.set("consumerClerkOrgId", consumerClerkOrgId);
    try {
      const response = await this.#fetch(target, {
        headers: { "x-internal-secret": this.#internalSecret },
      });
      if (response.status === 404) return null;
      if (!response.ok) {
        logDependencyFailure("internal_spec_source", response.status);
        throw new SpecSourceUnavailableError(
          "Internal spec source unavailable",
        );
      }
      const published = parsePublishedSpecPayload(await response.json());
      if (published && !published.admission)
        throw new SpecSourceUnavailableError("Admission policy unavailable");
      return published;
    } catch (err) {
      if (err instanceof SpecSourceUnavailableError) throw err;
      logDependencyFailure("internal_spec_source");
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
    specVersionId: candidate.specVersionId,
    projectId: candidate.projectId,
    version: candidate.version,
    organizationId: candidate.organizationId,
    clerkOrgId,
    visibility,
  };
  if ("admission" in candidate) {
    const policy = candidate.admission;
    if (
      !policy ||
      typeof policy !== "object" ||
      !("mode" in policy) ||
      (policy.mode !== "open" && policy.mode !== "entitled_only") ||
      !("policyRevision" in policy) ||
      typeof policy.policyRevision !== "number" ||
      !Number.isSafeInteger(policy.policyRevision) ||
      policy.policyRevision < 1 ||
      !("allowed" in policy) ||
      typeof policy.allowed !== "boolean"
    )
      return null;
    published.admission = {
      mode: policy.mode,
      policyRevision: policy.policyRevision,
      allowed: policy.allowed,
    };
  }
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
  if (
    "retiredAt" in candidate &&
    typeof candidate.retiredAt === "number" &&
    Number.isFinite(candidate.retiredAt)
  ) {
    published.retiredAt = candidate.retiredAt;
  }
  if (!isPublishedSpecReadable(published)) return null;
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
