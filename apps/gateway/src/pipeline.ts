import {
  type MachinePaymentDeps,
  addPaymentOffer,
  payForSession,
  paymentHeader,
} from "./machine-payments";
import type { WalletDO } from "./wallet";
import type { KeyVerifier, VerifiedKey } from "./key-verifier";
import type { SpecSource } from "./spec-source";
import { admit } from "./admit";
import { forward } from "./forward";
import { finalize } from "./finalize";

export type PipelineEnv = {
  /** Paired web application origin for payment recovery actions. */
  APP_ORIGIN?: string;
  WALLET: DurableObjectNamespace<WalletDO>;
  ZEVIUM_RELEASE?: string;
  GATEWAY_INTERNAL_SECRET?: string;
};

export type PipelineDeps = {
  machinePayments?: MachinePaymentDeps;
  keyVerifier: KeyVerifier;
  /** Trusted MCP OAuth identity; never populated from request parameters. */
  authenticatedKey?: VerifiedKey;
  specSource: SpecSource;
  /** Upstream fetch — inject mock in tests. */
  fetchImpl?: typeof fetch;
  /** Id generator for request/reservation ids. */
  idGenerator?: () => string;
  now?: () => number;
};

export type GatewayRoute = {
  publisherHandle: string;
  projectSlug: string;
  /** Remainder path under /gateway/:org/:project */
  remainderPath: string;
};

export function parseGatewayPath(pathname: string): GatewayRoute | null {
  // /gateway/:publisherHandle/:projectSlug/*
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "gateway") return null;
  if (!parts[1] || !parts[2]) return null;
  const publisherHandle = parts[1];
  const projectSlug = parts[2];
  const rest = parts.slice(3);
  const remainderPath = rest.length === 0 ? "/" : `/${rest.join("/")}`;
  return { publisherHandle, projectSlug, remainderPath };
}

/** Shared metered call path for HTTP and MCP. Each stage receives explicit state. */
export async function handleGatewayRequest(
  request: Request,
  env: PipelineEnv,
  deps: PipelineDeps,
  _ctx: ExecutionContext,
  route: GatewayRoute,
  /** Buffered adapters prepare their result before settlement; rejection refunds. */
  prepareResponse?: (response: Response) => Promise<Response>,
): Promise<Response> {
  const started = (deps.now ?? Date.now)();
  const requestId = deps.idGenerator?.() ?? crypto.randomUUID();
  let paid:
    | {
        token: string;
        payment: import("./machine-facilitator").VerifiedPayment;
      }
    | undefined;
  const original = request;
  if (request.headers.has("PAYMENT-SIGNATURE") && deps.machinePayments) {
    const result = await payForSession(request, env, deps.machinePayments);
    if (result instanceof Response)
      return addPaymentOffer(result, request, deps.machinePayments);
    paid = result;
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${paid.token}`);
    headers.delete("x-api-key");
    headers.delete("PAYMENT-SIGNATURE");
    request = new Request(request, { headers });
  }
  const admission = await admit(request, env, deps, route, requestId, started);
  const response =
    admission instanceof Response
      ? admission
      : await finalize(
          admission,
          await forward(request, admission, deps.fetchImpl, prepareResponse),
          deps.now,
          _ctx,
        );
  if (paid) {
    response.headers.set("X-Zevium-Wallet-Session", paid.token);
    response.headers.set(
      "PAYMENT-RESPONSE",
      paymentHeader({
        success: true,
        transaction: paid.payment.transaction,
        network: paid.payment.network,
        payer: paid.payment.payer,
      }),
    );
    response.headers.set("cache-control", "no-store");
  }
  return addPaymentOffer(response, original, deps.machinePayments);
}
