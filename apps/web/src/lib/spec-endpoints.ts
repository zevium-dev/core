import {
  type TokenPricing,
  extractPricing,
  parseSpec,
  type HttpMethod,
} from "@zevium/shared";

export type SpecEndpointRow = {
  method: HttpMethod;
  path: string;
  cost: number;
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
        if (op["x-zevium-cost"] === undefined) continue;
        const pricing = extractPricing(op);
        rows.push({
          method,
          path,
          cost: pricing.cost,
          ...(pricing.token ? { tokenPricing: pricing.token } : {}),
          freeTier: pricing.freeTier,
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
