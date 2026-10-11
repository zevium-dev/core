import { BoundedCache } from "./cache";

import { parseSpec } from "@zevium/shared";

export type PublishedSpec = {
  /** Canonical edge types and protocol helpers. Authority comes from signed snapshots. */
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
