/**
 * Public catalogue resolution for discovery + MCP search.
 * ConvexCatalogueSource calls public query catalogue:listPublic.
 * CachedCatalogueSource wraps any source with a 60s TTL.
 */

import { queryConvex } from "./convex-http";
import { BoundedCache } from "./cache";
import { logDependencyFailure } from "./telemetry";

export type CatalogueListing = {
  name: string;
  slug: string;
  description: string | undefined;
  tags: string[];
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
  invalidate?(): void;
}

/** Read every catalogue page while preserving caller filters. */
export async function listAllPublic(
  source: CatalogueSource,
  args: Omit<CatalogueListArgs, "cursor"> = {},
): Promise<CatalogueListing[]> {
  const items: CatalogueListing[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const page = await source.listPublic({ ...args, cursor });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor === undefined || seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
  }

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
  readonly #cache: BoundedCache<CataloguePage>;

  constructor(opts: CachedCatalogueSourceOptions) {
    this.#inner = opts.inner;
    this.#cache = new BoundedCache(
      MEMORY_MAX,
      opts.ttlMs ?? DEFAULT_TTL_MS,
      opts.now,
    );
  }

  async listPublic(args?: CatalogueListArgs): Promise<CataloguePage> {
    const key = cacheKey(args);
    const hit = this.#cache.get(key);
    if (hit !== undefined) return hit;
    return this.#cache.set(key, await this.#inner.listPublic(args));
  }

  invalidate(): void {
    this.#cache.invalidate();
  }
}

export type ConvexCatalogueSourceOptions = {
  convexUrl: string;
  fetchImpl?: typeof fetch;
};

/**
 * Control-plane public catalogue via the Convex public HTTP API.
 * Function: catalogue:listPublic (public query, no auth).
 */
export class ConvexCatalogueSource implements CatalogueSource {
  constructor(readonly options: ConvexCatalogueSourceOptions) {}

  async listPublic(args?: CatalogueListArgs): Promise<CataloguePage> {
    try {
      const value = await queryConvex(
        this.options.convexUrl,
        "catalogue:listPublic",
        {
          search: args?.search,
          tag: args?.tag,
          cursor: args?.cursor,
        },
        this.options.fetchImpl,
      );
      return parseCataloguePage(value) ?? { items: [], nextCursor: null };
    } catch {
      logDependencyFailure("catalogue_source");
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

  const name = asString(raw.name);
  const slug = asString(raw.slug);
  const orgName = asString(raw.orgName);
  const publisherHandle = asString(raw.publisherHandle);
  if (
    name === undefined ||
    slug === undefined ||
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
  return {
    name,
    slug,
    description,
    tags,
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
