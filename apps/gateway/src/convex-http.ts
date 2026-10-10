import { trimTrailingSlashes } from "@zevium/shared";

/** JSON-only public queries; gateway payloads contain no Convex special values.
 * Wire contract: https://docs.convex.dev/http-api/#functions-api
 */
export async function queryConvex(
  url: string,
  path: string,
  args: object,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetchImpl(`${trimTrailingSlashes(url)}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  if (!response.ok) throw new Error("Public query unavailable");
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("status" in body) ||
    body.status !== "success" ||
    !("value" in body)
  ) {
    throw new Error("Invalid public query response");
  }
  return body.value;
}
