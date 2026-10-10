import {
  MACHINE_SESSION_SECONDS,
  MACHINE_TOPUP_CREDITS,
  machineWalletId,
  fundingExpiresAt,
  type MachineGrant,
} from "@zevium/shared";
import {
  type MachineFacilitator,
  type VerifiedPayment,
  PaymentRejected,
} from "./machine-facilitator";
import { issueWalletSession } from "./wallet-session";
import type { PipelineEnv } from "./pipeline";
import { paymentRequiredResponse } from "./payment-required";
export type MachinePaymentDeps = {
  facilitator: MachineFacilitator;
  signingSecret: string;
  fund: (payment: VerifiedPayment) => Promise<MachineGrant>;
};
export function paymentHeader(value: unknown): string {
  return btoa(JSON.stringify(value));
}
export function addPaymentOffer(
  response: Response,
  request: Request,
  machine?: MachinePaymentDeps,
): Response {
  if (response.status === 402 && machine) {
    response.headers.set(
      "PAYMENT-REQUIRED",
      paymentHeader({
        x402Version: 2,
        resource: {
          url: request.url,
          description:
            "$1 anonymous wallet top-up; unused credits expire one year after payment",
          mimeType: "application/json",
        },
        accepts: [machine.facilitator.requirements],
        extensions: {
          "zevium-wallet": {
            info: {
              credits: MACHINE_TOPUP_CREDITS,
              sessionSeconds: MACHINE_SESSION_SECONDS,
              sessionHeader: "X-Zevium-Wallet-Session",
              authorization: "Bearer",
            },
          },
        },
      }),
    );
    response.headers.set("cache-control", "no-store");
  }
  return response;
}
export async function payForSession(
  request: Request,
  env: PipelineEnv,
  machine: MachinePaymentDeps,
): Promise<{ token: string; payment: VerifiedPayment } | Response> {
  const header = request.headers.get("PAYMENT-SIGNATURE");
  if (!header || header.length > 16_384)
    return paymentRequiredResponse(
      crypto.randomUUID(),
      "Invalid payment proof",
      { reason: "invalid_payment" },
      env.APP_ORIGIN,
    );
  try {
    // Check issuance configuration before moving funds.
    if (machine.signingSecret.length < 32)
      throw new Error("Session unavailable");
    let payload: unknown;
    try {
      payload = JSON.parse(atob(header));
    } catch {
      throw new PaymentRejected();
    }
    const payment = await machine.facilitator.settle(payload);
    const grant = await machine.fund(payment);
    if (
      grant.walletId !== machineWalletId(payment.network, payment.payer) ||
      grant.sourceRef !== `x402:${payment.paymentId}` ||
      grant.credits !== MACHINE_TOPUP_CREDITS ||
      !Number.isSafeInteger(grant.createdAt) ||
      grant.expiresAt !== fundingExpiresAt(grant.createdAt) ||
      typeof grant.applied !== "boolean"
    )
      throw new Error("Invalid funding receipt");
    // Retry after a lost projection can repair the edge without re-funding or issuing a credential.
    const projected = await env.WALLET.get(
      env.WALLET.idFromName(grant.walletId),
    ).grantMachineLot(grant);
    if (projected.status === "rejected") throw new Error("Wallet unavailable");
    if (!grant.applied)
      return Response.json(
        {
          error: "payment_replayed",
          detail:
            "Payment already credited. Use the wallet session from the original response.",
        },
        { status: 409 },
      );
    const token = await issueWalletSession(
      machine.signingSecret,
      new URL(request.url).origin,
      payment.network,
      payment.payer,
    );
    return { token, payment };
  } catch (error) {
    if (error instanceof PaymentRejected)
      return paymentRequiredResponse(
        crypto.randomUUID(),
        "Payment proof was rejected",
        { reason: "invalid_payment" },
        env.APP_ORIGIN,
      );
    return Response.json(
      {
        error: "payment_unavailable",
        detail:
          "Payment could not be confirmed. Retry the same proof; do not pay again.",
      },
      { status: 503 },
    );
  }
}
export function convexMachineFunder(
  siteUrl: string,
  secret: string,
): MachinePaymentDeps["fund"] {
  return async (payment) => {
    const response = await fetch(`${siteUrl.replace(/\/$/, "")}/machine-fund`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": secret,
      },
      body: JSON.stringify(payment),
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    if (!response.ok) throw new Error("Funding unavailable");
    return (await response.json()) as MachineGrant;
  };
}
