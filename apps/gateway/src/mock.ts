/**
 * Mock gateway route: /mock/:publisherHandle/:projectSlug/* — PUBLIC, no API key.
 * Mock never executes the upstream API, so the "no unmetered execution"
 * product rule does not apply: responses are synthesized from the published
 * spec's response schema at 0 credits. This is the anonymous try-before-buy
 * surface for the catalogue and agent onboarding.
 */

import {
  generateMockResponse,
  matchOperation,
  parseSpec,
} from "@zevium/shared";
import type { KeyVerifier } from "./key-verifier";
import {
  isPublishedSpecPublicCopyAllowed,
  type PublicSpecSource,
} from "./spec-source";
import { jsonError } from "./errors";

export type MockDeps = {
  /** Unused since mock went keyless; kept so test deps stay uniform. */
  keyVerifier?: KeyVerifier;
  specSource: PublicSpecSource;
  idGenerator?: () => string;
  now?: () => number;
};

export type MockRoute = {
  publisherHandle: string;
  projectSlug: string;
  /** Remainder path under /mock/:org/:project */
  remainderPath: string;
};

export function parseMockPath(pathname: string): MockRoute | null {
  // /mock/:publisherHandle/:projectSlug/*
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "mock") return null;
  if (!parts[1] || !parts[2]) return null;
  const publisherHandle = parts[1];
  const projectSlug = parts[2];
  const rest = parts.slice(3);
  const remainderPath = rest.length === 0 ? "/" : `/${rest.join("/")}`;
  return { publisherHandle, projectSlug, remainderPath };
}

function defaultId(): string {
  return crypto.randomUUID();
}

export async function handleMockRequest(
  request: Request,
  deps: MockDeps,
  route: MockRoute,
): Promise<Response> {
  const requestId = (deps.idGenerator ?? defaultId)();

  const published = await deps.specSource.getPublishedSpec(
    route.publisherHandle,
    route.projectSlug,
  );
  if (!published) {
    return jsonError(404, "project_not_found", "Unknown project", requestId);
  }
  if (
    !isPublishedSpecPublicCopyAllowed(
      published,
      route.publisherHandle,
      route.projectSlug,
    )
  ) {
    return jsonError(404, "project_not_found", "Unknown project", requestId);
  }

  const started = (deps.now ?? Date.now)();
  if (
    published.retiredAt !== undefined ||
    (published.sunsetAt !== undefined && started >= published.sunsetAt)
  ) {
    const response = jsonError(
      410,
      "sunset_reached",
      "This API has reached its published sunset",
      requestId,
    );
    if (published.deprecatedAt !== undefined) {
      response.headers.set(
        "Deprecation",
        `@${Math.floor(published.deprecatedAt / 1000)}`,
      );
      response.headers.append(
        "Link",
        `<https://zevium.dev/catalogue/${route.publisherHandle}/${route.projectSlug}>; rel="deprecation"`,
      );
    }
    if (published.sunsetAt !== undefined) {
      response.headers.set(
        "Sunset",
        new Date(published.sunsetAt).toUTCString(),
      );
    }
    return response;
  }

  let parsed;
  try {
    parsed = parseSpec(published.spec);
  } catch {
    return jsonError(
      404,
      "invalid_spec",
      "Published spec unreadable",
      requestId,
    );
  }

  let matched: ReturnType<typeof matchOperation>;
  try {
    matched = matchOperation(parsed, request.method, route.remainderPath);
  } catch {
    return jsonError(
      422,
      "invalid_spec",
      "Published spec pricing is invalid",
      requestId,
    );
  }
  if (!matched) {
    return jsonError(404, "route_not_found", "Unknown route", requestId);
  }

  const mock = generateMockResponse(
    parsed,
    matched.pathTemplate,
    matched.method,
  );
  if (!mock) {
    return jsonError(404, "route_not_found", "Unknown route", requestId);
  }

  const body =
    typeof mock.body === "string" &&
    !mock.contentType.toLowerCase().includes("json")
      ? mock.body
      : JSON.stringify(mock.body);

  return new Response(body, {
    status: mock.status,
    headers: {
      "content-type": mock.contentType,
      "x-zevium-mock": "1",
      "x-zevium-cost": "0",
      "x-zevium-request-id": requestId,
    },
  });
}
