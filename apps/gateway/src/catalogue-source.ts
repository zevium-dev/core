/**
 * Public catalogue resolution for discovery + MCP search.
 * ConvexCatalogueSource calls public query catalogue:listPublic.
 * CachedCatalogueSource wraps any source with a 60s TTL.
 */

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { isPublicCopyAllowed } from "@zevium/shared";

export type CatalogueListing = {
  projectId: string;
  name: string;
  slug: string;
  description: string | undefined;
  tags: string[];
  organizationId: string;
  orgName: string;
  publisherHandle: string;
  publishedAt: number | null;
};

export type CataloguePage = {
  items: CatalogueListing[];
  nextCursor: string | null;
};

export type CatalogueListArgs = {
  search?: string;
  tag?: string;
  cursor?: string;
};

export interface CatalogueSource {
  listPublic(args?: CatalogueListArgs): Promise<CataloguePage>;
}

/** Read every catalogue page while preserving caller filters. */
export async function listAllPublic(
  source: CatalogueSource,
  args: Omit<CatalogueListArgs, "cursor"> = {},
): Promise<CatalogueListing[]> {
  const items: CatalogueListing[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = await source.listPublic({ ...args, cursor });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor === undefined || seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
  } while (true);

  return items;
}

/** Production safety valve when the Convex public catalogue is unavailable. */
export class FailClosedCatalogueSource implements CatalogueSource {
  async listPublic(): Promise<CataloguePage> {
    return { items: [], nextCursor: null };
  }
}

const DEFAULT_TTL_MS = 60_000;
const MEMORY_MAX = 64;

const listPublicRef = makeFunctionReference<
  "query",
  { search?: string; tag?: string; cursor?: string },
  {
    items: Array<{
      projectId: string;
      name: string;
      slug: string;
      description?: string;
      tags: string[];
      organizationId: string;
      orgName: string;
      publisherHandle: string;
      publishedAt: number | null;
    }>;
    nextCursor: string | null;
  }
>("catalogue:listPublic");

type CacheEntry = {
  value: CataloguePage;
  expiresAt: number;
};

export type CachedCatalogueSourceOptions = {
  inner: CatalogueSource;
  ttlMs?: number;
  now?: () => number;
};

function cacheKey(args: CatalogueListArgs | undefined): string {
  const search = args?.search ?? "";
  const tag = args?.tag ?? "";
  const cursor = args?.cursor ?? "";
  return `${search}\0${tag}\0${cursor}`;
}

/** Small TTL cache wrapping any CatalogueSource (default 60s). */
export class CachedCatalogueSource implements CatalogueSource {
  readonly #inner: CatalogueSource;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(opts: CachedCatalogueSourceOptions) {
    this.#inner = opts.inner;
    this.#ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = opts.now ?? Date.now;
  }

  async listPublic(args?: CatalogueListArgs): Promise<CataloguePage> {
    const key = cacheKey(args);
    const now = this.#now();
    const hit = this.#cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    const value = await this.#inner.listPublic(args);
    if (this.#cache.size >= MEMORY_MAX) {
      const first = this.#cache.keys().next().value;
      if (first !== undefined) this.#cache.delete(first);
    }
    this.#cache.set(key, { value, expiresAt: now + this.#ttlMs });
    return value;
  }
}

export type ConvexCatalogueSourceOptions = {
  convexUrl: string;
  fetchImpl?: typeof fetch;
  client?: ConvexHttpClient;
};

/**
 * Control-plane public catalogue via Convex HTTP client.
 * Function: catalogue:listPublic (public query, no auth).
 */
export class ConvexCatalogueSource implements CatalogueSource {
  readonly #client: ConvexHttpClient;

  constructor(opts: ConvexCatalogueSourceOptions) {
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

  async listPublic(args?: CatalogueListArgs): Promise<CataloguePage> {
    try {
      const value = await this.#client.query(listPublicRef, {
        search: args?.search,
        tag: args?.tag,
        cursor: args?.cursor,
      });
      return parseCataloguePage(value) ?? { items: [], nextCursor: null };
    } catch (err) {
      console.error("ConvexCatalogueSource.listPublic failed", err);
      return { items: [], nextCursor: null };
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumberOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function parseListing(raw: unknown): CatalogueListing | null {
  if (!isRecord(raw)) return null;

  const projectId = asString(raw.projectId);
  const name = asString(raw.name);
  const slug = asString(raw.slug);
  const organizationId = asString(raw.organizationId);
  const orgName = asString(raw.orgName);
  const publisherHandle = asString(raw.publisherHandle);
  if (
    projectId === undefined ||
    name === undefined ||
    slug === undefined ||
    organizationId === undefined ||
    orgName === undefined ||
    publisherHandle === undefined
  ) {
    return null;
  }

  const description = asString(raw.description);
  const tags: string[] = [];
  if (Array.isArray(raw.tags)) {
    for (const t of raw.tags) {
      if (typeof t === "string") tags.push(t);
    }
  }

  const publishedAt = asNumberOrNull(raw.publishedAt);
  if (
    !isPublicCopyAllowed(
      [name, slug, description ?? "", ...tags, orgName, publisherHandle].join(
        "\n",
      ),
    )
  ) {
    return null;
  }
  return {
    projectId,
    name,
    slug,
    description,
    tags,
    organizationId,
    orgName,
    publisherHandle,
    publishedAt: publishedAt === undefined ? null : publishedAt,
  };
}

/** Accepts Convex page shape or nullish junk → CataloguePage | null. */
export function parseCataloguePage(json: unknown): CataloguePage | null {
  if (json === null || json === undefined) return null;

  let candidate: unknown = json;
  if (isRecord(json) && "value" in json) {
    candidate = json.value;
  }
  if (!isRecord(candidate)) return null;
  if (!("items" in candidate) || !Array.isArray(candidate.items)) return null;

  const items: CatalogueListing[] = [];
  for (const item of candidate.items) {
    const parsed = parseListing(item);
    if (parsed) items.push(parsed);
  }

  let nextCursor: string | null = null;
  if ("nextCursor" in candidate) {
    const nc = candidate.nextCursor;
    if (nc === null) nextCursor = null;
    else if (typeof nc === "string") nextCursor = nc;
  }

  return { items, nextCursor };
}

/** In-memory fixture for workerd tests. */
export class FixtureCatalogueSource implements CatalogueSource {
  readonly #items: CatalogueListing[];

  constructor(items: CatalogueListing[] = []) {
    this.#items = items.slice();
  }

  setItems(items: CatalogueListing[]): void {
    this.#items.length = 0;
    this.#items.push(...items);
  }

  async listPublic(args?: CatalogueListArgs): Promise<CataloguePage> {
    const search =
      args?.search === undefined ? "" : args.search.trim().toLowerCase();
    const tag = args?.tag === undefined ? "" : args.tag.trim().toLowerCase();

    let filtered = this.#items.slice();
    if (tag !== "") {
      filtered = filtered.filter((i) =>
        i.tags.some((t) => t.toLowerCase() === tag),
      );
    }
    if (search !== "") {
      filtered = filtered.filter((i) => {
        const hay =
          `${i.name} ${i.slug} ${i.description ?? ""} ${i.tags.join(" ")}`.toLowerCase();
        return hay.includes(search);
      });
    }

    return { items: filtered, nextCursor: null };
  }
}
