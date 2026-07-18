/**
 * Mock gateway route: /mock/:orgSlug/:projectSlug/* — PUBLIC, no API key.
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
import type { SpecSource } from "./spec-source";
import { jsonError } from "./errors";

export type MockDeps = {
  /** Unused since mock went keyless; kept so test deps stay uniform. */
  keyVerifier?: KeyVerifier;
  specSource: SpecSource;
  idGenerator?: () => string;
};

export type MockRoute = {
  orgSlug: string;
  projectSlug: string;
  /** Remainder path under /mock/:org/:project */
  remainderPath: string;
};

export function parseMockPath(pathname: string): MockRoute | null {
  // /mock/:orgSlug/:projectSlug/*
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "mock") return null;
  if (!parts[1] || !parts[2]) return null;
  const orgSlug = parts[1];
  const projectSlug = parts[2];
  const rest = parts.slice(3);
  const remainderPath = rest.length === 0 ? "/" : `/${rest.join("/")}`;
  return { orgSlug, projectSlug, remainderPath };
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
    route.orgSlug,
    route.projectSlug,
  );
  if (!published) {
    return jsonError(404, "project_not_found", "Unknown project", requestId);
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

  const matched = matchOperation(parsed, request.method, route.remainderPath);
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

  return new Response(JSON.stringify(mock.body), {
    status: mock.status,
    headers: {
      "content-type": mock.contentType,
      "x-zevium-mock": "1",
      "x-zevium-cost": "0",
      "x-zevium-request-id": requestId,
    },
  });
}
