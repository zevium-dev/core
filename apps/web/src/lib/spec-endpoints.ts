import {
  type TokenPricing,
  extractPricing,
  parseCreditExtension,
  parseTokenPricing,
  parseSpec,
  type HttpMethod,
} from "@zevium/shared";

export type SpecEndpointRow = {
  method: HttpMethod;
  path: string;
  cost: number | null;
  tokenPricing?: TokenPricing;
  freeTier?: number;
  summary?: string;
};

const METHOD_ORDER: HttpMethod[] = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
];

/** Parse editor text into endpoint rows for the live rail. */
export function listSpecEndpoints(specText: string): SpecEndpointRow[] | null {
  const trimmed = specText.trim();
  if (trimmed === "") return [];

  try {
    const spec = parseSpec(trimmed);
    const rows: SpecEndpointRow[] = [];
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      if (!pathItem) continue;
      for (const method of METHOD_ORDER) {
        const op = pathItem[method];
        if (op === undefined) continue;
        const pricing = extractPricing(op);
        // Preserve disabled rates in the editor; scalar controls must not replace them.
        const rawCost = op["x-zevium-cost"];
        if (typeof rawCost === "object" && rawCost !== null) continue;
        const token =
          typeof rawCost === "object" && rawCost !== null
            ? parseTokenPricing(rawCost)
            : undefined;
        rows.push({
          method,
          path,
          cost: pricing?.cost ?? null,
          freeTier:
            pricing === null && op["x-zevium-free-tier"] !== undefined
              ? parseCreditExtension(
                  op["x-zevium-free-tier"],
                  "x-zevium-free-tier",
                ) || undefined
              : pricing?.freeTier,
          ...(token ? { tokenPricing: token } : {}),
          summary:
            typeof op.summary === "string" && op.summary.trim() !== ""
              ? op.summary
              : undefined,
        });
      }
    }
    return rows;
  } catch {
    return null;
  }
}
