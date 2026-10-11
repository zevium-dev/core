export type CatalogueListing = {
  name: string;
  slug: string;
  description: string | undefined;
  tags: string[];
  orgName: string;
  publisherHandle: string;
  publishedAt: number | null;
  score?: number;
  pricing?: {
    minCost: number;
    maxCost: number;
    endpointCount: number;
    hasFreeTier: boolean;
  } | null;
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

/** Collect public catalogue pages, stopping on exhausted or repeated cursors. */
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
    score:
      typeof raw.score === "number" && Number.isFinite(raw.score)
        ? raw.score
        : undefined,
    pricing: parsePricing(raw.pricing),
  };
}

function parsePricing(raw: unknown): CatalogueListing["pricing"] {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.minCost !== "number" ||
    !Number.isFinite(raw.minCost) ||
    typeof raw.maxCost !== "number" ||
    !Number.isFinite(raw.maxCost) ||
    typeof raw.endpointCount !== "number" ||
    !Number.isSafeInteger(raw.endpointCount) ||
    typeof raw.hasFreeTier !== "boolean"
  )
    return null;
  return {
    minCost: raw.minCost,
    maxCost: raw.maxCost,
    endpointCount: raw.endpointCount,
    hasFreeTier: raw.hasFreeTier,
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
