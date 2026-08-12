/**
 * Usage event types + Convex batch flush client.
 * Wallet DO alarm drives flush → wallets:recordUsage → ack.
 */

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

/** Hot-path event emitted by the pipeline (tests / optional logging). */
export type UsageEvent = {
  requestId: string;
  /** Publisher's Convex org id — kept for compatibility. */
  organizationId: string;
  /** Consumer's Clerk org id — the org whose wallet actually pays. */
  consumerClerkOrgId: string;
  projectId: string;
  keyId: string;
  orgSlug: string;
  projectSlug: string;
  method: string;
  pathTemplate: string;
  cost: number;
  status: number;
  /** settled | refunded | blocked | free */
  outcome: "settled" | "refunded" | "blocked" | "free";
  latencyMs: number;
  reservationId: string;
};

/** Shape stored on pending settlements and sent to wallets:recordUsage. */
export type ConvexUsageRecord = {
  /** Publisher's Convex org id — kept for compatibility. */
  organizationId: string;
  /** Consumer's Clerk org id — recordUsage resolves this to the wallet debited. */
  consumerClerkOrgId: string;
  projectId: string;
  endpoint: string;
  method: string;
  credits: number;
  status: number;
  latencyMs: number;
  keyId: string;
  at: number;
  settleRefId: string;
  reservationProof?: {
    checkpointSequence: number;
    authorizedBalance: number;
    reservedAt: number;
    signature: string;
  };
};

export type SettlementOutcomeStatus =
  "applied" | "already_applied" | "rejected";

/**
 * Per-settlement result returned by the authoritative Convex ledger.
 * Only applied outcomes may be removed from the DO retry queue.
 */
export type SettlementOutcome = {
  refId: string;
  status: SettlementOutcomeStatus;
  reason?: string;
  retryable?: boolean;
};

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
        type: "zevium.usage",
        ...event,
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
  emit(_event: UsageEvent): void {}
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
      throw new Error("recordUsage requires at least one settlement");
    }
    if (this.#mutationFn) {
      return this.#validateResult(
        await this.#mutationFn("wallets:recordUsage", { events }),
        events,
      );
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
      throw new Error("ConvexUsageClient has no client");
    }
    const result = await this.#client.mutation(recordUsageRef, { events });
    return this.#validateResult(parseRecordUsageResult(result), events);
  }

  async #recordViaIngest(
    events: ConvexUsageRecord[],
  ): Promise<RecordUsageResult> {
    const url = (this.#ingestUrl ?? "").replace(/\/+$/, "");
    const secret = this.#internalSecret ?? "";
    const res = await this.#fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": secret,
      },
      body: JSON.stringify({ events }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`convex ingest failed: ${res.status} ${text}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new Error("convex ingest returned non-json");
    }
    return this.#validateResult(parseRecordUsageResult(json), events);
  }

  async #mutationWithAdmin(
    path: string,
    args: { events: ConvexUsageRecord[] },
    adminKey: string,
  ): Promise<RecordUsageResult> {
    const base = (this.#convexUrl ?? "").replace(/\/+$/, "");
    const res = await this.#fetch(`${base}/api/mutation`, {
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
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`convex mutation failed: ${res.status} ${text}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new Error("convex mutation returned non-json");
    }
    if (!json || typeof json !== "object") {
      throw new Error("convex mutation invalid response");
    }
    if ("status" in json && json.status === "error") {
      const msg =
        "errorMessage" in json && typeof json.errorMessage === "string"
          ? json.errorMessage
          : "convex mutation error";
      throw new Error(msg);
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
    if (
      !events.every((event) => event.consumerClerkOrgId === consumerClerkOrgId)
    ) {
      throw new Error("usage batch contains multiple consumer wallets");
    }
    if (result.wallet.clerkOrgId !== consumerClerkOrgId) {
      throw new Error("convex checkpoint wallet does not match usage batch");
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
  return {
    organizationId: event.organizationId,
    consumerClerkOrgId: event.consumerClerkOrgId,
    projectId: event.projectId,
    endpoint: event.pathTemplate,
    method: event.method,
    credits: event.cost,
    status: event.status,
    latencyMs: event.latencyMs,
    keyId: event.keyId,
    at: Date.now(),
    settleRefId: `settle:${event.reservationId}`,
  };
}

export function pendingToUsageRecord(input: {
  settlementId: string;
  cost: number;
  settledAt: number;
  organizationId: string;
  consumerClerkOrgId: string;
  projectId: string;
  endpoint: string;
  method: string;
  status: number;
  latencyMs: number;
  keyId: string;
  reservationProof?: ConvexUsageRecord["reservationProof"];
}): ConvexUsageRecord {
  return {
    organizationId: input.organizationId,
    consumerClerkOrgId: input.consumerClerkOrgId,
    projectId: input.projectId,
    endpoint: input.endpoint,
    method: input.method,
    credits: input.cost,
    status: input.status,
    latencyMs: input.latencyMs,
    keyId: input.keyId,
    at: input.settledAt,
    settleRefId: input.settlementId,
    ...(input.reservationProof
      ? { reservationProof: input.reservationProof }
      : {}),
  };
}

function parseRecordUsageResult(value: unknown): RecordUsageResult {
  if (!value || typeof value !== "object") {
    throw new Error("convex ingest returned invalid result");
  }
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.results)) {
    throw new Error("convex ingest result missing settlement outcomes");
  }
  const results: SettlementOutcome[] = [];
  for (const raw of result.results) {
    if (!raw || typeof raw !== "object") {
      throw new Error("convex ingest result has invalid settlement outcome");
    }
    const outcome = raw as Record<string, unknown>;
    const status = outcome.status;
    if (
      typeof outcome.refId !== "string" ||
      outcome.refId.length === 0 ||
      (status !== "applied" &&
        status !== "already_applied" &&
        status !== "rejected") ||
      (outcome.reason !== undefined && typeof outcome.reason !== "string") ||
      (outcome.retryable !== undefined &&
        typeof outcome.retryable !== "boolean")
    ) {
      throw new Error("convex ingest result has invalid settlement outcome");
    }
    const parsed: SettlementOutcome = {
      refId: outcome.refId,
      status,
    };
    if (typeof outcome.reason === "string") parsed.reason = outcome.reason;
    if (typeof outcome.retryable === "boolean") {
      parsed.retryable = outcome.retryable;
    }
    results.push(parsed);
  }

  if (!result.wallet || typeof result.wallet !== "object") {
    throw new Error("convex ingest result missing wallet checkpoint");
  }
  const wallet = result.wallet as Record<string, unknown>;
  if (
    typeof wallet.clerkOrgId !== "string" ||
    wallet.clerkOrgId.length === 0 ||
    typeof wallet.balance !== "number" ||
    !Number.isFinite(wallet.balance) ||
    typeof wallet.sequence !== "number" ||
    !Number.isSafeInteger(wallet.sequence) ||
    wallet.sequence < 0
  ) {
    throw new Error("convex ingest result has invalid wallet checkpoint");
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
