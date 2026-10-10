import type { GatewayRoute } from "./pipeline";

export function applyDeprecationHeaders(
  headers: Headers,
  published: {
    deprecatedAt?: number;
    sunsetAt?: number;
  },
  route: GatewayRoute,
): void {
  if (published.deprecatedAt === undefined) return;
  headers.set("Deprecation", `@${Math.floor(published.deprecatedAt / 1000)}`);
  headers.append(
    "Link",
    `<https://zevium.dev/catalogue/${route.publisherHandle}/${route.projectSlug}>; rel="deprecation"`,
  );
  if (published.sunsetAt !== undefined) {
    headers.set("Sunset", new Date(published.sunsetAt).toUTCString());
  }
}
