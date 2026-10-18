import type { GatewayRoute } from "./pipeline";
import { webOrigin } from "./web-origin";

/** Links the paired web listing; omitted when APP_ORIGIN is unusable. */
export function appendDeprecationLink(
  headers: Headers,
  route: Pick<GatewayRoute, "publisherHandle" | "projectSlug">,
  appOrigin: string | undefined,
): void {
  const origin = webOrigin(appOrigin);
  if (!origin) return;
  const listing = new URL(
    `/catalogue/${route.publisherHandle}/${route.projectSlug}`,
    origin,
  ).href;
  headers.append("Link", `<${listing}>; rel="deprecation"`);
}

export function applyDeprecationHeaders(
  headers: Headers,
  published: {
    deprecatedAt?: number;
    sunsetAt?: number;
  },
  route: GatewayRoute,
  appOrigin: string | undefined,
): void {
  if (published.deprecatedAt === undefined) return;
  headers.set("Deprecation", `@${Math.floor(published.deprecatedAt / 1000)}`);
  appendDeprecationLink(headers, route, appOrigin);
  if (published.sunsetAt !== undefined) {
    headers.set("Sunset", new Date(published.sunsetAt).toUTCString());
  }
}
