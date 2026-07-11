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
 *
 * Crash-safety: multi-key updates go through storage.transaction. State is
 * loaded in the constructor under blockConcurrencyWhile so concurrent
 * requests never see a half-loaded wallet.
 */

import { DurableObject } from "cloudflare:workers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InFlightEntry = {
  cost: number;
  createdAt: number;
};

export type PendingSettlement = {
  settlementId: string;
  reservationId: string;
  cost: number;
  settledAt: number;
};

/** Terminal outcome of a reservation once it leaves inFlight. */
export type TerminalStatus = "settled" | "refunded";

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
  | { status: "unknown" };

export type RefundResult =
  | { status: "refunded"; available: number }
  | { status: "already_refunded" }
  | { status: "already_settled"; settlementId: string }
  | { status: "unknown" };

export type FlushResult = {
  batchId: string;
  settlements: PendingSettlement[];
};

export type AckFlushResult = {
  removed: number;
  remaining: number;
};

// Storage keys
const K_BALANCE = "balance";
const K_IN_FLIGHT = "inFlight";
const K_APPLIED_GRANTS = "appliedGrantIds";
const K_PENDING = "pendingSettlements";
const K_TERMINAL = "terminalReservations";
const K_FLUSH_SEQ = "flushSeq";

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

// ---------------------------------------------------------------------------
// WalletDO
// ---------------------------------------------------------------------------

export class WalletDO extends DurableObject {
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
      number | Record<string, InFlightEntry> | string[] | PendingSettlement[] | Record<string, TerminalStatus>
    >([K_BALANCE, K_IN_FLIGHT, K_APPLIED_GRANTS, K_PENDING, K_TERMINAL, K_FLUSH_SEQ]);

    this.#balance = (stored.get(K_BALANCE) as number | undefined) ?? 0;
    this.#inFlight =
      (stored.get(K_IN_FLIGHT) as Record<string, InFlightEntry> | undefined) ?? {};
    const grants = (stored.get(K_APPLIED_GRANTS) as string[] | undefined) ?? [];
    this.#appliedGrantIds = new Set(grants);
    this.#pendingSettlements =
      (stored.get(K_PENDING) as PendingSettlement[] | undefined) ?? [];
    this.#terminal =
      (stored.get(K_TERMINAL) as Record<string, TerminalStatus> | undefined) ?? {};
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
      if (keys.inFlight !== undefined) await txn.put(K_IN_FLIGHT, keys.inFlight);
      if (keys.appliedGrantIds !== undefined)
        await txn.put(K_APPLIED_GRANTS, keys.appliedGrantIds);
      if (keys.pendingSettlements !== undefined)
        await txn.put(K_PENDING, keys.pendingSettlements);
      if (keys.terminal !== undefined) await txn.put(K_TERMINAL, keys.terminal);
      if (keys.flushSeq !== undefined) await txn.put(K_FLUSH_SEQ, keys.flushSeq);
    });
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

    // Already terminal — treat same cost as no-op-ish conflict surface; reject re-reserve.
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

  async settle(reservationId: string): Promise<SettleResult> {
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

    const entry = this.#inFlight[reservationId];
    if (!entry) {
      return { status: "unknown" };
    }

    const settlementId = settlementIdFor(reservationId);
    const settledAt = Date.now();
    const { cost } = entry;

    // Atomic: remove hold, debit balance, enqueue settlement, mark terminal.
    delete this.#inFlight[reservationId];
    this.#balance -= cost;
    this.#terminal[reservationId] = "settled";
    this.#pendingSettlements.push({
      settlementId,
      reservationId,
      cost,
      settledAt,
    });

    await this.#persist({
      balance: this.#balance,
      inFlight: { ...this.#inFlight },
      pendingSettlements: this.#pendingSettlements.map((s) => ({ ...s })),
      terminal: { ...this.#terminal },
    });

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

    const entry = this.#inFlight[reservationId];
    if (!entry) {
      return { status: "unknown" };
    }

    // Remove hold only — balance unchanged, credit returns to available.
    delete this.#inFlight[reservationId];
    this.#terminal[reservationId] = "refunded";

    await this.#persist({
      inFlight: { ...this.#inFlight },
      terminal: { ...this.#terminal },
    });

    return { status: "refunded", available: this.#available() };
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

  async getState(): Promise<WalletState> {
    return this.#snapshot();
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
        case "/ack":
        case "/ackFlush": {
          const ids = Array.isArray(body.settlementIds)
            ? (body.settlementIds as string[])
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
