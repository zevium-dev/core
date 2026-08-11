"use node";

import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
} from "node:http";
import { isIP } from "node:net";
import type { TLSSocket } from "node:tls";
import {
  isPublicIp,
  validateWebhookUrl,
  WebhookTransportError,
  type WebhookTransport,
} from "./webhookDelivery";

export const WEBHOOK_DEADLINE_MS = 10_000;
export const WEBHOOK_DNS_TIMEOUT_MS = 2_000;
export const WEBHOOK_CONNECT_TIMEOUT_MS = 3_000;
export const WEBHOOK_HEADERS_TIMEOUT_MS = 5_000;
export const WEBHOOK_BODY_IDLE_TIMEOUT_MS = 2_000;
export const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;
export const WEBHOOK_MAX_HEADER_BYTES = 16 * 1024;
export const WEBHOOK_MAX_HEADERS = 50;
export const MAX_WEBHOOK_REDIRECTS = 3;

export type ResolvedAddress = { address: string; family: 4 | 6 };
type ResolveHostname = (hostname: string) => Promise<ResolvedAddress[]>;

type OpenedResponse = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Uint8Array>;
  abort: () => void;
  cleanup: () => void;
};

export type PinnedRequest = {
  url: URL;
  address: string;
  family: 4 | 6;
  headers: Readonly<Record<string, string>>;
  body: string;
  deadlineAt: number;
};

type OpenPinnedRequest = (request: PinnedRequest) => Promise<OpenedResponse>;

export type WebhookTransportDependencies = {
  resolveHostname: ResolveHostname;
  openPinnedRequest: OpenPinnedRequest;
  now: () => number;
};

const SENSITIVE_REDIRECT_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-zevium-delivery-id",
  "x-zevium-signature",
]);

function fail(message: string, retryable: boolean): WebhookTransportError {
  return new WebhookTransportError(message, retryable);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (timeoutMs <= 0) throw fail("Webhook deadline exceeded", true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(fail(message, true)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function normalizeHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

async function resolveAndValidate(
  url: URL,
  resolveHostname: ResolveHostname,
  deadlineAt: number,
  now: () => number,
): Promise<ResolvedAddress> {
  if (!validateWebhookUrl(url.toString())) {
    throw fail("Forbidden webhook destination", false);
  }
  const hostname = normalizeHostname(url);
  const literalFamily = isIP(hostname);
  const addresses =
    literalFamily === 0
      ? await withTimeout(
          resolveHostname(hostname),
          Math.min(WEBHOOK_DNS_TIMEOUT_MS, deadlineAt - now()),
          "Webhook DNS resolution timed out",
        )
      : [{ address: hostname, family: literalFamily as 4 | 6 }];

  if (addresses.length === 0) {
    throw fail("Webhook hostname has no addresses", true);
  }
  if (
    addresses.some(
      ({ address, family }) => isIP(address) !== family || !isPublicIp(address),
    )
  ) {
    throw fail("Webhook hostname resolved to forbidden address", false);
  }
  return addresses[0]!;
}

function stripSensitiveHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !SENSITIVE_REDIRECT_HEADERS.has(name.toLowerCase()),
    ),
  );
}

function headerCount(headers: IncomingHttpHeaders): number {
  return Object.values(headers).reduce(
    (count, value) => count + (Array.isArray(value) ? value.length : 1),
    0,
  );
}

async function consumeBoundedResponse(response: OpenedResponse): Promise<void> {
  if (headerCount(response.headers) > WEBHOOK_MAX_HEADERS) {
    response.abort();
    throw fail("Webhook response has too many headers", false);
  }
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > WEBHOOK_MAX_RESPONSE_BYTES) {
        response.abort();
        throw fail("Webhook response body is too large", false);
      }
    }
  } finally {
    response.cleanup();
  }
}

function requestError(
  request: ClientRequest,
  reject: (reason: unknown) => void,
  message: string,
): void {
  const error = fail(message, true);
  request.destroy(error);
  reject(error);
}

/** Node lookup callback that returns only already-validated address. */
export function createPinnedLookup(
  address: string,
  family: 4 | 6,
): NonNullable<RequestOptions["lookup"]> {
  return (_hostname, options, callback) => {
    if (typeof options === "object" && options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

async function openNodePinnedRequest(
  input: PinnedRequest,
): Promise<OpenedResponse> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const clearConnectTimer = () => {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
    };
    const hostname = normalizeHostname(input.url);
    const request = httpsRequest({
      protocol: "https:",
      hostname,
      port: input.url.port || 443,
      path: `${input.url.pathname}${input.url.search}`,
      method: "POST",
      headers: input.headers,
      servername: isIP(hostname) ? undefined : hostname,
      lookup: createPinnedLookup(input.address, input.family),
      // Node's global agent can reuse a hostname-keyed socket and bypass this
      // attempt's pinned lookup. One fresh socket per hop keeps DNS proof tied
      // to exact TLS connection.
      agent: false,
      maxHeaderSize: WEBHOOK_MAX_HEADER_BYTES,
      rejectUnauthorized: true,
    });
    request.maxHeadersCount = WEBHOOK_MAX_HEADERS;

    const deadlineTimer = setTimeout(
      () => requestError(request, reject, "Webhook deadline exceeded"),
      Math.max(1, input.deadlineAt - Date.now()),
    );
    deadlineTimer.unref?.();
    const headersTimer = setTimeout(
      () => requestError(request, reject, "Webhook response headers timed out"),
      Math.min(
        WEBHOOK_HEADERS_TIMEOUT_MS,
        Math.max(1, input.deadlineAt - Date.now()),
      ),
    );
    headersTimer.unref?.();

    request.once("socket", (socket) => {
      const tlsSocket = socket as TLSSocket;
      connectTimer = setTimeout(
        () => requestError(request, reject, "Webhook connection timed out"),
        Math.min(
          WEBHOOK_CONNECT_TIMEOUT_MS,
          Math.max(1, input.deadlineAt - Date.now()),
        ),
      );
      connectTimer.unref?.();
      tlsSocket.once("secureConnect", clearConnectTimer);
    });
    request.setTimeout(WEBHOOK_BODY_IDLE_TIMEOUT_MS, () =>
      requestError(request, reject, "Webhook connection became idle"),
    );
    request.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearConnectTimer();
      clearTimeout(headersTimer);
      clearTimeout(deadlineTimer);
      reject(error);
    });
    request.once("response", (response: IncomingMessage) => {
      if (settled) return;
      settled = true;
      clearConnectTimer();
      clearTimeout(headersTimer);
      resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: response,
        abort: () => request.destroy(),
        cleanup: () => {
          clearTimeout(deadlineTimer);
          request.setTimeout(0);
        },
      });
    });
    request.end(input.body);
  });
}

const NODE_DEPENDENCIES: WebhookTransportDependencies = {
  resolveHostname: async (hostname) =>
    (await lookup(hostname, { all: true, verbatim: true })).map(
      ({ address, family }) => ({ address, family: family as 4 | 6 }),
    ),
  openPinnedRequest: openNodePinnedRequest,
  now: Date.now,
};

/** HTTPS-only, DNS-pinned, bounded webhook transport. */
export async function deliverPinnedHttps(
  input: Parameters<WebhookTransport>[0],
  dependencies: WebhookTransportDependencies = NODE_DEPENDENCIES,
): Promise<{ status: number }> {
  const deadlineAt = dependencies.now() + WEBHOOK_DEADLINE_MS;
  let currentUrl = input.url;
  let headers: Readonly<Record<string, string>> = input.headers;

  for (let redirects = 0; ; redirects += 1) {
    const pinned = await resolveAndValidate(
      currentUrl,
      dependencies.resolveHostname,
      deadlineAt,
      dependencies.now,
    );
    const response = await dependencies.openPinnedRequest({
      url: currentUrl,
      address: pinned.address,
      family: pinned.family,
      headers,
      body: input.body,
      deadlineAt,
    });
    await consumeBoundedResponse(response);

    if (response.statusCode < 300 || response.statusCode >= 400) {
      return { status: response.statusCode };
    }
    const location = response.headers.location;
    if (typeof location !== "string" || redirects >= MAX_WEBHOOK_REDIRECTS) {
      throw fail("Webhook redirect is invalid or exceeds limit", false);
    }
    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.origin !== currentUrl.origin) {
      headers = stripSensitiveHeaders(headers);
    }
    currentUrl = nextUrl;
  }
}
