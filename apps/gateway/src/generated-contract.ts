import {
  generateSpecContract,
  GenerationError,
  type GeneratedContract,
  isValidSlug,
  MAX_OPENAPI_SPEC_BYTES,
} from "@zevium/shared";
import { BoundedCache } from "./cache";
import {
  getParsedSpec,
  isPublishedSpecPublic,
  type PublicPublishedSpec,
  type PublicSpecSource,
} from "./spec-source";

// Immutable version bytes + version label, never credentials or mutable visibility.
// At most 16 * (384 KiB input + 192 KiB output), independent of route aliases.
const cache = new BoundedCache<GeneratedContract | GenerationError>(
  16,
  Infinity,
);
function freeze(value: unknown): void {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
export function getGeneratedContract(
  published: PublicPublishedSpec,
): GeneratedContract {
  if (
    new TextEncoder().encode(published.spec).byteLength > MAX_OPENAPI_SPEC_BYTES
  )
    throw new GenerationError("input_size_limit");
  const version =
    published.version ?? getParsedSpec(published).info?.version ?? "unknown";
  if (version.length > 128) throw new GenerationError("invalid_version");
  const key = `${version.length}:${version}${published.spec}`;
  const hit = cache.get(key);
  if (hit instanceof GenerationError) throw hit;
  if (hit) return hit;
  try {
    const generated = generateSpecContract({ spec: published.spec, version });
    freeze(generated);
    cache.set(key, generated);
    return generated;
  } catch (error) {
    const failure = new GenerationError(generationFailure(error));
    cache.set(key, failure);
    throw failure;
  }
}

export function generationFailure(error: unknown): string {
  return error instanceof GenerationError ? error.code : "invalid_spec";
}

/** Public Markdown delivery rechecks visibility before consulting the version cache. */
export async function handleListingDocs(
  request: Request,
  source: PublicSpecSource,
  org: string,
  project: string,
): Promise<Response> {
  if (request.method !== "GET")
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, OPTIONS" },
    });
  if (!isValidSlug(org) || !isValidSlug(project))
    return new Response("Unknown public API", { status: 404 });
  const published = await source.getPublishedSpec(org, project);
  if (!published || !isPublishedSpecPublic(published))
    return new Response("Unknown public API", { status: 404 });
  try {
    return new Response(getGeneratedContract(published).markdown, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      { error: "generation_unavailable", reason: generationFailure(error) },
      { status: 422 },
    );
  }
}
