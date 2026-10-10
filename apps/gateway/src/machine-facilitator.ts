import { MACHINE_TOPUP_ATOMIC_USDC, MACHINE_TOPUP_CENTS } from "@zevium/shared";

export type PaymentRequirements = {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
};
export type VerifiedPayment = {
  paymentId: string;
  transaction: string;
  network: string;
  payer: string;
};
/** Only this boundary can turn a proof into a Stripe-backed funding fact. */
export interface MachineFacilitator {
  requirements: PaymentRequirements;
  settle(payload: unknown): Promise<VerifiedPayment>;
}
export class PaymentRejected extends Error {}
export class PaymentUnavailable extends Error {}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PaymentRejected();
  return value as Record<string, unknown>;
}

/** x402 V2 /verify + /settle, then Stripe transaction-verification PaymentIntent.
 * Stripe's docs use an external facilitator (CDP); Stripe owns the deposit address.
 * Authentication is supplied by a private facilitator proxy, not a client header.
 */
export class StripeX402Facilitator implements MachineFacilitator {
  readonly requirements: PaymentRequirements;
  constructor(
    private readonly options: {
      depositAddress: string;
      facilitatorUrl: string;
      facilitatorToken: string;
      stripeKey: string;
      fetchImpl?: typeof fetch;
      /** Durable proof-scoped receipt, so a Stripe outage does not repeat settlement. */
      settlementReceipt?: {
        load: () => Promise<Omit<VerifiedPayment, "paymentId"> | null>;
        save: (receipt: Omit<VerifiedPayment, "paymentId">) => Promise<void>;
      };
    },
  ) {
    if (
      !/^0x[0-9a-fA-F]{40}$/.test(options.depositAddress) ||
      !options.facilitatorUrl.startsWith("https://") ||
      !/^(sk|rk)_(test|live)_/.test(options.stripeKey)
    )
      throw new PaymentUnavailable();
    this.requirements = {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: MACHINE_TOPUP_ATOMIC_USDC,
      payTo: options.depositAddress.toLowerCase(),
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    };
  }
  async settle(payload: unknown): Promise<VerifiedPayment> {
    const p = record(payload);
    const accepted = record(p.accepted);
    const r = this.requirements;
    const extra = record(accepted.extra);
    if (
      p.x402Version !== 2 ||
      accepted.scheme !== r.scheme ||
      accepted.network !== r.network ||
      accepted.asset !== r.asset ||
      accepted.amount !== r.amount ||
      accepted.payTo !== r.payTo ||
      accepted.maxTimeoutSeconds !== r.maxTimeoutSeconds ||
      extra.name !== r.extra.name ||
      extra.version !== r.extra.version
    )
      throw new PaymentRejected();
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const request = {
      x402Version: 2,
      paymentPayload: p,
      paymentRequirements: r,
    };
    const invoke = async (path: string) => {
      const response = await fetchImpl(
        `${this.options.facilitatorUrl.replace(/\/$/, "")}/${path}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.options.facilitatorToken}`,
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(20_000),
          redirect: "manual",
        },
      );
      if (!response.ok) throw new PaymentUnavailable();
      return record(await response.json());
    };
    let receipt = await this.options.settlementReceipt?.load();
    if (!receipt) {
      const verified = await invoke("verify");
      if (
        verified.isValid !== true ||
        typeof verified.payer !== "string" ||
        !/^0x[0-9a-fA-F]{40}$/.test(verified.payer)
      )
        throw new PaymentRejected();
      const settled = await invoke("settle");
      if (
        settled.success !== true ||
        settled.network !== r.network ||
        typeof settled.transaction !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(settled.transaction) ||
        typeof settled.payer !== "string" ||
        settled.payer.toLowerCase() !== verified.payer.toLowerCase()
      )
        throw new PaymentRejected();
      receipt = {
        transaction: settled.transaction.toLowerCase(),
        network: r.network,
        payer: verified.payer.toLowerCase(),
      };
      await this.options.settlementReceipt?.save(receipt);
    }
    const { transaction } = receipt;
    const body = new URLSearchParams({
      amount: String(MACHINE_TOPUP_CENTS),
      currency: "usd",
      confirm: "true",
      "payment_method_data[type]": "crypto",
      "payment_method_options[crypto][mode]": "transaction_verification",
      "payment_method_options[crypto][transaction_verification_options][network]":
        "base",
      "payment_method_options[crypto][transaction_verification_options][transaction_hash]":
        transaction,
    });
    const response = await fetchImpl(
      "https://api.stripe.com/v1/payment_intents",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.stripeKey}`,
          "content-type": "application/x-www-form-urlencoded",
          "Stripe-Version": "2026-05-27.preview",
          "Idempotency-Key": `x402:${r.network}:${transaction}`,
        },
        body,
        signal: AbortSignal.timeout(20_000),
        redirect: "manual",
      },
    );
    if (!response.ok) throw new PaymentUnavailable();
    const pi = record(await response.json());
    if (
      pi.status !== "succeeded" ||
      pi.amount_received !== MACHINE_TOPUP_CENTS ||
      pi.amount !== MACHINE_TOPUP_CENTS ||
      pi.currency !== "usd" ||
      pi.livemode !== this.options.stripeKey.includes("_live_") ||
      typeof pi.id !== "string" ||
      !/^pi_[A-Za-z0-9]+$/.test(pi.id)
    )
      throw new PaymentUnavailable();
    return { paymentId: pi.id, ...receipt };
  }
}
