/**
 * Mock gateway route: /mock/:orgSlug/:projectSlug/* — same key auth as
 * /gateway (product rule: no unauthenticated execution paths), but costs
 * 0 credits: no reserve/settle, never touches upstream. Serves a generated
 * example body from the published spec's response schema.
 */

import {
  generateMockResponse,
  matchOperation,
  parseSpec,
} from "@zevium/shared";
import { extractApiKey, type KeyVerifier } from "./key-verifier";
import type { SpecSource } from "./spec-source";
import { jsonError } from "./errors";
import { paymentRequiredResponse } from "./x402";

export type MockDeps = {
  keyVerifier: KeyVerifier;
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

  const secret = extractApiKey(request);
  if (!secret) {
    return paymentRequiredResponse(requestId, "API key required", {
      reason: "missing_api_key",
    });
  }

  const verified = await deps.keyVerifier.verify(secret);
  if (!verified) {
    return paymentRequiredResponse(requestId, "Invalid API key", {
      reason: "invalid_api_key",
    });
  }

  const published = await deps.specSource.getPublishedSpec(
    route.orgSlug,
    route.projectSlug,
  );
  if (!published) {
    return jsonError(404, "project_not_found", "Unknown project", requestId);
  }

  // Same subject-must-match-project rule as /gateway.
  if (verified.orgId !== published.clerkOrgId) {
    return jsonError(
      401,
      "org_mismatch",
      "Key not authorized for this org",
      requestId,
    );
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
