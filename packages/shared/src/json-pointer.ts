const MAX_REF_HOPS = 32;
const MAX_REF_LENGTH = 2_048;
const MAX_POINTER_SEGMENTS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodePointerSegment(segment: string): string | null {
  // RFC 6901 permits only ~0 and ~1 escapes. Reject malformed pointers
  // instead of accidentally resolving a different property.
  if (/~(?:[^01]|$)/.test(segment)) return null;
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Resolve a bounded local URI-fragment JSON Pointer against a document root. */
export function resolveLocalJsonPointer(
  ref: string,
  document: unknown,
): unknown {
  if (!ref.startsWith("#") || ref.length > MAX_REF_LENGTH) return undefined;
  if (ref === "#") return document;
  if (!ref.startsWith("#/")) return undefined;

  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(2));
  } catch {
    return undefined;
  }

  const encodedSegments = pointer.split("/");
  if (encodedSegments.length > MAX_POINTER_SEGMENTS) return undefined;

  let current = document;
  for (const encoded of encodedSegments) {
    const segment = decodePointerSegment(encoded);
    if (segment === null) return undefined;

    if (Array.isArray(current)) {
      // RFC 6901 array tokens are canonical unsigned base-10 indexes. `-`
      // only has meaning for JSON Patch, never pointer evaluation.
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) return undefined;
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    if (!isRecord(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/**
 * Resolve a bounded chain of local `$ref` objects. OpenAPI 3.1 sibling fields
 * override the referenced object. Cycles and overlong chains fail closed.
 */
export function resolveLocalJsonRefChain(
  initial: unknown,
  document: unknown,
): unknown {
  if (!isRecord(initial)) return initial;
  let current = initial;
  const seen = new Set<string>();

  for (let hop = 0; hop < MAX_REF_HOPS; hop++) {
    const ref = current.$ref;
    if (typeof ref !== "string") return current;
    if (seen.has(ref)) return {};
    seen.add(ref);

    const target = resolveLocalJsonPointer(ref, document);
    if (!isRecord(target)) return current;

    const siblings = Object.fromEntries(
      Object.entries(current).filter(([key]) => key !== "$ref"),
    );
    current =
      Object.keys(siblings).length > 0 ? { ...target, ...siblings } : target;
  }

  return {};
}
