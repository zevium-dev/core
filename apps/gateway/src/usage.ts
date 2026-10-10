import { MAX_USAGE_INGEST_EVENTS } from "@zevium/shared";

/**
 * Usage event types + Convex batch flush client.
 * Wallet DO alarm drives flush → wallets:recordUsage → ack.
 */

/** Shape stored on pending settlements and sent to wallets:recordUsage. */
export type ConvexUsageRecord = {
  /** Publisher's Convex org id — kept for compatibility. */
  organizationId: string;
  /** Consumer's Clerk org id — recordUsage resolves this to the wallet debited. */
  consumerClerkOrgId: string;
  projectId: string;
  specVersionId: string;
  specVersion: string;
  operationId: string;
  endpoint: string;
  method: string;
  listedCostCredits: number;
  freeTierLimit?: number;
  freeTierUsedBefore?: number;
  pricingDecision: "listed_price" | "free_tier" | "zero_price";
  credits: number;
  status: number;
  latencyMs: number;
  keyId: string;
  keyFamilyId: string;
  monthlyCapCredits?: number;
  budgetPeriod: string;
  budgetUsedBefore: number;
  budgetReservedBefore: number;
  budgetReservationCredits: number;
  at: number;
  reservationId: string;
  settleRefId: string;
  billingOutcome: "settled" | "refunded" | "free";
  qualityOutcome: "success" | "client_error" | "server_error" | "network_error";
  ambiguous?: boolean;
  publisherIdempotencyKey?: string;
  releaseChallenge?: string;
  gatewayRelease?: string;
};

/**
 * Per-settlement result returned by the authoritative Convex ledger.
 * Every rejection explicitly states whether retry can change its outcome.
 */
export type SettlementOutcome =
  | { refId: string; status: "applied" | "already_applied" }
  | {
      refId: string;
      status: "rejected";
      reason: string;
      retryable: boolean;
    };

/** Transport/protocol failure with an exact retry classification. */
export class UsageIngestError extends Error {
  readonly retryable: boolean;
  readonly bisectable: boolean;

  constructor(
    message: string,
    retryable: boolean,
    options: { cause?: unknown; bisectable?: boolean } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "UsageIngestError";
    this.retryable = retryable;
    this.bisectable = options.bisectable === true;
  }
}

export type UsageFailureDisposition = "retryable" | "bisectable" | "blocked";

export function usageFailureDisposition(
  error: unknown,
): UsageFailureDisposition {
  if (!(error instanceof UsageIngestError) || error.retryable) {
    return "retryable";
  }
  return error.bisectable ? "bisectable" : "blocked";
}

function httpFailureIsRetryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Authoritative post-ingest checkpoint for the single consumer wallet batch. */
export type WalletCheckpoint = {
  clerkOrgId: string;
  balance: number;
  sequence: number;
};

export type RecordUsageResult = {
  results: SettlementOutcome[];
  wallet: WalletCheckpoint;
};

export type ConvexUsageClientOptions = {
  ingestUrl?: string;
  internalSecret?: string;
  fetchImpl?: typeof fetch;
  /** Test injection; production always uses the authenticated ingest endpoint. */
  mutationFn?: (
    name: string,
    args: { events: ConvexUsageRecord[] },
  ) => Promise<RecordUsageResult>;
};

/** Wallet alarm transport. No admin/public mutation fallback. */
export class ConvexUsageClient {
  readonly #mutationFn: ConvexUsageClientOptions["mutationFn"];
  readonly #ingestUrl: string | undefined;
  readonly #internalSecret: string | undefined;
  readonly #fetch: typeof fetch;
  constructor(opts: ConvexUsageClientOptions) {
    this.#mutationFn = opts.mutationFn;
    this.#ingestUrl = opts.ingestUrl;
    this.#internalSecret = opts.internalSecret;
    this.#fetch =
      opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async recordUsage(events: ConvexUsageRecord[]): Promise<RecordUsageResult> {
    if (events.length === 0) {
      throw new UsageIngestError(
        "recordUsage requires at least one settlement",
        false,
      );
    }
    if (events.length > MAX_USAGE_INGEST_EVENTS) {
      throw new UsageIngestError(
        `recordUsage accepts at most ${MAX_USAGE_INGEST_EVENTS} settlements`,
        false,
      );
    }
    const consumerClerkOrgId = events[0]!.consumerClerkOrgId;
    if (
      !events.every((event) => event.consumerClerkOrgId === consumerClerkOrgId)
    ) {
      throw new UsageIngestError(
        "usage batch contains multiple consumer wallets",
        false,
      );
    }
    if (
      new Set(events.map((event) => event.settleRefId)).size !== events.length
    ) {
      throw new UsageIngestError(
        "usage batch contains duplicate settlement references",
        false,
      );
    }
    if (this.#mutationFn) {
      try {
        return this.#validateResult(
          parseRecordUsageResult(
            await this.#mutationFn("wallets:recordUsage", { events }),
          ),
          events,
        );
      } catch (error) {
        if (error instanceof UsageIngestError) throw error;
        throw new UsageIngestError(
          error instanceof Error ? error.message : String(error),
          true,
          { cause: error },
        );
      }
    }

    if (!this.#ingestUrl || !this.#internalSecret) {
      throw new UsageIngestError("Usage ingest is not configured", false);
    }
    return this.#recordViaIngest(events);
  }

  async #recordViaIngest(
    events: ConvexUsageRecord[],
  ): Promise<RecordUsageResult> {
    const url = (this.#ingestUrl ?? "").replace(/\/+$/, "");
    const secret = this.#internalSecret ?? "";
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": secret,
        },
        body: JSON.stringify({ events }),
      });
    } catch (error) {
      throw new UsageIngestError("convex ingest transport failed", true, {
        cause: error,
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UsageIngestError(
        `convex ingest failed: ${res.status} ${text}`,
        httpFailureIsRetryable(res.status),
        {
          bisectable:
            res.status === 400 || res.status === 413 || res.status === 422,
        },
      );
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new UsageIngestError("convex ingest returned non-json", false);
    }
    return this.#validateResult(parseRecordUsageResult(json), events);
  }

  #validateResult(
    result: RecordUsageResult,
    events: ConvexUsageRecord[],
  ): RecordUsageResult {
    const consumerClerkOrgId = events[0]!.consumerClerkOrgId;
    if (result.wallet.clerkOrgId !== consumerClerkOrgId) {
      throw new UsageIngestError(
        "convex checkpoint wallet does not match usage batch",
        false,
      );
    }
    const expected = new Set(events.map((event) => event.settleRefId));
    const received = new Set<string>();
    for (const outcome of result.results) {
      if (!expected.has(outcome.refId) || received.has(outcome.refId)) {
        throw new UsageIngestError(
          "convex ingest returned unexpected settlement outcomes",
          false,
        );
      }
      received.add(outcome.refId);
    }
    if (received.size !== expected.size) {
      throw new UsageIngestError(
        "convex ingest omitted settlement outcomes",
        false,
      );
    }
    return result;
  }
}

export function pendingToUsageRecord(input: {
  settlementId: string;
  reservationId: string;
  cost: number;
  settledAt: number;
  organizationId: string;
  consumerClerkOrgId: string;
  projectId: string;
  specVersionId: string;
  specVersion: string;
  operationId: string;
  endpoint: string;
  method: string;
  listedCostCredits: number;
  freeTierLimit?: number;
  freeTierUsedBefore?: number;
  pricingDecision: "listed_price" | "free_tier" | "zero_price";
  status: number;
  latencyMs: number;
  keyId: string;
  billingOutcome: ConvexUsageRecord["billingOutcome"];
  qualityOutcome: ConvexUsageRecord["qualityOutcome"];
  keyFamilyId: string;
  monthlyCapCredits?: number;
  budgetPeriod: string;
  budgetUsedBefore: number;
  budgetReservedBefore: number;
  budgetReservationCredits: number;
  ambiguous?: boolean;
  publisherIdempotencyKey?: string;
  releaseChallenge?: string;
  gatewayRelease?: string;
}): ConvexUsageRecord {
  return {
    organizationId: input.organizationId,
    consumerClerkOrgId: input.consumerClerkOrgId,
    projectId: input.projectId,
    specVersionId: input.specVersionId,
    specVersion: input.specVersion,
    operationId: input.operationId,
    endpoint: input.endpoint,
    method: input.method,
    listedCostCredits: input.listedCostCredits,
    freeTierLimit: input.freeTierLimit,
    freeTierUsedBefore: input.freeTierUsedBefore,
    pricingDecision: input.pricingDecision,
    credits: input.cost,
    status: input.status,
    latencyMs: input.latencyMs,
    keyId: input.keyId,
    keyFamilyId: input.keyFamilyId,
    monthlyCapCredits: input.monthlyCapCredits,
    budgetPeriod: input.budgetPeriod,
    budgetUsedBefore: input.budgetUsedBefore,
    budgetReservedBefore: input.budgetReservedBefore,
    budgetReservationCredits: input.budgetReservationCredits,
    at: input.settledAt,
    reservationId: input.reservationId,
    settleRefId: input.settlementId,
    billingOutcome: input.billingOutcome,
    qualityOutcome: input.qualityOutcome,
    ...(input.ambiguous === undefined ? {} : { ambiguous: input.ambiguous }),
    ...(input.publisherIdempotencyKey === undefined
      ? {}
      : { publisherIdempotencyKey: input.publisherIdempotencyKey }),
    ...(input.releaseChallenge
      ? { releaseChallenge: input.releaseChallenge }
      : {}),
    ...(input.gatewayRelease ? { gatewayRelease: input.gatewayRelease } : {}),
  };
}

function parseRecordUsageResult(value: unknown): RecordUsageResult {
  if (!value || typeof value !== "object") {
    throw new UsageIngestError("convex ingest returned invalid result", false);
  }
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.results)) {
    throw new UsageIngestError(
      "convex ingest result missing settlement outcomes",
      false,
    );
  }
  const results: SettlementOutcome[] = [];
  for (const raw of result.results) {
    if (!raw || typeof raw !== "object") {
      throw new UsageIngestError(
        "convex ingest result has invalid settlement outcome",
        false,
      );
    }
    const outcome = raw as Record<string, unknown>;
    const status = outcome.status;
    if (
      typeof outcome.refId !== "string" ||
      outcome.refId.length === 0 ||
      (status !== "applied" &&
        status !== "already_applied" &&
        status !== "rejected") ||
      (status === "rejected"
        ? typeof outcome.reason !== "string" ||
          outcome.reason.length === 0 ||
          typeof outcome.retryable !== "boolean"
        : outcome.reason !== undefined || outcome.retryable !== undefined)
    ) {
      throw new UsageIngestError(
        "convex ingest result has invalid settlement outcome",
        false,
      );
    }
    results.push(
      status === "rejected"
        ? {
            refId: outcome.refId,
            status,
            reason: outcome.reason as string,
            retryable: outcome.retryable as boolean,
          }
        : { refId: outcome.refId, status },
    );
  }

  if (!result.wallet || typeof result.wallet !== "object") {
    throw new UsageIngestError(
      "convex ingest result missing wallet checkpoint",
      false,
    );
  }
  const wallet = result.wallet as Record<string, unknown>;
  if (
    typeof wallet.clerkOrgId !== "string" ||
    wallet.clerkOrgId.length === 0 ||
    typeof wallet.balance !== "number" ||
    !Number.isFinite(wallet.balance) ||
    typeof wallet.sequence !== "number" ||
    !Number.isSafeInteger(wallet.sequence) ||
    wallet.sequence < -1
  ) {
    throw new UsageIngestError(
      "convex ingest result has invalid wallet checkpoint",
      false,
    );
  }
  return {
    results,
    wallet: {
      clerkOrgId: wallet.clerkOrgId,
      balance: wallet.balance,
      sequence: wallet.sequence,
    },
  };
}
