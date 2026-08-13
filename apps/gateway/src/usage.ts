/**
 * Usage event types + Convex batch flush client.
 * Wallet DO alarm drives flush → wallets:recordUsage → ack.
 */

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { MAX_USAGE_INGEST_EVENTS } from "@zevium/shared";

import { costBucket, latencyBucket } from "./telemetry";

/** Hot-path event emitted by the pipeline (tests / optional logging). */
export type UsageEvent = {
  requestId: string;
  /** Publisher's Convex org id — kept for compatibility. */
  organizationId: string;
  /** Consumer's Clerk org id — the org whose wallet actually pays. */
  consumerClerkOrgId: string;
  projectId: string;
  specVersionId: string;
  specVersion: string;
  operationId: string;
  keyId: string;
  keyFamilyId?: string;
  orgSlug: string;
  projectSlug: string;
  method: string;
  pathTemplate: string;
  listedCostCredits?: number;
  freeTierLimit?: number;
  freeTierUsedBefore?: number;
  pricingDecision?: "listed_price" | "free_tier" | "zero_price";
  monthlyCapCredits?: number;
  budgetPeriod?: string;
  budgetUsedBefore?: number;
  budgetReservedBefore?: number;
  budgetReservationCredits?: number;
  cost: number;
  status: number;
  /** settled | ambiguous | refunded | blocked | free */
  outcome: "settled" | "ambiguous" | "refunded" | "blocked" | "free";
  /** Transport truth when no upstream HTTP response existed. */
  qualityOutcome?: "network_error";
  ambiguous?: boolean;
  publisherIdempotencyKey?: string;
  latencyMs: number;
  reservationId: string;
  /** Runner-generated one-time release correlation, when this is a probe. */
  releaseChallenge?: string;
  /** Immutable gateway git SHA serving this request. */
  gatewayRelease?: string;
};

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

export interface UsageSink {
  emit(event: UsageEvent): Promise<void> | void;
}

export class ConsoleUsageSink implements UsageSink {
  emit(event: UsageEvent): void {
    console.log(
      JSON.stringify({
        schema: 1,
        type: "zevium.usage",
        outcome: event.outcome,
        statusClass: `${Math.floor(event.status / 100)}xx`,
        latencyBucket: latencyBucket(event.latencyMs),
        costBucket: costBucket(event.cost),
      }),
    );
  }
}

/** Collecting sink for tests. */
export class CollectingUsageSink implements UsageSink {
  readonly events: UsageEvent[] = [];

  emit(event: UsageEvent): void {
    this.events.push(event);
  }
}

export class NoopUsageSink implements UsageSink {
  emit(): void {}
}

const recordUsageRef = makeFunctionReference<
  "mutation",
  { events: ConvexUsageRecord[] },
  RecordUsageResult
>("wallets:recordUsage");

export type ConvexUsageClientOptions = {
  convexUrl: string;
  /**
   * Deploy/admin key so internalMutation wallets:recordUsage is callable.
   * Authorization: Convex <key>
   * Fallback only — prefer ingestUrl + internalSecret.
   */
  adminKey?: string;
  /**
   * POST target for shared-secret ingest (Convex httpAction /ingest-usage).
   * When set with internalSecret, preferred over adminKey / public client.
   */
  ingestUrl?: string;
  /** Shared secret for x-internal-secret header on ingest path. */
  internalSecret?: string;
  fetchImpl?: typeof fetch;
  /** Injected client (tests). */
  client?: ConvexHttpClient;
  /** Injected mutation (tests) — bypasses HTTP entirely. */
  mutationFn?: (
    name: string,
    args: { events: ConvexUsageRecord[] },
  ) => Promise<RecordUsageResult>;
};

/**
 * Thin client around wallets:recordUsage.
 * Used by the wallet DO alarm flush loop (not the request hot path).
 */
export class ConvexUsageClient {
  readonly #client: ConvexHttpClient | null;
  readonly #mutationFn:
    | ((
        name: string,
        args: { events: ConvexUsageRecord[] },
      ) => Promise<RecordUsageResult>)
    | null;
  readonly #convexUrl: string | null;
  readonly #adminKey: string | undefined;
  readonly #ingestUrl: string | undefined;
  readonly #internalSecret: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(opts: ConvexUsageClientOptions) {
    this.#mutationFn = opts.mutationFn ?? null;
    this.#adminKey = opts.adminKey;
    this.#ingestUrl = opts.ingestUrl;
    this.#internalSecret = opts.internalSecret;
    // workerd fetch is not free-callable; wrap so stored ref keeps `this`.
    this.#fetch =
      opts.fetchImpl ??
      ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    if (opts.mutationFn) {
      this.#client = null;
      this.#convexUrl = null;
    } else if (opts.client) {
      this.#client = opts.client;
      this.#convexUrl = opts.convexUrl.replace(/\/+$/, "");
    } else if (opts.ingestUrl && opts.internalSecret) {
      // Ingest path needs no ConvexHttpClient.
      this.#client = null;
      this.#convexUrl = opts.convexUrl.replace(/\/+$/, "");
    } else {
      this.#client = new ConvexHttpClient(opts.convexUrl, {
        skipConvexDeploymentUrlCheck: true,
        logger: false,
        fetch: opts.fetchImpl,
      });
      this.#convexUrl = opts.convexUrl.replace(/\/+$/, "");
    }
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

    // Prefer shared-secret httpAction over deploy-key mutation.
    if (this.#ingestUrl && this.#internalSecret) {
      return await this.#recordViaIngest(events);
    }

    // Prefer raw HTTP when admin key present — setAdminAuth is @internal
    // and not on public ConvexHttpClient typings.
    if (this.#adminKey && this.#convexUrl) {
      return await this.#mutationWithAdmin(
        "wallets:recordUsage",
        { events },
        this.#adminKey,
      );
    }

    if (!this.#client) {
      throw new UsageIngestError("ConvexUsageClient has no client", false);
    }
    let result: RecordUsageResult;
    try {
      result = await this.#client.mutation(recordUsageRef, { events });
    } catch (error) {
      throw new UsageIngestError("convex mutation transport failed", true, {
        cause: error,
      });
    }
    return this.#validateResult(parseRecordUsageResult(result), events);
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

  async #mutationWithAdmin(
    path: string,
    args: { events: ConvexUsageRecord[] },
    adminKey: string,
  ): Promise<RecordUsageResult> {
    const base = (this.#convexUrl ?? "").replace(/\/+$/, "");
    let res: Response;
    try {
      res = await this.#fetch(`${base}/api/mutation`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Convex ${adminKey}`,
        },
        body: JSON.stringify({
          path,
          format: "json",
          args: [args],
        }),
      });
    } catch (error) {
      throw new UsageIngestError("convex mutation transport failed", true, {
        cause: error,
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UsageIngestError(
        `convex mutation failed: ${res.status} ${text}`,
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
      throw new UsageIngestError("convex mutation returned non-json", false);
    }
    if (!json || typeof json !== "object") {
      throw new UsageIngestError("convex mutation invalid response", false);
    }
    if ("status" in json && json.status === "error") {
      const msg =
        "errorMessage" in json && typeof json.errorMessage === "string"
          ? json.errorMessage
          : "convex mutation error";
      throw new UsageIngestError(msg, false, { bisectable: true });
    }
    const value =
      "status" in json && json.status === "success" && "value" in json
        ? json.value
        : json;
    return this.#validateResult(parseRecordUsageResult(value), args.events);
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

/**
 * Batched UsageSink that also exposes flushBatch for the DO / tests.
 * emit() only buffers; flushBatch() POSTs to Convex and clears acked ids.
 */
export class ConvexUsageSink implements UsageSink {
  readonly #client: ConvexUsageClient;
  readonly #pending: ConvexUsageRecord[] = [];

  constructor(opts: ConvexUsageClientOptions) {
    this.#client = new ConvexUsageClient(opts);
  }

  /** Buffer a pipeline event as a Convex usage record (settled/free only). */
  emit(event: UsageEvent): void {
    if (event.outcome !== "settled" && event.outcome !== "free") return;
    this.#pending.push(usageEventToRecord(event));
  }

  /** Direct enqueue from wallet DO pending rows. */
  enqueue(records: ConvexUsageRecord[]): void {
    for (const r of records) this.#pending.push(r);
  }

  get pending(): readonly ConvexUsageRecord[] {
    return this.#pending;
  }

  /**
   * Flush buffered events (or explicit batch) to Convex.
   * Returns applied/skipped; caller acks settlement ids on success.
   */
  async flushBatch(
    events?: ConvexUsageRecord[],
  ): Promise<
    | (RecordUsageResult & { settleRefIds: string[] })
    | { results: SettlementOutcome[]; settleRefIds: string[] }
  > {
    const batch = events ?? this.#pending.splice(0, this.#pending.length);
    if (batch.length === 0) {
      return { results: [], settleRefIds: [] };
    }
    const result = await this.#client.recordUsage(batch);
    return {
      ...result,
      settleRefIds: batch.map((e) => e.settleRefId),
    };
  }
}

export function usageEventToRecord(event: UsageEvent): ConvexUsageRecord {
  if (
    event.specVersionId === undefined ||
    event.specVersion === undefined ||
    event.operationId === undefined ||
    event.keyFamilyId === undefined ||
    event.listedCostCredits === undefined ||
    event.pricingDecision === undefined ||
    event.budgetPeriod === undefined ||
    event.budgetUsedBefore === undefined ||
    event.budgetReservedBefore === undefined ||
    event.budgetReservationCredits === undefined
  ) {
    throw new Error("settled usage lacks immutable pricing identity");
  }
  return {
    organizationId: event.organizationId,
    consumerClerkOrgId: event.consumerClerkOrgId,
    projectId: event.projectId,
    specVersionId: event.specVersionId,
    specVersion: event.specVersion,
    operationId: event.operationId,
    endpoint: event.pathTemplate,
    method: event.method,
    listedCostCredits: event.listedCostCredits,
    freeTierLimit: event.freeTierLimit,
    freeTierUsedBefore: event.freeTierUsedBefore,
    pricingDecision: event.pricingDecision,
    credits: event.cost,
    status: event.status,
    latencyMs: event.latencyMs,
    keyId: event.keyId,
    keyFamilyId: event.keyFamilyId,
    monthlyCapCredits: event.monthlyCapCredits,
    budgetPeriod: event.budgetPeriod,
    budgetUsedBefore: event.budgetUsedBefore,
    budgetReservedBefore: event.budgetReservedBefore,
    budgetReservationCredits: event.budgetReservationCredits,
    at: Date.now(),
    reservationId: event.reservationId,
    settleRefId: `settle:${event.reservationId}`,
    billingOutcome:
      event.outcome === "free"
        ? "free"
        : event.outcome === "settled" || event.outcome === "ambiguous"
          ? "settled"
          : "refunded",
    qualityOutcome:
      event.qualityOutcome ??
      (event.status >= 200 && event.status < 300
        ? "success"
        : event.status >= 400 && event.status < 500
          ? "client_error"
          : event.status >= 500
            ? "server_error"
            : "network_error"),
    ...(event.ambiguous === undefined ? {} : { ambiguous: event.ambiguous }),
    ...(event.publisherIdempotencyKey === undefined
      ? {}
      : { publisherIdempotencyKey: event.publisherIdempotencyKey }),
    ...(event.releaseChallenge
      ? { releaseChallenge: event.releaseChallenge }
      : {}),
    ...(event.gatewayRelease ? { gatewayRelease: event.gatewayRelease } : {}),
  };
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

/** Test-only fake Convex mutation sink with ack-friendly bookkeeping. */
export class FakeConvexUsageSink {
  readonly batches: ConvexUsageRecord[][] = [];
  readonly records: ConvexUsageRecord[] = [];
  readonly seenSettleRefIds = new Set<string>();
  readonly #wallets = new Map<string, WalletCheckpoint>();
  failNext = false;

  setWallet(clerkOrgId: string, balance: number, sequence: number = 0): void {
    this.#wallets.set(clerkOrgId, { clerkOrgId, balance, sequence });
  }

  async recordUsage(events: ConvexUsageRecord[]): Promise<RecordUsageResult> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("fake convex unavailable"));
    }
    this.batches.push(events.map((e) => ({ ...e })));
    const clerkOrgId = events[0]?.consumerClerkOrgId;
    if (
      !clerkOrgId ||
      events.some((event) => event.consumerClerkOrgId !== clerkOrgId)
    ) {
      return Promise.reject(new Error("mixed consumer wallet batch"));
    }
    const checkpoint = this.#wallets.get(clerkOrgId) ?? {
      clerkOrgId,
      balance: 0,
      sequence: 0,
    };
    const results: SettlementOutcome[] = [];
    for (const e of events) {
      if (this.seenSettleRefIds.has(e.settleRefId)) {
        results.push({ refId: e.settleRefId, status: "already_applied" });
        continue;
      }
      this.seenSettleRefIds.add(e.settleRefId);
      this.records.push({ ...e });
      checkpoint.balance -= e.credits;
      checkpoint.sequence += 1;
      results.push({ refId: e.settleRefId, status: "applied" });
    }
    this.#wallets.set(clerkOrgId, checkpoint);
    return { results, wallet: { ...checkpoint } };
  }

  asMutationFn(): (
    name: string,
    args: { events: ConvexUsageRecord[] },
  ) => Promise<RecordUsageResult> {
    return async (_name, args) => this.recordUsage(args.events);
  }
}
