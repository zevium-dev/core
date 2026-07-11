/**
 * Wallet Durable Object — per-org working balance with crash-safe holds.
 *
 * BALANCE MODEL
 * -------------
 * - `balance` is the working balance: grants applied, settled usage already
 *   subtracted (whether or not the settlement has been flushed to the ledger).
 * - `inFlight` holds temporary reservations. Available credit is:
 *     available = balance - sum(inFlight.costs)
 * - reserve: fail if available < cost (or cost <= 0). ZERO balance blocks.
 * - settle: remove from inFlight, balance -= cost, enqueue pending settlement
 *   (atomic). Settlement id is stable: `settle:${reservationId}`.
 * - refund: remove from inFlight only (credit returns to available).
 * - grant: if new grantId, balance += amount, record grantId (idempotent).
 * - flush/ack: flush returns all pending settlements (stable ids). After the
 *   ledger appends them, ack removes them. If ack is lost, re-flush yields the
 *   same settlement ids; the ledger dedupes by settlementId.
 * - free tier: per-key per-UTC-day counters; free calls skip reserve/settle
 *   but still enqueue pending usage with credits 0.
 * - alarm (~5s): when pending non-empty, batch → wallets:recordUsage → ack.
 *
 * Crash-safety: multi-key updates go through storage.transaction. State is
 * loaded in the constructor under blockConcurrencyWhile so concurrent
 * requests never see a half-loaded wallet.
 */

import { DurableObject } from "cloudflare:workers";
import {
  ConvexUsageClient,
  pendingToUsageRecord,
  type ConvexUsageRecord,
} from "./usage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InFlightEntry = {
  cost: number;
  createdAt: number;
};

/** Usage metadata required to flush a settlement to Convex. */
export type SettlementUsage = {
  organizationId: string;
  projectId: string;
  endpoint: string;
  method: string;
  status: number;
  latencyMs: number;
  keyId: string;
};

export type PendingSettlement = {
  settlementId: string;
  reservationId: string;
  cost: number;
  settledAt: number;
  /** Present for production flush path; unit tests may omit. */
  usage?: SettlementUsage;
};

/** Terminal outcome of a reservation once it leaves inFlight. */
export type TerminalStatus = "settled" | "refunded" | "free";

export type WalletState = {
  balance: number;
  inFlightTotal: number;
  inFlight: Record<string, InFlightEntry>;
  appliedGrantIds: string[];
  pendingSettlements: PendingSettlement[];
  available: number;
};

export type GrantResult =
  | { status: "applied"; balance: number }
  | { status: "duplicate"; balance: number }
  | { status: "rejected"; reason: string };

export type ReserveResult =
  | { status: "reserved"; available: number }
  | { status: "duplicate"; available: number }
  | { status: "conflict"; reason: string }
  | { status: "insufficient"; available: number; cost: number }
  | { status: "rejected"; reason: string };

export type SettleResult =
  | { status: "settled"; settlementId: string; balance: number }
  | { status: "already_settled"; settlementId: string }
  | { status: "already_refunded" }
  | { status: "already_free" }
  | { status: "unknown" };

export type RefundResult =
  | { status: "refunded"; available: number }
  | { status: "already_refunded" }
  | { status: "already_settled"; settlementId: string }
  | { status: "already_free" }
  | { status: "unknown" };

export type FreeTierResult =
  | { status: "consumed"; used: number; limit: number }
  | { status: "exhausted"; used: number; limit: number }
  | { status: "rejected"; reason: string };

export type EnqueueFreeResult =
  | { status: "enqueued"; settlementId: string }
  | { status: "duplicate"; settlementId: string }
  | { status: "rejected"; reason: string };

export type FlushResult = {
  batchId: string;
  settlements: PendingSettlement[];
};

export type AckFlushResult = {
  removed: number;
  remaining: number;
};

export type FlushToConvexResult = {
  flushed: number;
  acked: number;
  remaining: number;
  error?: string;
};

// Storage keys
const K_BALANCE = "balance";
const K_IN_FLIGHT = "inFlight";
const K_APPLIED_GRANTS = "appliedGrantIds";
const K_PENDING = "pendingSettlements";
const K_TERMINAL = "terminalReservations";
const K_FLUSH_SEQ = "flushSeq";
const K_FREE_PREFIX = "free:";

const FLUSH_ALARM_MS = 5_000;

function settlementIdFor(reservationId: string): string {
  return `settle:${reservationId}`;
}

function sumInFlight(inFlight: Record<string, InFlightEntry>): number {
  let total = 0;
  for (const entry of Object.values(inFlight)) {
    total += entry.cost;
  }
  return total;
}

/** UTC calendar day key YYYY-MM-DD. */
export function utcDayKey(ms: number = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function freeStorageKey(keyId: string, day: string): string {
  return `${K_FREE_PREFIX}${keyId}:${day}`;
}

// ---------------------------------------------------------------------------
// WalletDO
// ---------------------------------------------------------------------------

export class WalletDO extends DurableObject<Cloudflare.Env> {
  #balance = 0;
  #inFlight: Record<string, InFlightEntry> = {};
  #appliedGrantIds: Set<string> = new Set();
  #pendingSettlements: PendingSettlement[] = [];
  #terminal: Record<string, TerminalStatus> = {};
  #flushSeq = 0;
  #loaded = false;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Block concurrent requests until state is fully loaded from storage.
    this.ctx.blockConcurrencyWhile(async () => {
      await this.#load();
    });
  }

  async #load(): Promise<void> {
    const stored = await this.ctx.storage.get<
      | number
      | Record<string, InFlightEntry>
      | string[]
      | PendingSettlement[]
      | Record<string, TerminalStatus>
    >([
      K_BALANCE,
      K_IN_FLIGHT,
      K_APPLIED_GRANTS,
      K_PENDING,
      K_TERMINAL,
      K_FLUSH_SEQ,
    ]);

    this.#balance = (stored.get(K_BALANCE) as number | undefined) ?? 0;
    this.#inFlight =
      (stored.get(K_IN_FLIGHT) as Record<string, InFlightEntry> | undefined) ??
      {};
    const grants = (stored.get(K_APPLIED_GRANTS) as string[] | undefined) ?? [];
    this.#appliedGrantIds = new Set(grants);
    this.#pendingSettlements =
      (stored.get(K_PENDING) as PendingSettlement[] | undefined) ?? [];
    this.#terminal =
      (stored.get(K_TERMINAL) as Record<string, TerminalStatus> | undefined) ??
      {};
    this.#flushSeq = (stored.get(K_FLUSH_SEQ) as number | undefined) ?? 0;
    this.#loaded = true;
  }

  #available(): number {
    return this.#balance - sumInFlight(this.#inFlight);
  }

  #snapshot(): WalletState {
    const inFlightTotal = sumInFlight(this.#inFlight);
    return {
      balance: this.#balance,
      inFlightTotal,
      inFlight: { ...this.#inFlight },
      appliedGrantIds: [...this.#appliedGrantIds],
      pendingSettlements: this.#pendingSettlements.map((s) => ({ ...s })),
      available: this.#balance - inFlightTotal,
    };
  }

  async #persist(
    keys: Partial<{
      balance: number;
      inFlight: Record<string, InFlightEntry>;
      appliedGrantIds: string[];
      pendingSettlements: PendingSettlement[];
      terminal: Record<string, TerminalStatus>;
      flushSeq: number;
    }>,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      if (keys.balance !== undefined) await txn.put(K_BALANCE, keys.balance);
      if (keys.inFlight !== undefined)
        await txn.put(K_IN_FLIGHT, keys.inFlight);
      if (keys.appliedGrantIds !== undefined)
        await txn.put(K_APPLIED_GRANTS, keys.appliedGrantIds);
      if (keys.pendingSettlements !== undefined)
        await txn.put(K_PENDING, keys.pendingSettlements);
      if (keys.terminal !== undefined) await txn.put(K_TERMINAL, keys.terminal);
      if (keys.flushSeq !== undefined)
        await txn.put(K_FLUSH_SEQ, keys.flushSeq);
    });
  }

  async #scheduleFlushAlarm(): Promise<void> {
    if (this.#pendingSettlements.length === 0) return;
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null && existing !== undefined) return;
    await this.ctx.storage.setAlarm(Date.now() + FLUSH_ALARM_MS);
  }

  // -------------------------------------------------------------------------
  // RPC operations
  // -------------------------------------------------------------------------

  async grant(grantId: string, amount: number): Promise<GrantResult> {
    if (!grantId || typeof grantId !== "string") {
      return { status: "rejected", reason: "grantId required" };
    }
    if (!(amount > 0) || !Number.isFinite(amount)) {
      return { status: "rejected", reason: "amount must be > 0" };
    }

    if (this.#appliedGrantIds.has(grantId)) {
      return { status: "duplicate", balance: this.#balance };
    }

    this.#appliedGrantIds.add(grantId);
    this.#balance += amount;

    await this.#persist({
      balance: this.#balance,
      appliedGrantIds: [...this.#appliedGrantIds],
    });

    return { status: "applied", balance: this.#balance };
  }

  async reserve(reservationId: string, cost: number): Promise<ReserveResult> {
    if (!reservationId || typeof reservationId !== "string") {
      return { status: "rejected", reason: "reservationId required" };
    }
    if (!(cost > 0) || !Number.isFinite(cost)) {
      return { status: "rejected", reason: "cost must be > 0" };
    }

    const existing = this.#inFlight[reservationId];
    if (existing) {
      if (existing.cost === cost) {
        return { status: "duplicate", available: this.#available() };
      }
      return {
        status: "conflict",
        reason: `reservation ${reservationId} already held at cost ${existing.cost}`,
      };
    }

    const terminal = this.#terminal[reservationId];
    if (terminal) {
      return {
        status: "conflict",
        reason: `reservation ${reservationId} already ${terminal}`,
      };
    }

    const available = this.#available();
    if (available < cost) {
      return { status: "insufficient", available, cost };
    }

    this.#inFlight[reservationId] = { cost, createdAt: Date.now() };
    await this.#persist({ inFlight: { ...this.#inFlight } });

    return { status: "reserved", available: this.#available() };
  }

  async settle(
    reservationId: string,
    usage?: SettlementUsage,
  ): Promise<SettleResult> {
    if (!reservationId) return { status: "unknown" };

    const terminal = this.#terminal[reservationId];
    if (terminal === "settled") {
      return {
        status: "already_settled",
        settlementId: settlementIdFor(reservationId),
      };
    }
    if (terminal === "refunded") {
      return { status: "already_refunded" };
    }
    if (terminal === "free") {
      return { status: "already_free" };
    }

    const entry = this.#inFlight[reservationId];
    if (!entry) {
      return { status: "unknown" };
    }

    const settlementId = settlementIdFor(reservationId);
    const settledAt = Date.now();
    const { cost } = entry;

    delete this.#inFlight[reservationId];
    this.#balance -= cost;
    this.#terminal[reservationId] = "settled";
    const pending: PendingSettlement = {
      settlementId,
      reservationId,
      cost,
      settledAt,
    };
    if (usage) pending.usage = usage;
    this.#pendingSettlements.push(pending);

    await this.#persist({
      balance: this.#balance,
      inFlight: { ...this.#inFlight },
      pendingSettlements: this.#pendingSettlements.map((s) => ({ ...s })),
      terminal: { ...this.#terminal },
    });
    await this.#scheduleFlushAlarm();

    return { status: "settled", settlementId, balance: this.#balance };
  }

  async refund(reservationId: string): Promise<RefundResult> {
    if (!reservationId) return { status: "unknown" };

    const terminal = this.#terminal[reservationId];
    if (terminal === "refunded") {
      return { status: "already_refunded" };
    }
    if (terminal === "settled") {
      return {
        status: "already_settled",
        settlementId: settlementIdFor(reservationId),
      };
    }
    if (terminal === "free") {
      return { status: "already_free" };
    }

    const entry = this.#inFlight[reservationId];
    if (!entry) {
      return { status: "unknown" };
    }

    delete this.#inFlight[reservationId];
    this.#terminal[reservationId] = "refunded";

    await this.#persist({
      inFlight: { ...this.#inFlight },
      terminal: { ...this.#terminal },
    });

    return { status: "refunded", available: this.#available() };
  }

  /**
   * Consume one free-tier unit for keyId on the current UTC day.
   * Does not touch balance / inFlight.
   */
  async consumeFreeTier(
    keyId: string,
    limit: number,
    nowMs: number = Date.now(),
  ): Promise<FreeTierResult> {
    if (!keyId || typeof keyId !== "string") {
      return { status: "rejected", reason: "keyId required" };
    }
    if (!(limit > 0) || !Number.isFinite(limit)) {
      return { status: "rejected", reason: "limit must be > 0" };
    }

    const day = utcDayKey(nowMs);
    const storageKey = freeStorageKey(keyId, day);
    const used = (await this.ctx.storage.get<number>(storageKey)) ?? 0;
    if (used >= limit) {
      return { status: "exhausted", used, limit };
    }

    const next = used + 1;
    await this.ctx.storage.put(storageKey, next);
    return { status: "consumed", used: next, limit };
  }

  /**
   * Enqueue a free-tier usage row (credits 0) for Convex flush.
   * Marks reservation terminal=free for idempotency.
   */
  async enqueueFreeUsage(
    reservationId: string,
    usage: SettlementUsage,
  ): Promise<EnqueueFreeResult> {
    if (!reservationId || typeof reservationId !== "string") {
      return { status: "rejected", reason: "reservationId required" };
    }

    const settlementId = settlementIdFor(reservationId);
    const terminal = this.#terminal[reservationId];
    if (terminal === "free" || terminal === "settled") {
      return { status: "duplicate", settlementId };
    }
    if (terminal === "refunded") {
      return { status: "rejected", reason: "already refunded" };
    }
    if (this.#inFlight[reservationId]) {
      return { status: "rejected", reason: "reservation in flight" };
    }

    const settledAt = Date.now();
    this.#terminal[reservationId] = "free";
    this.#pendingSettlements.push({
      settlementId,
      reservationId,
      cost: 0,
      settledAt,
      usage,
    });

    await this.#persist({
      pendingSettlements: this.#pendingSettlements.map((s) => ({ ...s })),
      terminal: { ...this.#terminal },
    });
    await this.#scheduleFlushAlarm();

    return { status: "enqueued", settlementId };
  }

  async flush(): Promise<FlushResult> {
    this.#flushSeq += 1;
    await this.#persist({ flushSeq: this.#flushSeq });

    return {
      batchId: `batch:${this.#flushSeq}`,
      settlements: this.#pendingSettlements.map((s) => ({ ...s })),
    };
  }

  async ackFlush(settlementIds: string[]): Promise<AckFlushResult> {
    if (!Array.isArray(settlementIds) || settlementIds.length === 0) {
      return { removed: 0, remaining: this.#pendingSettlements.length };
    }

    const toRemove = new Set(settlementIds);
    const before = this.#pendingSettlements.length;
    this.#pendingSettlements = this.#pendingSettlements.filter(
      (s) => !toRemove.has(s.settlementId),
    );
    const removed = before - this.#pendingSettlements.length;

    if (removed > 0) {
      await this.#persist({
        pendingSettlements: this.#pendingSettlements.map((s) => ({ ...s })),
      });
    }

    return { removed, remaining: this.#pendingSettlements.length };
  }

  /**
   * Flush pending settlements that have usage metadata to Convex, then ack.
   * Rows without usage are left for the SimulatedLedger-style test path.
   */
  async flushToConvex(): Promise<FlushToConvexResult> {
    if (this.#pendingSettlements.length === 0) {
      return { flushed: 0, acked: 0, remaining: 0 };
    }

    const flushable = this.#pendingSettlements.filter(
      (s) => s.usage !== undefined,
    );
    if (flushable.length === 0) {
      return {
        flushed: 0,
        acked: 0,
        remaining: this.#pendingSettlements.length,
      };
    }

    const events: ConvexUsageRecord[] = [];
    for (const s of flushable) {
      const usage = s.usage;
      if (!usage) continue;
      events.push(
        pendingToUsageRecord({
          settlementId: s.settlementId,
          cost: s.cost,
          settledAt: s.settledAt,
          organizationId: usage.organizationId,
          projectId: usage.projectId,
          endpoint: usage.endpoint,
          method: usage.method,
          status: usage.status,
          latencyMs: usage.latencyMs,
          keyId: usage.keyId,
        }),
      );
    }

    const client = this.#buildUsageClient();
    if (!client) {
      return {
        flushed: 0,
        acked: 0,
        remaining: this.#pendingSettlements.length,
        error: "convex client not configured",
      };
    }

    const usageResult = await client.recordUsage(events).then(
      (r) => ({ ok: true as const, value: r }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    if (!usageResult.ok) {
      const message =
        usageResult.err instanceof Error
          ? usageResult.err.message
          : String(usageResult.err);
      return {
        flushed: 0,
        acked: 0,
        remaining: this.#pendingSettlements.length,
        error: message,
      };
    }

    const ids = flushable.map((s) => s.settlementId);
    const ack = await this.ackFlush(ids);
    return {
      flushed: events.length,
      acked: ack.removed,
      remaining: ack.remaining,
    };
  }

  #buildUsageClient(): ConvexUsageClient | null {
    // Test hook: module-level mutation override.
    const testFn = getTestUsageMutation();
    if (testFn) {
      return new ConvexUsageClient({
        convexUrl: "https://test.invalid",
        mutationFn: testFn,
      });
    }

    const env = this.env as Cloudflare.Env;
    const url = env.CONVEX_URL;
    if (!url) return null;

    const secret = env.GATEWAY_INTERNAL_SECRET;
    if (secret) {
      const siteBase = (
        env.CONVEX_SITE_URL ?? url.replace(".convex.cloud", ".convex.site")
      ).replace(/\/+$/, "");
      return new ConvexUsageClient({
        convexUrl: url,
        ingestUrl: `${siteBase}/ingest-usage`,
        internalSecret: secret,
      });
    }

    return new ConvexUsageClient({
      convexUrl: url,
      adminKey: env.CONVEX_DEPLOY_KEY,
    });
  }

  async getState(): Promise<WalletState> {
    return this.#snapshot();
  }

  async getFreeTierUsed(
    keyId: string,
    nowMs: number = Date.now(),
  ): Promise<number> {
    const day = utcDayKey(nowMs);
    return (
      (await this.ctx.storage.get<number>(freeStorageKey(keyId, day))) ?? 0
    );
  }

  /**
   * Alarm: batch-flush pending usage to Convex when configured.
   * Re-arms while pending remains.
   */
  async alarm(): Promise<void> {
    if (this.#pendingSettlements.length === 0) return;

    const hasUsage = this.#pendingSettlements.some(
      (s) => s.usage !== undefined,
    );
    if (hasUsage) {
      await this.flushToConvex();
    }

    if (this.#pendingSettlements.length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_ALARM_MS);
    }
  }

  // -------------------------------------------------------------------------
  // HTTP fetch router (also usable from the Worker entrypoint)
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (request.method === "GET" && (path === "/" || path === "/state")) {
        return Response.json(await this.getState());
      }

      if (request.method !== "POST") {
        return Response.json({ error: "method not allowed" }, { status: 405 });
      }

      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      switch (path) {
        case "/grant": {
          const result = await this.grant(
            String(body.grantId ?? ""),
            Number(body.amount),
          );
          return Response.json(result);
        }
        case "/reserve": {
          const result = await this.reserve(
            String(body.reservationId ?? ""),
            Number(body.cost),
          );
          return Response.json(result);
        }
        case "/settle": {
          const result = await this.settle(String(body.reservationId ?? ""));
          return Response.json(result);
        }
        case "/refund": {
          const result = await this.refund(String(body.reservationId ?? ""));
          return Response.json(result);
        }
        case "/flush": {
          return Response.json(await this.flush());
        }
        case "/flushToConvex": {
          return Response.json(await this.flushToConvex());
        }
        case "/ack":
        case "/ackFlush": {
          const ids = Array.isArray(body.settlementIds)
            ? body.settlementIds.filter(
                (id): id is string => typeof id === "string",
              )
            : [];
          return Response.json(await this.ackFlush(ids));
        }
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
  }
}

// ---------------------------------------------------------------------------
// Test hook for DO → Convex flush without network
// ---------------------------------------------------------------------------

type TestUsageMutation = (
  name: string,
  args: { events: ConvexUsageRecord[] },
) => Promise<{
  applied: number;
  skipped: number;
  balances: Record<string, number>;
}>;

let testUsageMutation: TestUsageMutation | null = null;

export function __setTestUsageMutation(fn: TestUsageMutation | null): void {
  testUsageMutation = fn;
}

function getTestUsageMutation(): TestUsageMutation | null {
  return testUsageMutation;
}
