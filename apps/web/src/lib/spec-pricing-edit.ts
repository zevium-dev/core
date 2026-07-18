import type { HttpMethod } from "@zevium/shared";

/**
 * Pricing write-back for the spec editor rail.
 *
 * `cost`/`freeTier` tri-state:
 *  - number      -> set the extension key to that value
 *  - null        -> delete the extension key (cleared)
 *  - undefined   -> leave untouched
 *
 * The whole document is parsed, the target operation mutated, then
 * re-serialized with a 2-space indent. JSON.parse/stringify preserves
 * object key insertion order, so sibling field order is stable; the only
 * reordering is a newly-added key landing at the end of its operation
 * object, which is expected. Numbers stay numbers.
 */
export type PricingEdit = {
  path: string;
  method: HttpMethod;
  cost?: number | null;
  freeTier?: number | null;
};

export type PricingEditResult = { ok: true; text: string } | { ok: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyField(
  op: Record<string, unknown>,
  key: string,
  value: number | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null || Number.isNaN(value)) {
    delete op[key];
    return;
  }
  op[key] = value;
}

/**
 * Parse `specText`, apply a pricing edit to `paths[path][method]`, return the
 * re-serialized document. Returns `{ ok: false }` when the text is not valid
 * JSON, the root is not an object, or the path/method does not resolve to an
 * operation object. Method matching is case-insensitive.
 */
export function applyPricingEdit(
  specText: string,
  edit: PricingEdit,
): PricingEditResult {
  let root: unknown;
  try {
    root = JSON.parse(specText);
  } catch {
    return { ok: false };
  }
  if (!isRecord(root)) return { ok: false };

  const paths = root.paths;
  if (!isRecord(paths)) return { ok: false };

  const pathItem = paths[edit.path];
  if (!isRecord(pathItem)) return { ok: false };

  const lower = edit.method.toLowerCase();
  let op: Record<string, unknown> | null = null;
  for (const [key, val] of Object.entries(pathItem)) {
    if (key.toLowerCase() === lower && isRecord(val)) {
      op = val;
      break;
    }
  }
  if (op === null) return { ok: false };

  applyField(op, "x-zevium-cost", edit.cost);
  applyField(op, "x-zevium-free-tier", edit.freeTier);

  return { ok: true, text: JSON.stringify(root, null, 2) };
}
