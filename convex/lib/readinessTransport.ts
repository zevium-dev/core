"use node";

import { lookup } from "node:dns/promises";
import { Agent, request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import type { TLSSocket } from "node:tls";
import { isPublicIp } from "./webhookDelivery";
import { createPinnedLookup, type ResolvedAddress } from "./webhookTransport";

export const READINESS_DEADLINE_MS = 10_000;
export const READINESS_DNS_TIMEOUT_MS = 2_000;
export const READINESS_CONNECT_TIMEOUT_MS = 3_000;
export const READINESS_HEADERS_TIMEOUT_MS = 5_000;
export const READINESS_MAX_HEADER_BYTES = 16 * 1024;
export const READINESS_MAX_HEADERS = 50;
export const MAX_READINESS_REDIRECTS = 3;

export type ReadinessFailure = "blocked_target" | "timeout" | "unreachable";

export class ReadinessTransportError extends Error {
  constructor(
    readonly kind: ReadinessFailure,
    message: string,
  ) {
    super(message);
    this.name = "ReadinessTransportError";
  }
}

export type ReadinessPinnedRequest = {
  url: URL;
  address: string;
  family: 4 | 6;
  headers: Readonly<Record<string, string>>;
  deadlineAt: number;
};

type OpenedHead = {
  statusCode: number;
  headers: IncomingHttpHeaders;
};

export type ReadinessTransportDependencies = {
  resolveHostname: (hostname: string) => Promise<ResolvedAddress[]>;
  openPinnedRequest: (request: ReadinessPinnedRequest) => Promise<OpenedHead>;
  now: () => number;
};

function fail(
  kind: ReadinessFailure,
  message: string,
): ReadinessTransportError {
  return new ReadinessTransportError(kind, message);
}

function normalizeHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  kind: ReadinessFailure,
  message: string,
): Promise<T> {
  if (timeoutMs <= 0) throw fail("timeout", "Connection test timed out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(fail(kind, message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function resolveAndPin(
  url: URL,
  dependencies: ReadinessTransportDependencies,
  deadlineAt: number,
): Promise<ResolvedAddress> {
  if (url.protocol !== "https:") {
    throw fail("blocked_target", "Only HTTPS upstream URLs can be tested");
  }
  if (url.username || url.password) {
    throw fail("blocked_target", "Upstream URLs cannot include credentials");
  }
  const hostname = normalizeHostname(url);
  const literalFamily = isIP(hostname);
  const addresses =
    literalFamily === 0
      ? await withTimeout(
          dependencies.resolveHostname(hostname),
          Math.min(READINESS_DNS_TIMEOUT_MS, deadlineAt - dependencies.now()),
          "unreachable",
          "Could not resolve the upstream hostname",
        )
      : [{ address: hostname, family: literalFamily as 4 | 6 }];
  if (addresses.length === 0) {
    throw fail("unreachable", "Could not resolve the upstream hostname");
  }
  // A mixed answer is rejected as a unit. Picking only a public sibling would
  // let DNS answer ordering turn policy into a race.
  if (
    addresses.some(
      ({ address, family }) => isIP(address) !== family || !isPublicIp(address),
    )
  ) {
    throw fail(
      "blocked_target",
      "Private or internal upstream URLs cannot be tested",
    );
  }
  return addresses[0]!;
}

function requestError(
  request: ClientRequest,
  reject: (reason: unknown) => void,
  kind: ReadinessFailure,
  message: string,
): void {
  const error = fail(kind, message);
  request.destroy(error);
  reject(error);
}

/**
 * Real Node requester. Every call owns a fresh non-keepalive Agent with TLS
 * session caching disabled. DNS lookup returns only the already-validated IP;
 * Host and SNI remain bound to original hostname.
 */
export async function openNodePinnedHead(
  input: ReadinessPinnedRequest,
  tls: { ca?: string } = {},
): Promise<OpenedHead> {
  return await new Promise((resolve, reject) => {
    const hostname = normalizeHostname(input.url);
    const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 });
    let settled = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      agent.destroy();
    };
    const request = httpsRequest({
      protocol: "https:",
      hostname,
      port: input.url.port || 443,
      path: `${input.url.pathname}${input.url.search}`,
      method: "HEAD",
      headers: input.headers,
      servername: isIP(hostname) ? undefined : hostname,
      lookup: createPinnedLookup(input.address, input.family),
      agent,
      maxHeaderSize: READINESS_MAX_HEADER_BYTES,
      rejectUnauthorized: true,
      ...(tls.ca === undefined ? {} : { ca: tls.ca }),
    });
    request.maxHeadersCount = READINESS_MAX_HEADERS;

    const deadlineTimer = setTimeout(
      () =>
        requestError(request, reject, "timeout", "Connection test timed out"),
      Math.max(1, input.deadlineAt - Date.now()),
    );
    deadlineTimer.unref?.();
    const headersTimer = setTimeout(
      () =>
        requestError(
          request,
          reject,
          "timeout",
          "Upstream response headers timed out",
        ),
      Math.min(
        READINESS_HEADERS_TIMEOUT_MS,
        Math.max(1, input.deadlineAt - Date.now()),
      ),
    );
    headersTimer.unref?.();

    request.once("socket", (socket) => {
      connectTimer = setTimeout(
        () =>
          requestError(
            request,
            reject,
            "timeout",
            "Upstream connection timed out",
          ),
        Math.min(
          READINESS_CONNECT_TIMEOUT_MS,
          Math.max(1, input.deadlineAt - Date.now()),
        ),
      );
      connectTimer.unref?.();
      (socket as TLSSocket).once("secureConnect", () => {
        if (connectTimer !== undefined) clearTimeout(connectTimer);
      });
    });
    request.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(headersTimer);
      clearTimeout(deadlineTimer);
      finish();
      reject(
        error instanceof ReadinessTransportError
          ? error
          : fail("unreachable", "Could not reach the upstream server"),
      );
    });
    request.once("response", (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(headersTimer);
      clearTimeout(deadlineTimer);
      const statusCode = response.statusCode ?? 0;
      const headers = response.headers;
      response.resume();
      finish();
      resolve({ statusCode, headers });
    });
    request.end();
  });
}

const NODE_DEPENDENCIES: ReadinessTransportDependencies = {
  resolveHostname: async (hostname) =>
    (await lookup(hostname, { all: true, verbatim: true })).map(
      ({ address, family }) => ({ address, family: family as 4 | 6 }),
    ),
  openPinnedRequest: openNodePinnedHead,
  now: Date.now,
};

export type ReadinessProbeResult = {
  statusCode: number;
  finalUrl: URL;
};

export async function probePinnedHttps(
  initialUrl: URL,
  headers: Readonly<Record<string, string>>,
  dependencies: ReadinessTransportDependencies = NODE_DEPENDENCIES,
): Promise<ReadinessProbeResult> {
  const deadlineAt = dependencies.now() + READINESS_DEADLINE_MS;
  let current = initialUrl;
  const credentialed = Object.keys(headers).length > 0;

  for (let redirects = 0; ; redirects += 1) {
    const pinned = await resolveAndPin(current, dependencies, deadlineAt);
    const response = await dependencies.openPinnedRequest({
      url: current,
      address: pinned.address,
      family: pinned.family,
      headers,
      deadlineAt,
    });
    if (response.statusCode < 300 || response.statusCode >= 400) {
      return { statusCode: response.statusCode, finalUrl: current };
    }
    const location = response.headers.location;
    if (typeof location !== "string" || redirects >= MAX_READINESS_REDIRECTS) {
      throw fail(
        "unreachable",
        "Upstream redirect is invalid or exceeds the redirect limit",
      );
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw fail("unreachable", "Upstream returned an invalid redirect");
    }
    if (credentialed && next.origin !== current.origin) {
      throw fail(
        "blocked_target",
        "Credentialed connection tests cannot follow cross-origin redirects",
      );
    }
    current = next;
  }
}
